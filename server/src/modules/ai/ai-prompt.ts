/**
 * AI prompt 构造与模型输出规整（**零运行时依赖**：只 import 同目录的纯模块）。
 *
 * 安全底线（写死在测试里，见 `server/test/aiPrompt.spec.mts`）：
 * **prompt 里只出现「字段标签 + 键」和「表单上的标签文本」，绝不出现任何字段值。**
 * 表单已填的值（`FormCandidate.currentValue`）留给服务端自己做"覆盖确认"，
 * 不送到上游 —— 一份报销单/合同扫描件里的账号、金额没必要为了"猜对应关系"而离开服务器。
 *
 * 输出契约（要求模型返回 JSON 对象）：
 * ```json
 * { "mapping": [{ "candidate": 3, "field": "contract.code", "confidence": 0.92 }] }
 * ```
 * `candidate` 是我们给的候选序号（不是单元格坐标），这样模型不可能凭空造出一个越界位置；
 * 服务端再按序号回填坐标，并逐条丢弃非法项（未知键/越界序号/重复序号）。
 */

import { AI_FIELD_CATALOG, type AiFieldDef } from './field-catalog.ts';
import type { LlmMessage } from './llm-client.ts';
import type { FormCandidate } from './form-scan.ts';

export const FORM_SYSTEM_PROMPT = [
  '你是建筑工程合同管理系统的填表助手。',
  '任务：判断上传表格里每个待填项（candidate）应该用系统提供的哪个字段来填充。',
  '规则：',
  '1. 只能从给定字段列表里选，用字段的 key（如 contract.code）；不确定就省略该 candidate。',
  '2. 严格按语义匹配。差一个字也要放弃：例如"审核金额"不等于"合同金额"，"计划开工日期"不等于"开工日期"时 prioritize 精确语义。',
  '3. 表格里的表头/表名/合计行不是待填项，不要硬凑。',
  '4. confidence 取 0~1，表示你有多确定；低于 0.6 的宁可不填。',
  '5. 只输出 JSON，格式：{"mapping":[{"candidate":序号,"field":"字段key","confidence":0.9}]}',
].join('\n');

/** 单条候选送进 prompt 的形状（**不含 currentValue**） */
export interface PromptCandidate {
  index: number;
  sheet: string;
  label: string;
}

export interface MappingSuggestion {
  /** 候选序号（回指 `PromptCandidate.index`） */
  candidateIndex: number;
  /** 目录内的字段键 */
  fieldKey: string;
  fieldLabel: string;
  /** 0~1 */
  confidence: number;
}

/** 把候选压成 prompt 条目：序号从 1 起（模型对 1 基序号更稳），并丢弃空标签 */
export function promptCandidates(candidates: readonly FormCandidate[]): PromptCandidate[] {
  return candidates
    .map((c, i) => ({ index: i + 1, sheet: c.sheet, label: String(c.label ?? '').trim() }))
    .filter((c) => c.label.length > 0);
}

/**
 * 字段清单文本：`key | label（类型, 同义: …）`。
 * 超过 `maxFields` 时按顺序截断 —— 目录是人工维护的短清单（<60 项），截断在正常配置下不会触发；
 * 保留该参数是为了防止有人把整个数据模型塞进目录导致 prompt 爆掉。
 */
export function fieldListText(fields: readonly AiFieldDef[], maxFields: number): string {
  const limit = Math.max(1, Math.floor(Number(maxFields) || 1));
  return fields
    .slice(0, limit)
    .map((f) => {
      const extra = f.aliases?.length ? `，同义：${f.aliases.join('/')}` : '';
      return `- ${f.key} | ${f.label}（${f.type}${extra}）`;
    })
    .join('\n');
}

/** 候选清单文本：`#序号 [工作表] 标签` */
export function candidateListText(candidates: readonly PromptCandidate[], maxCandidates: number): string {
  const limit = Math.max(1, Math.floor(Number(maxCandidates) || 1));
  return candidates
    .slice(0, limit)
    .map((c) => `#${c.index} [${c.sheet}] ${c.label}`)
    .join('\n');
}

/**
 * 构造映射请求消息。
 *
 * ⚠️ 传参只接受 `FormCandidate`（其 `currentValue` 字段被**显式忽略**）与字段目录；
 * 不要为了"帮模型判断"把值拼进来 —— 那等于把业务数据发给第三方。
 */
export function buildFormMappingMessages(input: {
  fields: readonly AiFieldDef[];
  candidates: readonly FormCandidate[];
  maxFields: number;
  maxCandidates: number;
  /** 额外口径提示（例如"本次未关联合同，别用合同域字段"）。只放规则，不放任何数据值 */
  note?: string;
}): LlmMessage[] {
  const cands = promptCandidates(input.candidates);
  const user = [
    '【系统可用字段】',
    fieldListText(input.fields, input.maxFields),
    '',
    '【上传表格的待填项】',
    candidateListText(cands, input.maxCandidates),
    '',
    ...(input.note ? ['【补充口径】', input.note, ''] : []),
    '请输出 JSON：{"mapping":[...]}。',
  ].join('\n');
  return [
    { role: 'system', content: FORM_SYSTEM_PROMPT },
    { role: 'user', content: user },
  ];
}

const clamp01 = (n: number): number => (n < 0 ? 0 : n > 1 ? 1 : n);

/**
 * 规整模型输出：
 * - 接受 `{mapping:[...]}` 或裸数组（模型偶尔会直接给数组）；
 * - 逐条校验 `candidate` 在 1..n 内、`field` 在目录内；
 * - **同一 candidate 只保留置信度最高的一条**，同一 fieldKey **只保留一次**
 *   （一个字段同时映射到两格会造成"两格填同一个值"，几乎总是模型在硬凑）；
 * - confidence 缺省 0、夹到 [0,1]，四舍五入到 3 位。
 */
export function normalizeMapping(raw: unknown, candidateCount: number): MappingSuggestion[] {
  const list: unknown[] = Array.isArray(raw)
    ? raw
    : Array.isArray((raw as any)?.mapping)
      ? (raw as any).mapping
      : [];
  const total = Math.max(0, Math.floor(Number(candidateCount) || 0));
  const byField = new Map<string, MappingSuggestion>();
  const byCandidate = new Map<number, MappingSuggestion>();

  for (const item of list) {
    if (!item || typeof item !== 'object') continue;
    const o = item as Record<string, unknown>;
    const idx = Number(o.candidate ?? o.index ?? 0);
    const fieldKey = String(o.field ?? o.fieldKey ?? '').trim();
    const def = AI_FIELD_CATALOG.find((f) => f.key === fieldKey);
    if (!Number.isInteger(idx) || idx < 1 || idx > total) continue;
    if (!def) continue;
    const conf = clamp01(Number(o.confidence ?? 0) || 0);
    const suggestion: MappingSuggestion = {
      candidateIndex: idx,
      fieldKey: def.key,
      fieldLabel: def.label,
      confidence: Math.round(conf * 1000) / 1000,
    };

    const prevCand = byCandidate.get(idx);
    if (!prevCand || suggestion.confidence > prevCand.confidence) byCandidate.set(idx, suggestion);

    const prevField = byField.get(def.key);
    if (!prevField || suggestion.confidence > prevField.confidence) byField.set(def.key, suggestion);
  }

  // 两个索引都要满足：候选不重复、字段不重复
  const keepByCandidate = new Set([...byCandidate.values()].map((s) => s.candidateIndex));
  const keepByField = new Set([...byField.values()].map((s) => s.fieldKey));
  const final = [...byCandidate.values()].filter(
    (s) => keepByField.has(s.fieldKey) && keepByCandidate.has(s.candidateIndex),
  );
  // 交叉过滤后可能出现"字段被另一条候选顶掉"，再收敛一次（幂等，最多两轮）
  const usedFields = new Set<string>();
  const result: MappingSuggestion[] = [];
  for (const s of final.sort((a, b) => b.confidence - a.confidence)) {
    if (usedFields.has(s.fieldKey)) continue;
    usedFields.add(s.fieldKey);
    result.push(s);
  }
  return result.sort((a, b) => a.candidateIndex - b.candidateIndex);
}
