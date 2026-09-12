import type { VarGroup, VarItem } from '@/pages/Clauses';

/**
 * 采购模块变量占位符系统（批次一 · 任务 1.3）
 *
 * 命名规则：
 * 1. 公共变量（项目信息）无前缀，如 {{项目名称}}
 * 2. 模块专属重名变量使用「模块名-变量名」前缀，如 {{采购公告-采购清单}}
 * 3. 表格变量统一为 {{模块名-表格名}}，生成 Word 时替换为真实表格
 */

/** 采购模块类型（与菜单、模板管理、后端 moduleType 一致） */
export const PROCUREMENT_MODULES = [
  { value: 'INITIATE', label: '采购发起' },
  { value: 'PRE_MEETING', label: '采前会会议纪要' },
  { value: 'NOTICE', label: '采购公告' },
  { value: 'DOCUMENT', label: '采购文件' },
  { value: 'RESULT_REPORT', label: '成交报告' },
  { value: 'PRICE_COMPARE', label: '采购价格对比表' },
  { value: 'FRAMEWORK', label: '框架协议事前说明' },
  { value: 'INSPECTION', label: '考察报告' },
] as const;

export type ProcurementModuleType = (typeof PROCUREMENT_MODULES)[number]['value'];

export const procurementModuleLabel = (code: string): string =>
  PROCUREMENT_MODULES.find((m) => m.value === code)?.label ?? code;

export interface ProcurementVar {
  /** 变量名（不含双花括号），如「采购公告-采购清单」 */
  key: string;
  /** 说明（面板提示） */
  tip?: string;
  /** 表格变量：生成 Word 时替换为真实表格 */
  table?: boolean;
  /** HTML 变量（富文本内容）：生成 Word 时按 HTML 原样注入，不做转义 */
  html?: boolean;
}

const v = (key: string, tip?: string, table = false): ProcurementVar => ({ key, tip, table });
/** 富文本内容变量（值本身是 HTML） */
const h = (key: string, tip?: string): ProcurementVar => ({ key, tip, html: true });

/** 公共变量（项目信息，所有采购模块可用，无前缀） */
export const PROCUREMENT_COMMON_VARS: ProcurementVar[] = [
  v('项目名称'),
  v('项目简称'),
  v('承接单位'),
  v('项目所在省市', '来源：项目管理 · 项目信息'),
  v('工程地点', '来源：项目管理 · 项目信息'),
  v('项目地址', '来源：项目管理 · 项目信息'),
];

/** 模块专属变量（带模块前缀区分重名） */
export const PROCUREMENT_MODULE_VARS: Record<ProcurementModuleType, ProcurementVar[]> = {
  INITIATE: [
    v('采购编号'),
    v('采购内容'),
    v('采购类型'),
  ],
  PRE_MEETING: [
    v('采前会-采购清单', '表格变量：替换为采购清单表格（序号/物资名称/规格型号/计量单位/暂定数量）', true),
    v('采前会-采购成本分析表', '表格变量：替换为采购成本分析表（含清单收入/预计采购成本/预计效益额/效益率及合计）', true),
    v('采购内容'),
    v('预计采购金额', '预计采购金额（万元，保留 2 位小数）'),
    v('会议时间'),
    v('主持人'),
    v('参会人员'),
    v('编写人'),
    v('审核人'),
    h('技术质量要求', '富文本内容，按 HTML 原样注入'),
    h('验收标准', '富文本内容，按 HTML 原样注入'),
    h('付款条件', '富文本内容，按 HTML 原样注入'),
  ],
  NOTICE: [
    v('采购公告-采购清单', '表格变量：替换为采购清单表格（序号/物资名称/规格型号/计量单位/暂定数量/备注）', true),
    v('采购编号', '采购编号（文本）'),
    v('采购时间', '采购时间（日期）'),
    v('采购内容', '采购内容（文本，默认带出采购任务内容）'),
    h('技术质量标准', '富文本内容，按 HTML 原样注入'),
    h('验收方式', '富文本内容，按 HTML 原样注入'),
    h('付款方式', '富文本内容，按 HTML 原样注入'),
    v('联系人1', '联系人按位置自动编号，支持多个（联系人1、联系人2…）'),
    v('联系电话1', '联系电话按位置自动编号，支持多个（联系电话1、联系电话2…）'),
    v('联系人2'),
    v('联系电话2'),
  ],
  DOCUMENT: [
    v(
      '采购文件-采购清单',
      '表格变量：替换为采购清单表格（序号/物资名称/规格型号/计量单位/暂定数量/税前单价/税率/综合单价/合价/备注；价格列留空待投标方填写）',
      true,
    ),
    // 以下来源「采购公告」
    v('采购编号', '来源采购公告'),
    v('采购内容', '来源采购公告'),
    h('技术质量标准', '来源采购公告，富文本按 HTML 原样注入'),
    h('验收方式', '来源采购公告，富文本按 HTML 原样注入'),
    h('付款方式', '来源采购公告，富文本按 HTML 原样注入'),
    // 以下为本模块字段
    v('采购时间', '采购文件中的采购时间（日期）'),
    v('响应保证金', '响应保证金（金额，元）'),
    h('报价说明', '报价说明（富文本，按 HTML 原样注入）'),
  ],
  RESULT_REPORT: [
    v('成交单位数量'),
    v('采购开启时间'),
    v('开启地点'),
    v('评审小组成员'),
    v('审核通过响应单位数量'),
    v('参与响应单位数量'),
    v('弃权响应单位数量'),
    v('有效响应文件数量'),
    v('预计采购金额', '来自总采购清单（Σ 控制价 × 暂定数量）'),
    v(
      '成交报告-响应单位情况汇总表',
      '表格变量：序号 | 参与响应单位 | 响应保证金是否缴纳 | 响应文件密封是否完整 | 备注',
      true,
    ),
    v(
      '成交报告-开启报价情况表',
      '表格变量：排名 | 参与响应单位 | 第一次报价不含税总额 | 预计采购金额 | 第一轮报价税金（按第一轮报价不含税总额升序）',
      true,
    ),
    v(
      '成交报告-第二轮报价情况表',
      '表格变量：排名 | 参与响应单位 | 第二次报价不含税总额 | 预计采购金额 | 第二轮报价税金（仅「通过第一轮报价=是」，按第二轮报价不含税总额升序）',
      true,
    ),
    v(
      '成交报告-拟推荐成交候选人表',
      '表格变量：序号 | 拟推荐成交候选人 | 最终确认不含税价格 | 备注（在第二轮报价表勾选生成）',
      true,
    ),
  ],
  PRICE_COMPARE: [
    v('采购内容'),
    v('计价方式', '固定价 / 浮动价（来源：本模块编辑字段）'),
    v(
      '采购价格对比表-明细表',
      '表格变量：序号 | 采购名称 | 规格型号 | 单位 | 数量 | 清单收入（不含税单价/不含税合价）| 标准成本（不含税单价/不含税合价）| 控制价（不含税单价）| 信息价（不含税单价/不含税合价）| 成交价（不含税单价/不含税合价）| 采购成本降低率 | 采购成交价下浮率 | 信息价下浮率 | 备注；表底含清单收入总金额/标准成本总金额/采购效益率/采购成本降低率',
      true,
    ),
  ],
  FRAMEWORK: [
    v('采购内容'),
    v('事前说明-询价情况', '表格变量：替换为询价情况表（排名/单位/总价/含税/类型）', true),
    v('事前说明-价格对比表', '表格变量：替换为同城/相邻城市局其他单位执行合同价对比表', true),
    v('事前说明-成本分析表', '表格变量：替换为成本分析表', true),
  ],
  INSPECTION: [
    h('考察报告-考察内容', '考察内容（富文本，按 HTML 原样注入）'),
    h('考察报告-考察结论', '考察结论（富文本，按 HTML 原样注入）'),
  ],
};

/** 某模块的完整变量集合 = 公共变量 + 模块专属变量 */
export function getProcurementVars(moduleType: string): ProcurementVar[] {
  const own = PROCUREMENT_MODULE_VARS[moduleType as ProcurementModuleType] ?? [];
  return [...PROCUREMENT_COMMON_VARS, ...own];
}

/** 供 RichTextEditor「插入变量」面板使用的分组（只显示当前模块相关变量） */
export function getProcurementVariableGroups(moduleType: string): VarGroup[] {
  const groups: VarGroup[] = [
    {
      label: '公共变量（项目信息）',
      items: PROCUREMENT_COMMON_VARS.map((x) => toVarItem(x)),
    },
  ];
  const own = PROCUREMENT_MODULE_VARS[moduleType as ProcurementModuleType] ?? [];
  if (own.length) {
    groups.push({
      label: `${procurementModuleLabel(moduleType)} · 模块专属`,
      items: own.map((x) => toVarItem(x)),
    });
  }
  return groups;
}

function toVarItem(x: ProcurementVar): VarItem {
  // 采购变量统一使用双花括号占位符 {{变量名}}
  return { key: x.key, raw: `{{${x.key}}}`, tip: x.tip };
}

/** 从富文本中提取使用到的变量名（不含花括号） */
export function extractProcurementVariables(html: string): string[] {
  const found = new Set<string>();
  const re = /\{\{([^{}]+)\}\}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html || '')) !== null) found.add(m[1].trim());
  return [...found];
}

/**
 * 变量查找替换：将 {{变量名}} 替换为给定值。
 * - 普通变量：替换为文本（HTML 转义）
 * - 表格变量 / HTML 变量（table: true / html: true）：值即为 HTML，直接注入
 * - 未提供值的变量：保留原占位符（便于预览时发现缺失）
 */
export function replaceProcurementVariables(
  html: string,
  values: Record<string, string>,
  moduleType?: string,
): string {
  let out = html || '';
  const vars = getProcurementVars(moduleType ?? '');
  const rawSet = new Set(vars.filter((x) => x.table || x.html).map((x) => x.key));
  const esc = (s: string): string =>
    s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  for (const [key, val] of Object.entries(values ?? {})) {
    if (val == null) continue;
    const token = `{{${key}}}`;
    if (!out.includes(token)) continue;
    out = out.split(token).join(rawSet.has(key) ? String(val) : esc(String(val)));
  }
  return out;
}
