/**
 * 资源目录（单一事实源）：把「外部 AI 能对哪些业务对象做查询/导出/导入」
 * 收敛成一张表。工具只按 key 查这张表拼 URL，避免在工具里散写路径。
 *
 * 路径均相对于 `${CMS_BASE_URL}`（已含 /api）。
 * 与 server 端 controller 路由一一对应，改动后端路由时同步这里即可。
 */

/** 按能力区分「必填查询参数」：模板下载通常不依赖业务 id，避免过度拦截 */
export interface RequiredQueryByCapability {
  query?: string[];
  export?: string[];
  template?: string[];
  import?: string[];
}

export interface CmsResource {
  /** 工具里使用的资源 key（同时也作为 MCP 的 enum 值） */
  key: string;
  /** 中文名，便于 AI 理解 */
  label: string;
  /** 列表基路径 */
  path: string;
  /** 单条详情的基路径；缺省表示后端无详情路由，cms_get 不支持该资源 */
  detailPath?: string;
  /** 是否需要项目上下文（x-project-id） */
  needsProject: boolean;
  /** Excel 导出路径（返回二进制），无则不支持导出 */
  exportPath?: string;
  /** 导入模板下载路径（返回二进制） */
  templateUrl?: string;
  /** Excel 导入路径（multipart，字段名 file） */
  importPath?: string;
  /** 导入预校验路径（只校验不写库） */
  importValidatePath?: string;
  /** 各能力下的必填查询参数（如 dict 需要 typeCode） */
  requiredQuery?: RequiredQueryByCapability;
  /** 备注：给 AI 的口径提示 */
  note?: string;
}

export type Capability = 'query' | 'export' | 'template' | 'import';

export const RESOURCES: CmsResource[] = [
  {
    key: 'projects',
    label: '项目',
    path: 'projects',
    detailPath: 'projects',
    needsProject: false,
    templateUrl: 'projects/template',
    importPath: 'projects/import',
    importValidatePath: 'projects/import/validate',
    note: '项目是全局维度，无需 x-project-id。',
  },
  {
    key: 'suppliers',
    label: '供应商/分包商',
    path: 'suppliers',
    detailPath: 'suppliers',
    // 后端 SupplierController.findAll/export 用 @ProjectId() 取值，无项目头直接 1001，
    // 即便系统参数 supplier.share.scope=GLOBAL 也在参数装饰器层被拦，故这里必须为 true。
    needsProject: true,
    exportPath: 'suppliers/export',
    templateUrl: 'suppliers/template',
    importPath: 'suppliers/import',
    importValidatePath: 'suppliers/import/validate',
    note: '需要 x-project-id；受系统参数 supplier.share.scope 控制：GLOBAL 时数据全局可见，PROJECT 时按项目隔离。',
  },
  {
    key: 'contracts',
    label: '合同',
    path: 'contracts',
    detailPath: 'contracts',
    needsProject: true,
    templateUrl: 'contracts/template',
    importPath: 'contracts/import',
    importValidatePath: 'contracts/import/validate',
    note: '需要 x-project-id。导出 Word 用 cms_export_contract_word。',
  },
  {
    key: 'materials',
    label: '物料主数据',
    path: 'materials',
    needsProject: true,
    exportPath: 'materials/export',
    templateUrl: 'materials/template',
    importPath: 'materials/import',
    importValidatePath: 'materials/import/validate',
    note: '无单条详情路由，cms_get 不支持。',
  },
  {
    key: 'contract-materials',
    label: '合同清单物料',
    path: 'contract-materials',
    needsProject: true,
    exportPath: 'contract-materials/export',
    templateUrl: 'contract-materials/template',
    importPath: 'contract-materials/import',
    importValidatePath: 'contract-materials/import/validate',
    // 列表/导出/导入按合同取数需 contractId；模板是通用空模板，不依赖合同。
    requiredQuery: {
      query: ['contractId'],
      export: ['contractId'],
      import: ['contractId'],
    },
    note: '无单条详情路由，cms_get 不支持。查询/导出/导入需 contractId；模板下载不需要。',
  },
  {
    key: 'daily-reports',
    label: '日报',
    path: 'daily-reports',
    detailPath: 'daily-reports',
    needsProject: true,
    exportPath: 'daily-reports/export',
    importPath: 'daily-reports/import',
    importValidatePath: 'daily-reports/import/validate',
  },
  {
    key: 'assets',
    label: '资产',
    path: 'assets',
    needsProject: true,
    exportPath: 'assets/export',
    templateUrl: 'assets/template',
    importPath: 'assets/import',
    importValidatePath: 'assets/import/validate',
    note: '无单条详情路由，cms_get 不支持。',
  },
  {
    key: 'settlements',
    label: '结算（结算台账）',
    path: 'settlements',
    detailPath: 'settlements',
    needsProject: true,
    exportPath: 'settlements/ledger/export',
    templateUrl: 'settlements/ledger/template',
    importPath: 'settlements/ledger/import',
    importValidatePath: 'settlements/ledger/import/validate',
  },
  {
    key: 'payments',
    label: '付款记录',
    path: 'payments/records',
    needsProject: true,
    exportPath: 'payments/records/export',
    templateUrl: 'payments/records/template',
    importPath: 'payments/records/import',
    importValidatePath: 'payments/records/import/validate',
    note: '控制器只有 records 列表，无 /records/:id 详情，cms_get 不支持。',
  },
  {
    key: 'invoices',
    label: '发票',
    path: 'invoices',
    detailPath: 'invoices',
    needsProject: true,
    exportPath: 'invoices/export',
    templateUrl: 'invoices/template',
    importPath: 'invoices/import',
    importValidatePath: 'invoices/import/validate',
  },
  {
    key: 'ledger',
    label: '合同台账',
    path: 'ledger/contracts',
    needsProject: true,
    exportPath: 'ledger/export',
    note: '台账按当前列配置导出；列表走 /ledger/contracts，无单条详情路由，cms_get 不支持。',
  },
  {
    key: 'repayments',
    label: '还款协议',
    path: 'repayments',
    detailPath: 'repayments',
    needsProject: true,
    exportPath: 'repayments/export',
  },
  {
    key: 'procurement-tasks',
    label: '采购任务',
    path: 'procurement-tasks',
    detailPath: 'procurement-tasks',
    needsProject: true,
    note: '采购订单/对账在外部系统，这里只读任务与投标结果。',
  },
  {
    key: 'dict',
    label: '字典',
    path: 'dict/items',
    needsProject: false,
    exportPath: 'dict/export',
    importPath: 'dict/import',
    importValidatePath: 'dict/import/validate',
    requiredQuery: {
      query: ['typeCode'],
      export: ['typeCode'],
      import: ['typeCode'],
    },
    note: '字典是全局共享；查询/导出/导入需带 typeCode（字典类型编码）。无单条详情路由，cms_get 不支持。',
  },
];

export const RESOURCE_MAP: Record<string, CmsResource> = Object.fromEntries(
  RESOURCES.map((r) => [r.key, r]),
);

export function getResource(key: string): CmsResource {
  const r = RESOURCE_MAP[key];
  if (!r) throw new Error(`未知资源：${key}（可用：${RESOURCES.map((x) => x.key).join(', ')}）`);
  return r;
}

export function requiredQueryFor(resource: CmsResource, capability: Capability): string[] {
  return resource.requiredQuery?.[capability] ?? [];
}
