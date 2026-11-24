/**
 * **问数的只读工具集**（P3-B）。
 *
 * 为什么要工具：一句话问数往往需要模型自己决定「还差哪份数据」——例如用户问「发票为什么开得少」，
 * 意图只解析出合同与结算，模型需要再取一次发票与状态码口径才能答。
 *
 * 三个硬约束（本仓 AI 立场的延续，不是保守）：
 * 1. **只读**：工具集里没有任何写接口，也不接受任意 SQL / 任意 REST 路径；
 * 2. **数字仍由程序算**：`query_dataset` 走 `DatasetCollector`（与报告/问数同一份实现），
 *    模型只拿到渲染好的文本，不拿到可计算的原始行；
 * 3. **工具结果要参与对账**：调用方必须把工具返回文本里的数字并入「允许数字」集合，
 *    否则模型复述工具结果会被误判成编造（见 `buildChatAnswer(..., extraNumbers)`）。
 */
import type { ChatToolDef } from '../../ai-core/llm-client.ts';
import { renderContextDoc } from '../context-catalog.ts';

export const CHAT_TOOL_NAMES = ['read_context', 'query_dataset'] as const;
export type ChatToolName = (typeof CHAT_TOOL_NAMES)[number];

export const CHAT_TOOLS: ChatToolDef[] = [
  {
    type: 'function',
    function: {
      name: 'read_context',
      description:
        '读取本系统的口径文档（只读文本）：statuses=状态码与「不计入统计的状态」、' +
        'procurement-flow=采购阶段链、metrics=金额指标口径。回答涉及状态含义或金额口径时先读它。',
      parameters: {
        type: 'object',
        properties: {
          doc: {
            type: 'string',
            enum: ['statuses', 'procurement-flow', 'metrics'],
            description: '要读的口径文档',
          },
        },
        required: ['doc'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'query_dataset',
      description:
        '按注册表 key 取一份数据集（与报告同一套程序计算口径，范围/期间沿用本次询问）。' +
        '只在初始事实清单不足以回答时使用；返回的是已格式化文本，不要据此自行计算。',
      parameters: {
        type: 'object',
        properties: {
          datasetKey: { type: 'string', description: '数据集 key，如 invoice.records / payment.records / contract.summary' },
        },
        required: ['datasetKey'],
      },
    },
  },
];

export interface ChatToolContext {
  /** 本次已采集的数据集 key（告诉模型「哪些已经有了」，减少重复取数） */
  availableDatasets: readonly string[];
  /** 重新取一类数据：由服务层注入（工具层不依赖 collector，便于单测） */
  collectDataset: (datasetKey: string) => Promise<{ text: string; rowCount: number } | null>;
}

export interface ChatToolResult {
  ok: boolean;
  /** 给人看的一行摘要（SSE 事件与留痕用） */
  label: string;
  /** 交给模型的正文；**其中的数字会被并入对账白名单** */
  text: string;
}

function parseArgs(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(String(raw || '{}'));
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/**
 * 执行一次工具调用。**未知工具不抛错**，而是回一段说明——
 * 让模型自己纠正（换工具/换参数），别把整轮对话打成 500。
 */
export async function executeChatTool(
  name: string,
  rawArgs: string,
  ctx: ChatToolContext,
): Promise<ChatToolResult> {
  const args = parseArgs(rawArgs);

  if (name === 'read_context') {
    const doc = String(args.doc ?? '');
    try {
      const rendered = renderContextDoc(doc);
      return { ok: true, label: `口径文档：${rendered.title}`, text: rendered.markdown };
    } catch {
      return {
        ok: false,
        label: `未知口径文档：${doc}`,
        text: `没有名为 ${doc} 的口径文档；可用：statuses、procurement-flow、metrics。请换参数重试。`,
      };
    }
  }

  if (name === 'query_dataset') {
    const key = String(args.datasetKey ?? '').trim();
    if (!key) {
      return { ok: false, label: 'query_dataset 缺少 datasetKey', text: '请提供 datasetKey 后重试。' };
    }
    const got = await ctx.collectDataset(key);
    if (!got) {
      return {
        ok: false,
        label: `数据集不可用：${key}`,
        text:
          `数据集 ${key} 不存在、未实现或当前账号无权读取。已有可用：${ctx.availableDatasets.join('、')}。` +
          '请改用已有数据集，或直接说明系统不包含该信息。',
      };
    }
    return { ok: true, label: `数据集：${key}（${got.rowCount} 行）`, text: got.text };
  }

  return {
    ok: false,
    label: `未知工具：${name}`,
    text: `没有名为 ${name} 的工具；可用：${CHAT_TOOL_NAMES.join('、')}。请重试。`,
  };
}
