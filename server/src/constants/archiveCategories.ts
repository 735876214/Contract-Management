/**
 * 项目资料归档 · 目录注册表（附件需求 2026-10-17，业务逐条确认的最终版）。
 *
 * ⚠️ 零依赖常量：目录结构与序号是**业务口径**（用户给的目录举例），
 * 前端归档页与后端打包共用（前端镜像 `web/src/constants/archiveCategories.ts`，
 * 由 `archiveNaming.spec.mts` 锁两侧一致——与 paymentModes / todoCategories 同一做法）。
 * 增删目录只改这里（+前端镜像），收集器按 key 分发。
 */

export interface ArchiveCategory {
  /** 稳定 key（scope 参数与前端 Tab 用） */
  key: string;
  /** ZIP 内目录（相对项目根；POSIX `/`；带需求序号） */
  dir: string;
  label: string;
  /** 空目录占位说明里指向的来源模块 */
  sourceModule: string;
}

export const ARCHIVE_CATEGORIES: ArchiveCategory[] = [
  { key: 'contract', dir: '1.合同台账及扫描件', label: '合同台账及扫描件', sourceModule: '合同管理' },
  { key: 'settle-ledger', dir: '2.结算台账', label: '结算台账', sourceModule: '结算台账' },
  { key: 'daily-asset', dir: '3.物资进出场台账', label: '物资进出场台账', sourceModule: '日报管理' },
  {
    key: 'receipt-scan',
    dir: '5.物资结算/收领单',
    label: '收领单（扫描件）',
    sourceModule: '收领单',
  },
  {
    key: 'settle-monthly',
    dir: '5.物资结算/月度结算单',
    label: '月度结算单（按结算账期分组，Excel）',
    sourceModule: '结算单',
  },
  {
    key: 'settle-final',
    dir: '5.物资结算/总结算书',
    label: '总结算书（Excel）',
    sourceModule: '总结算单',
  },
  {
    key: 'sub-receiving',
    dir: '6.分包领用汇总表',
    label: '分包领用汇总表（按分包商分组，Excel）',
    sourceModule: '成本管理/分包领用汇总',
  },
  { key: 'payment', dir: '7.付款台账', label: '付款台账', sourceModule: '付款管理' },
  { key: 'invoice', dir: '8.发票台账', label: '发票台账', sourceModule: '发票管理' },
  {
    key: 'profit-loss',
    dir: '9.降本创效主材盈亏分析表',
    label: '降本创效主材盈亏分析表（Excel）',
    sourceModule: '成本管理/盈亏分析',
  },
  {
    key: 'finance-fund',
    dir: '10.保理与逾期利息',
    label: '保理费用与逾期利息台账',
    sourceModule: '资金费用台账',
  },
  {
    key: 'labor-auth',
    dir: '11.分包授权台账',
    label: '分包授权台账（Excel 内嵌照片）',
    sourceModule: '劳务管理',
  },
  { key: 'repayment', dir: '13.还款协议', label: '还款协议', sourceModule: '还款协议' },
];

export const ARCHIVE_CATEGORY_BY_KEY: Record<string, ArchiveCategory> = Object.fromEntries(
  ARCHIVE_CATEGORIES.map((c) => [c.key, c]),
);
