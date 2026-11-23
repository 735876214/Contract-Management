/**
 * 「项目基本情况」变量取值（项目名称 / 简称 / 承接单位 / 所在省市 / 工程地点 / 项目地址 / 物资产地）。
 *
 * 为什么有这一份：采购 6 个单据模块（公告 / 文件 / 成交报告 / 价格对比表 / 采前会纪要 / 事前说明）
 * 各自抄了一遍同样的 7 行映射，改字段名（或改成从项目表取新字段）时要改 6 处，漏一处就出现
 * "同一批文档里有的单据显示项目简称、有的空着"。变量名本身的权威定义在
 * `web/src/constants/procurementVariables.ts`，这里只负责"从上下文对象取值"这一步。
 */
export interface ProjectVarContext {
  projectName?: string | null;
  projectAbbr?: string | null;
  undertaker?: string | null;
  provinceCity?: string | null;
  siteLocation?: string | null;
  projectAddress?: string | null;
  materialOrigin?: string | null;
}

export function projectVars(ctx: ProjectVarContext = {}): Record<string, string> {
  return {
    项目名称: ctx.projectName ?? '',
    项目简称: ctx.projectAbbr ?? '',
    承接单位: ctx.undertaker ?? '',
    项目所在省市: ctx.provinceCity ?? '',
    工程地点: ctx.siteLocation ?? '',
    项目地址: ctx.projectAddress ?? '',
    物资产地: ctx.materialOrigin ?? '',
  };
}
