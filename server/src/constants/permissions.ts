/**
 * **权限码目录（单一事实源）**：`code` / `name` / `module` 三列在这里定义一次。
 *
 * 谁消费（改这里＝同时改它们，别再各写一份）：
 * - `prisma/seed.ts`（`npm run seed`，空库初始化与演示数据）——按本目录 upsert，
 *   所以**每次跑 seed 都会把 `name`/`module` 覆写成本文件的值**；
 * - `src/seed.ts`（后端启动自动、幂等）——只播种 AI 两条（`ai:view`/`ai:use`），
 *   标签同样取自本文件（存量库不跑 seed 也不会漏菜单项）；
 * - `test/permissionCatalog.spec.mts`——锁住「迁移里插的权限码/标签」「控制器
 *   `@RequirePermissions` 用到的码」「前端 `ROUTE_PERMISSIONS` 的码」三者都在本目录里。
 *
 * 为什么要有这个文件（2026-11-24 审计 P3 的真事）：
 * 迁移 `20261120120000_subcontractor_other_project_libs` 用随机 ID 插入了
 * `subcontractor:*` / `other-project:*` 四条权限，`module` 写成「分包商库 / 其他项目库」，
 * 而 `prisma/seed.ts` 里同一个 code 写的是「基础信息管理」。`ON CONFLICT ("code") DO NOTHING`
 * 只是不报错，**谁先跑谁定义标签**——于是「跑过 seed 的库」和「只跑过迁移的库」在角色配置页
 * （`GET /api/system/permissions` 按 `module` 分组）看到的组名不同，同一个系统两副面孔。
 *
 * 约定：`module` 是**权限分组名**（角色配置页的分组标题），不是后端业务模块名；
 * 新增权限码时，先在 `server/src/modules/<模块>` 的 controller 上标注 `@RequirePermissions('x:y')`，
 * 再在这里补一行（`test/permissionCatalog.spec.mts` 会拦住只做一半的情况）。
 */
export interface PermissionDef {
  /** 权限码，`module:action` */
  code: string;
  /** 中文名（角色配置页展示） */
  name: string;
  /** 分组名（角色配置页按它分组） */
  module: string;
}

export const PERMISSIONS: PermissionDef[] = [
  { code: 'dashboard:view', name: '查看看板', module: '看板' },
  { code: 'dict:view', name: '查看字典', module: '字典管理' },
  { code: 'dict:edit', name: '维护字典', module: '字典管理' },
  { code: 'project:view', name: '查看项目', module: '项目管理' },
  { code: 'project:edit', name: '维护项目', module: '项目管理' },
  { code: 'supplier:view', name: '查看供应商', module: '供应商库' },
  { code: 'supplier:edit', name: '维护供应商', module: '供应商库' },
  { code: 'subcontractor:view', name: '查看分包商库', module: '基础信息管理' },
  { code: 'subcontractor:edit', name: '维护分包商与授权委托书', module: '基础信息管理' },
  { code: 'other-project:view', name: '查看其他项目库', module: '基础信息管理' },
  { code: 'other-project:edit', name: '维护其他项目库', module: '基础信息管理' },
  { code: 'contract:view', name: '查看合同', module: '合同管理' },
  { code: 'contract:edit', name: '维护合同', module: '合同管理' },
  { code: 'template:view', name: '查看模板', module: '合同模板' },
  { code: 'template:edit', name: '维护模板', module: '合同模板' },
  { code: 'procurement:view', name: '查看采购工作流', module: '采购管理' },
  { code: 'procurement:edit', name: '维护采购工作流', module: '采购管理' },
  { code: 'procurement-template:view', name: '查看采购模板', module: '采购管理' },
  { code: 'procurement-template:edit', name: '维护采购模板', module: '采购管理' },
  { code: 'daily:view', name: '查看日报', module: '日报管理' },
  { code: 'daily:edit', name: '维护日报', module: '日报管理' },
  { code: 'receipt:view', name: '查看收领单', module: '日报管理' },
  { code: 'receipt:edit', name: '维护收领单', module: '日报管理' },
  { code: 'material:view', name: '查看物资基础库', module: '物资管理' },
  { code: 'material:edit', name: '维护物资与合同物资清单', module: '物资管理' },
  { code: 'settlement:view', name: '查看结算', module: '结算管理' },
  { code: 'settlement:edit', name: '维护结算', module: '结算管理' },
  { code: 'payment:view', name: '查看付款', module: '付款管理' },
  { code: 'payment:edit', name: '维护付款', module: '付款管理' },
  { code: 'invoice:view', name: '查看发票', module: '发票管理' },
  { code: 'invoice:edit', name: '维护发票', module: '发票管理' },
  { code: 'ledger:view', name: '查看合同台账', module: '合同台账' },
  { code: 'repayment:view', name: '查看还款协议', module: '还款协议' },
  { code: 'repayment:edit', name: '维护还款协议', module: '还款协议' },
  { code: 'finance:view', name: '查看资金费用台账', module: '资金费用台账' },
  { code: 'finance:edit', name: '维护资金费用台账', module: '资金费用台账' },
  { code: 'asset:view', name: '查看资产管理台账', module: '资产管理台账' },
  { code: 'asset:edit', name: '维护资产管理台账', module: '资产管理台账' },
  // 分包管理（原「劳务管理」，统一改名）/ 成本管理（附件需求 2026-10-17 新增模块）
  { code: 'labor:view', name: '查看分包授权台账', module: '分包管理' },
  { code: 'labor:edit', name: '维护分包授权台账', module: '分包管理' },
  { code: 'cost:view', name: '查看成本台账', module: '成本管理' },
  { code: 'cost:edit', name: '维护成本台账', module: '成本管理' },
  // 项目资料归档（一键打包下载）
  { code: 'archive:view', name: '查看项目资料归档', module: '项目资料归档' },
  { code: 'system:user', name: '用户与角色管理', module: '系统管理' },
  { code: 'system:role', name: '角色管理', module: '系统管理' },
  { code: 'system:config', name: '系统参数配置', module: '系统管理' },
  { code: 'system:log', name: '日志查看', module: '系统管理' },
  // AI 助手（2026-10-19）：view = 看入口与字段目录；use = 真正消耗配额的扫描与回填
  { code: 'ai:view', name: '查看 AI 助手', module: 'AI 助手' },
  { code: 'ai:use', name: '使用 AI 助手', module: 'AI 助手' },
];
