import type { ReportKind } from './report-facts';

/**
 * 汇报材料的**公文骨架**（零依赖）。
 *
 * 为什么要有模板：同样的事实清单，模型每次起的节标题都不一样（「经营概况」/「基本情况」/
 * 「整体情况」），发给领导的两份材料对不上，看着就不像一家公司的东西。
 * 这里把节标题固定下来，prompt 只允许按这棵树填内容，前端也照着这棵树展示。
 */
export interface ReportSection {
  /** 节标题，原样进入 Markdown 的 `## `（含中文序号，避免模型自己编号） */
  title: string;
  /** 这一节该写什么（进 prompt，不给用户看） */
  hint: string;
}

export interface ReportTemplate {
  /** 节标题与每节写法（材料名称与写作提示统一取自 `REPORT_KINDS`，不在这里重复） */
  sections: ReportSection[];
}

export const REPORT_TEMPLATES: Record<ReportKind, ReportTemplate> = {
  monthly: {
    sections: [
      { title: '一、经营概况', hint: '本期一句话结论 + 合同/结算/付款/开票/日报的关键数字，不要逐项罗列清单。' },
      { title: '二、合同情况', hint: '合同总数与执行中数量、累计与区间新签金额、合同结构是否单一。' },
      { title: '三、结算与收付款', hint: '区间与累计的结算、付款、开票金额，应付未付及其含义；金额为 0 要说明是「还没开始」而不是「已付清」。' },
      { title: '四、风险与下阶段建议', hint: '先列风险（用给定的事实，不要推测），再给 3~4 条可执行建议。' },
    ],
  },
  project: {
    sections: [
      { title: '一、项目概况', hint: '项目名称/编号/负责人/计划工期，以及当前所处的履约阶段。' },
      { title: '二、合同与执行', hint: '合同数量、金额、执行状态分布，重点说明执行中的合同进展。' },
      { title: '三、履约过程记录', hint: '日报数量与连续性——记录能否支撑履约判断；不足要说清缺什么。' },
      { title: '四、结算与资金', hint: '结算、开票、付款的进度与缺口，应付未付的含义。' },
      { title: '五、风险与下阶段建议', hint: '风险来自给定事实；建议要具体到动作与责任环节。' },
    ],
  },
  brief: {
    sections: [
      { title: '一、总体结论', hint: '两三句话讲清本期是什么状态、最大问题是什么。' },
      { title: '二、关键数据', hint: '只列最重要的数字（合同金额、区间发生额、应付未付），用无序列表。' },
      { title: '三、风险提示', hint: '2~3 条最重要的风险，每条一句话。' },
      { title: '四、下阶段建议', hint: '2~3 条，动词开头，不写空话。' },
    ],
  },
};

/** 模板的节标题清单（prompt 与前端共用，保证两边一致） */
export function templateSections(kind: ReportKind): string[] {
  return (REPORT_TEMPLATES[kind] ?? REPORT_TEMPLATES.monthly).sections.map((s) => s.title);
}

/** 渲染进 prompt 的骨架说明 */
export function templatePromptText(kind: ReportKind): string {
  const tpl = REPORT_TEMPLATES[kind] ?? REPORT_TEMPLATES.monthly;
  return tpl.sections.map((s) => `## ${s.title}\n   ${s.hint}`).join('\n');
}
