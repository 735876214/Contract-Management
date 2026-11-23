/** 收领单编辑器用到的小常量（从 1214 行页面文件里搬出，2026-11-22 审计）。 */

export const YES_NO = [
  { value: 'Y', label: '是' },
  { value: 'N', label: '否' },
];

/** 供应单位类型（需求 2.4.1，4 类；Tab 顺序按需求文档） */
export const SUPPLIER_TABS = [
  { key: 'SUPPLIER', label: '供应商' },
  { key: 'OTHER_PROJECT', label: '其他项目' },
  { key: 'SUBCONTRACTOR', label: '分包商' },
  { key: 'SELF_PROJECT', label: '本项目' },
];

/** 领用单位类型（需求 2.4.2，3 类；分包商默认选中） */
export const RECEIVING_TABS = [
  { key: 'SUBCONTRACTOR', label: '分包商' },
  { key: 'SELF_PROJECT', label: '本项目' },
  { key: 'OTHER_PROJECT', label: '其他项目' },
];
