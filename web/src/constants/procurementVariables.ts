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
}

const v = (key: string, tip?: string, table = false): ProcurementVar => ({ key, tip, table });

/** 公共变量（项目信息，所有采购模块可用，无前缀） */
export const PROCUREMENT_COMMON_VARS: ProcurementVar[] = [
  v('项目名称'),
  v('项目简称'),
  v('承接单位'),
  v('工程地点'),
  v('项目地址'),
];

/** 模块专属变量（带模块前缀区分重名） */
export const PROCUREMENT_MODULE_VARS: Record<ProcurementModuleType, ProcurementVar[]> = {
  INITIATE: [
    v('采购编号'),
    v('采购内容'),
    v('采购类型'),
  ],
  PRE_MEETING: [
    v('采前会-采购清单', '表格变量：替换为采购清单表格', true),
    v('采前会-采购成本分析表', '表格变量：替换为采购成本分析表', true),
    v('会议时间'),
    v('主持人'),
    v('参会人员'),
    v('编写人'),
    v('审核人'),
    v('技术质量要求'),
    v('验收标准'),
    v('付款条件'),
  ],
  NOTICE: [
    v('采购公告-采购清单', '表格变量：替换为采购清单表格', true),
    v('采购时间'),
    v('技术质量标准'),
    v('验收方式'),
    v('付款方式'),
    v('联系人1'),
    v('联系电话1'),
    v('联系人2'),
    v('联系电话2'),
  ],
  DOCUMENT: [
    v('采购文件-采购清单', '表格变量：替换为采购清单表格', true),
    v('响应保证金'),
    v('报价说明'),
  ],
  RESULT_REPORT: [
    v('成交单位数量'),
    v('采购开启时间'),
    v('开启地点'),
    v('评审小组成员'),
    v('预计采购金额'),
    v('成交报告-响应单位情况汇总表', '表格变量：替换为响应单位情况汇总表', true),
    v('成交报告-开启报价情况表', '表格变量：替换为开启报价情况表', true),
    v('成交报告-第二轮报价情况表', '表格变量：替换为第二轮报价情况表', true),
    v('成交报告-拟推荐成交候选人表', '表格变量：替换为拟推荐成交候选人表', true),
  ],
  PRICE_COMPARE: [],
  FRAMEWORK: [],
  INSPECTION: [],
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
 * - 表格变量（table: true）：值即为表格 HTML，直接注入
 * - 未提供值的变量：保留原占位符（便于预览时发现缺失）
 */
export function replaceProcurementVariables(
  html: string,
  values: Record<string, string>,
  moduleType?: string,
): string {
  let out = html || '';
  const vars = getProcurementVars(moduleType ?? '');
  const tableSet = new Set(vars.filter((x) => x.table).map((x) => x.key));
  const esc = (s: string): string =>
    s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  for (const [key, val] of Object.entries(values ?? {})) {
    if (val == null) continue;
    const token = `{{${key}}}`;
    if (!out.includes(token)) continue;
    out = out.split(token).join(tableSet.has(key) ? String(val) : esc(String(val)));
  }
  return out;
}
