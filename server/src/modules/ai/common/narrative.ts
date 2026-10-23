/**
 * AI 预警 · **措辞层通用原语（跨课题共用）**。
 *
 * 原属 `ai/anomaly/anomaly-prompt.ts`（课题 6-9）；M4（课题 3-9）复用同一套「数字对账」，
 * 故上提到 `ai/common/`。语义一处维护，`anomaly-prompt.ts` 保持原有导出名（薄包装），
 * 既有调用方与单测都不受影响。
 *
 * 红线：模型只组织语言，**不参与判定、不参与算术**。命中与否由规则层纯函数决定，
 * 数字由 `facts` 决定；模型输出里出现 facts 之外的数字 → 视为对账失败，调用方丢弃结论。
 * 这套思路与 `report.service.ts` 的 `unknownNumbers` 一致。
 */

/** 一段结论 + 若干动作（两个课题共用同一形状） */
export interface Narrative {
  /** 总体结论 */
  conclusion: string;
  /** 建议动作 */
  actions: string[];
}

/**
 * 可对账的最小命中形状。
 *
 * `facts` 允许两种形态：结算/付款预警用 `Record<string, string>`（键值都要放行，
 * 键里可能带「第2轮报价」这类数字），报价预警用 `string[]`（已格式化的一行行事实）。
 */
export interface NarratableFinding {
  /** 标题（通常含单据编号与金额，编号里的数字也是合法引用） */
  title?: string | null;
  /** 差额（已格式化的元字符串，如 `1.01`） */
  amountDiff?: string | null;
  facts?: Record<string, unknown> | string[] | null;
}

/** 数字归一：去千分位、去尾部 0，`100` 与 `100.00` 视为同一个数 */
export function normalizeNumberToken(raw: string): string {
  const n = Number(String(raw).replace(/,/g, ''));
  if (!Number.isFinite(n)) return String(raw);
  return String(Number(n.toFixed(4)));
}

/**
 * 数字正则：负号只在「前面不是字母数字」时才算符号。
 *
 * 否则单据编号 `HT-2026-001` 会被抽成 `-2026`，与 facts 里的 `2026` 对不上，
 * 结果就是「模型老老实实抄了单据编号，系统却判定它编数字」——这类误报比漏报更伤。
 */
const NUMBER_RE = /(?<![\dA-Za-z])-?\d+(?:,\d{3})*(?:\.\d+)?/g;

/** 允许模型无条件使用的计数词（提示词铁律里明确放行 0~10） */
const COUNT_WORDS = ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9', '10'];

/** 从文本里抽出所有数字（归一后），用于对账 */
export function extractNumbers(text: string): string[] {
  const out: string[] = [];
  for (const m of String(text ?? '').matchAll(NUMBER_RE)) out.push(normalizeNumberToken(m[0]));
  return out;
}

/**
 * 允许模型引用的数字全集：`facts` 的键与值、标题、差额。
 *
 * 用 `Set` 而不是数组：命中几十条时是 O(1) 查找。
 */
export function collectFindingNumbers(findings: NarratableFinding[]): Set<string> {
  const set = new Set<string>();
  const push = (text: unknown) => {
    if (text == null) return;
    for (const n of extractNumbers(String(text))) set.add(n);
  };
  for (const f of findings ?? []) {
    push(f.title);
    push(f.amountDiff);
    const facts = f.facts;
    if (Array.isArray(facts)) {
      for (const v of facts) push(v);
    } else if (facts && typeof facts === 'object') {
      for (const [k, v] of Object.entries(facts)) {
        push(v);
        push(k);
      }
    }
  }
  return set;
}

/**
 * 对账：措辞里出现的数字，必须全部能在 `facts` 里找到（或属于放行的计数词）。
 *
 * 为什么这条比「提示词里写不许编数字」管用：模型对「不要编」的遵守率大概 90%，
 * 但财务场景 10% 的编造就是事故。这里把「编没编」变成可判定的集合差，空集才放行。
 *
 * @returns 未知数字列表（空数组=通过）
 */
export function auditNarrativeNumbers(narrative: Narrative, findings: NarratableFinding[]): string[] {
  const allowed = collectFindingNumbers(findings);
  const unknown: string[] = [];
  const seen = new Set<string>();
  for (const text of [narrative?.conclusion, ...(narrative?.actions ?? [])]) {
    for (const n of extractNumbers(String(text ?? ''))) {
      if (allowed.has(n)) continue;
      if (COUNT_WORDS.includes(n)) continue;
      if (seen.has(n)) continue;
      seen.add(n);
      unknown.push(n);
    }
  }
  return unknown;
}

/** 面板要显示的「基于多少条数据算的」统一渲染：`{ 合同: 3, 结算单: 4 }` → `合同 3，结算单 4` */
export function sampleText(sample: Record<string, number> | null | undefined): string {
  const entries = Object.entries(sample ?? {});
  if (!entries.length) return '（无）';
  return entries.map(([k, v]) => `${k} ${v}`).join('，');
}
