/**
 * AI 字段目录（**零运行时依赖**，`.mts` spec 直接加载）。
 *
 * 这是「系统里有哪些值可以填进别人的表格」的**单一事实源**：功能 2（模版填报）用它给模型
 * 提供"准许使用的字段清单"，功能 3（汇报材料）再用它的超集去生成事实卡。
 *
 * 三条不可谈判的约定：
 * 1. **模型只看标签，不看值**。字段值一律由 `FieldResolverService` 在服务端取，
 *    prompt 里只出现 `key + label`（见 `ai-prompt.ts`）。这样即使上游被攻破，
 *    拿走的也只是"这个系统有'银行账号'这个字段"这类元信息。
 * 2. **敏感字段标 `sensitive`**：值仍然可以填（业务确实要填银行账号），
 *    但禁止进入功能 3 的自由文本生成与任何日志。
 * 3. **金额/比例的标签必须带单位**（`(元)` / `(%)`）：模型靠标签猜类型，
 *    标签不带单位就会出现"把 0.65 填进'付款比例%'"的错。
 */

/** 值类型：决定格式化方式（金额 2 位小数、比例 ×100、日期 YYYY-MM-DD） */
export type AiFieldType = 'text' | 'date' | 'money' | 'number' | 'percent' | 'dict';

/** 取值作用域：project 只需项目上下文；contract/supplier 需要对应 id；period = 期间发生额；cross = 跨项目聚合；
 *  ledger/cost/procurement/asset/daily = 各业务域的期间/累计标量 */
export type AiFieldScope =
  | 'project'
  | 'contract'
  | 'supplier'
  | 'stats'
  | 'period'
  | 'cross'
  | 'ledger'
  | 'cost'
  | 'procurement'
  | 'asset'
  | 'daily';

export interface AiFieldDef {
  /** 稳定键：`<域>.<字段>`，作为模型的输出契约，**不要改名**（改名会让历史映射失效） */
  key: string;
  /** 中文标签：模型匹配的唯一依据，须与业务口语一致（"项目名称"而不是"name"） */
  label: string;
  type: AiFieldType;
  scope: AiFieldScope;
  /** 敏感值（银行账号/证件号/联系方式）：可填，但不得进自由文本生成与日志 */
  sensitive?: boolean;
  /** 同义标签（模型匹配用；也是前端展示的"还可以识别为"） */
  aliases?: string[];
}

export const AI_FIELD_CATALOG: readonly AiFieldDef[] = [
  // ---------- 项目 ----------
  { key: 'project.name', label: '项目名称', type: 'text', scope: 'project', aliases: ['工程名称', '项目全称'] },
  { key: 'project.nameAbbr', label: '项目简称', type: 'text', scope: 'project' },
  { key: 'project.code', label: '项目编号', type: 'text', scope: 'project', aliases: ['项目编码', '工程编号'] },
  { key: 'project.codeAbbr', label: '项目字母简称', type: 'text', scope: 'project' },
  { key: 'project.undertaker', label: '承接单位', type: 'text', scope: 'project', aliases: ['施工单位'] },
  { key: 'project.packageLeader', label: '项目包保领导', type: 'text', scope: 'project' },
  { key: 'project.projectManager', label: '项目经理', type: 'text', scope: 'project', aliases: ['项目负责人'] },
  { key: 'project.provinceCity', label: '项目所在省市', type: 'text', scope: 'project' },
  { key: 'project.siteLocation', label: '工程地点', type: 'text', scope: 'project', aliases: ['施工地点', '项目地点'] },
  { key: 'project.projectAddress', label: '项目地址', type: 'text', scope: 'project' },
  { key: 'project.materialOrigin', label: '物资产地', type: 'text', scope: 'project' },
  { key: 'project.industryTypeName', label: '项目业态', type: 'dict', scope: 'project' },
  { key: 'project.selfContractAmount', label: '项目自施合同额(万元)', type: 'money', scope: 'project' },
  { key: 'project.startDate', label: '开工日期', type: 'date', scope: 'project', aliases: ['计划开工日期'] },
  { key: 'project.endDate', label: '竣工日期', type: 'date', scope: 'project', aliases: ['计划竣工日期'] },
  { key: 'project.settlementStartDate', label: '月度结算起始日', type: 'date', scope: 'project' },

  // ---------- 合同（需选中合同；未选中时这些字段不可用） ----------
  { key: 'contract.code', label: '合同编号', type: 'text', scope: 'contract', aliases: ['合同编码'] },
  { key: 'contract.name', label: '合同名称', type: 'text', scope: 'contract' },
  { key: 'contract.typeName', label: '合同类型', type: 'dict', scope: 'contract', aliases: ['合同类别'] },
  { key: 'contract.supplierName', label: '供应商名称', type: 'text', scope: 'contract', aliases: ['乙方名称', '分包单位', '供方名称'] },
  { key: 'contract.signDate', label: '签订日期', type: 'date', scope: 'contract', aliases: ['合同签订日期', '签订时间'] },
  { key: 'contract.amount', label: '合同金额(元)', type: 'money', scope: 'contract', aliases: ['合同总价', '合同价款'] },
  { key: 'contract.chainAmount', label: '合同当前金额(元)', type: 'money', scope: 'contract', aliases: ['含变更后合同金额', '合同结算上限'] },
  { key: 'contract.changeTotal', label: '补充协议累计变更(元)', type: 'money', scope: 'contract' },
  { key: 'contract.supplementCount', label: '补充协议数量', type: 'number', scope: 'contract' },
  { key: 'contract.taxRatePct', label: '税率(%)', type: 'percent', scope: 'contract' },
  { key: 'contract.payRatioPct', label: '当前合同付款比例(%)', type: 'percent', scope: 'contract', aliases: ['付款比例'] },
  { key: 'contract.execStatusName', label: '合同履约状态', type: 'dict', scope: 'contract' },
  { key: 'contract.remark', label: '合同备注', type: 'text', scope: 'contract' },

  // ---------- 供应商（来自选中合同，或手工选供应商） ----------
  { key: 'supplier.name', label: '供应商全称', type: 'text', scope: 'supplier', aliases: ['乙方名称', '供方单位'] },
  { key: 'supplier.legalPerson', label: '法定代表人', type: 'text', scope: 'supplier', aliases: ['法人姓名'] },
  { key: 'supplier.contactName', label: '联系人', type: 'text', scope: 'supplier' },
  { key: 'supplier.contactPhone', label: '联系电话', type: 'text', scope: 'supplier', sensitive: true },
  { key: 'supplier.contactEmail', label: '电子邮箱', type: 'text', scope: 'supplier', sensitive: true },
  { key: 'supplier.bankName', label: '开户银行', type: 'text', scope: 'supplier' },
  { key: 'supplier.bankAccount', label: '银行账号', type: 'text', scope: 'supplier', sensitive: true, aliases: ['开户账号'] },
  { key: 'supplier.address', label: '公司地址', type: 'text', scope: 'supplier', aliases: ['注册地址', '通讯地址'] },

  // ---------- 项目级统计（口径复用既有工具，见 FieldResolverService） ----------
  { key: 'stats.contractCount', label: '合同数量', type: 'number', scope: 'stats' },
  { key: 'stats.contractAmountTotal', label: '合同金额合计(元)', type: 'money', scope: 'stats' },
  { key: 'stats.settlementAmountTotal', label: '累计结算金额(元)', type: 'money', scope: 'stats' },
  { key: 'stats.paymentAmountTotal', label: '累计付款金额(元)', type: 'money', scope: 'stats' },
  { key: 'stats.invoiceAmountTotal', label: '累计开票金额(元)', type: 'money', scope: 'stats' },
  { key: 'stats.unpaidAmount', label: '应付未付金额(元)', type: 'money', scope: 'stats' },

  // ---------- 期间发生额（按业务发生日；缺省为「本月 1 日 ~ 今天」） ----------
  { key: 'period.contractSignedCount', label: '本期新签合同数量', type: 'number', scope: 'period', aliases: ['本期合同数'] },
  { key: 'period.contractSignedAmount', label: '本期新签合同金额(元)', type: 'money', scope: 'period', aliases: ['本期签约额'] },
  { key: 'period.settlementAmount', label: '本期结算金额(元)', type: 'money', scope: 'period', aliases: ['本期结算额'] },
  { key: 'period.paymentAmount', label: '本期付款金额(元)', type: 'money', scope: 'period', aliases: ['本期付款额'] },
  { key: 'period.invoiceAmount', label: '本期开票金额(元)', type: 'money', scope: 'period', aliases: ['本期开票额'] },
  { key: 'period.dailyReportCount', label: '本期日报条数', type: 'number', scope: 'period' },

  // ---------- 跨项目聚合（全部/多选项目；需要「统计报表-查看」权限） ----------
  { key: 'cross.projectCount', label: '汇总项目数量', type: 'number', scope: 'cross' },
  { key: 'cross.contractCount', label: '汇总合同数量', type: 'number', scope: 'cross' },
  { key: 'cross.signedAmount', label: '汇总签约额(元)', type: 'money', scope: 'cross', aliases: ['全部项目签约额'] },
  { key: 'cross.settlementAmount', label: '汇总结算额(元)', type: 'money', scope: 'cross' },
  { key: 'cross.paymentAmount', label: '汇总付款额(元)', type: 'money', scope: 'cross' },
  { key: 'cross.invoiceAmount', label: '汇总开票额(元)', type: 'money', scope: 'cross' },
  { key: 'cross.unpaidAmount', label: '汇总应付未付(元)', type: 'money', scope: 'cross' },
  { key: 'cross.uninvoicedAmount', label: '汇总已结未开票(元)', type: 'money', scope: 'cross' },

  // ---------- 台账 / 成本 / 采购 / 资产 / 日报 关键标量 ----------
  { key: 'ledger.settleMonthCount', label: '台账行数', type: 'number', scope: 'ledger' },
  { key: 'ledger.cumPurchaseAmount', label: '开累采购额(元)', type: 'money', scope: 'ledger' },
  { key: 'cost.profitLossCount', label: '月度盈亏记录数', type: 'number', scope: 'cost' },
  { key: 'cost.sixSavingsAmount', label: '六项降本创效合计(元)', type: 'money', scope: 'cost' },
  { key: 'procurement.taskCount', label: '采购任务数量', type: 'number', scope: 'procurement' },
  { key: 'asset.originalTotalAmount', label: '资产原值总额(元)', type: 'money', scope: 'asset' },
  { key: 'asset.inQty', label: '本期资产进场数量', type: 'number', scope: 'asset' },
  { key: 'daily.reportCount', label: '总日报条数', type: 'number', scope: 'daily' },
  { key: 'daily.confirmedReportCount', label: '已确认总日报条数', type: 'number', scope: 'daily' },
] as const;

const FIELD_MAP = new Map(AI_FIELD_CATALOG.map((f) => [f.key, f]));

export function aiFieldByKey(key: string): AiFieldDef | undefined {
  return FIELD_MAP.get(String(key ?? '').trim());
}

/**
 * 按上下文过滤可用字段：没有选中合同时，`contract.*` / `supplier.*` 字段不该出现在候选里
 * （否则模型会把"合同编号"映射成一个永远取不到值的字段，用户看到的是空填充）。
 * 跨项目填报（`crossProject`）时不提供 `contract.*` / `supplier.*`（单据级字段没有「汇总值」语义），
 * 只提供 `period.*` / `cross.*` 与项目基础字段。
 */
export function availableFields(ctx: {
  hasContract: boolean;
  hasSupplier: boolean;
  crossProject?: boolean;
  /** 期间字段是否可用（默认 true；缺省期间按「本月 1 日 ~ 今天」） */
  hasPeriod?: boolean;
}): AiFieldDef[] {
  const cross = Boolean(ctx.crossProject);
  return AI_FIELD_CATALOG.filter((f) => {
    if (f.scope === 'contract') return ctx.hasContract && !cross;
    if (f.scope === 'supplier') return ctx.hasSupplier && !cross;
    if (f.scope === 'period') return ctx.hasPeriod !== false;
    if (f.scope === 'cross') return cross;
    return true;
  });
}

/**
 * 域 → 读该域数据所需的权限码。
 *
 * AI 填表本质是「替人把库里的值抄到表里」，因此**必须与界面读数据同权限**：
 * 只有 `ai:use` 而没有 `contract:view` 的岗位，不该靠上传一张表把合同金额、供应商银行账号
 * 一个个抄出来（2026-10-20 审计 P3：sensitive 原来只是标注，不拦任何东西）。
 * `stats.*` 是合同/结算/付款的汇总口径，与合同同源。
 */
export const SCOPE_READ_PERMISSION: Record<AiFieldScope, string> = {
  project: 'project:view',
  contract: 'contract:view',
  supplier: 'supplier:view',
  stats: 'contract:view',
  period: 'contract:view',
  // 跨项目汇总比单项目敏感：与统计报表同权限（dashboard:view）
  cross: 'dashboard:view',
  ledger: 'ledger:view',
  cost: 'cost:view',
  procurement: 'contract:view',
  asset: 'asset:view',
  daily: 'daily:view',
};

/**
 * 按权限过滤字段。`can(code)` 由调用方注入（超管恒 true）。
 * 返回被拒的字段，供上层拼一句「有 N 个字段因缺少权限未列出」，避免用户以为系统丢了字段。
 */
export function filterFieldsByPermission(
  fields: readonly AiFieldDef[],
  can: (code: string) => boolean,
): { fields: AiFieldDef[]; denied: AiFieldDef[] } {
  const allowed: AiFieldDef[] = [];
  const denied: AiFieldDef[] = [];
  for (const f of fields) {
    const code = SCOPE_READ_PERMISSION[f.scope];
    if (code && !can(code)) denied.push(f);
    else allowed.push(f);
  }
  return { fields: allowed, denied };
}

/** 键是否在目录内（白名单校验入口：任何来自前端的 fieldKey 都要先过这一关） */
export function isKnownFieldKey(key: unknown): boolean {
  return typeof key === 'string' && FIELD_MAP.has(key);
}
