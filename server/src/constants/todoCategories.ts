/**
 * 待办分类注册表（业务口径 2026-10-16：**为每个模块都预留一个待办位置**——
 * 0 条的分类 Tab 也常驻显示，让人知道"这个模块没有待办"而不是"这里没有这个模块"）。
 *
 * 为什么是零依赖常量：与 `statuses.ts` 同理 —— 前端工作台的分类 Tab 必须与后端聚合接口的
 * 分组**逐条一致**，由 `dashboardTodo.spec.mts` 锁死（key/label/permission 三项）。
 *
 * `permission` 决定该分类**是否对该用户可见**：无权限的分类后端整体不下发，
 * 前端也不渲染其 Tab（不是渲染一个"无权查看"，而是当作没有这个模块）。
 */

/** 单条待办的紧急级别（前端据此给色：RED=红、AMBER=琥珀、INFO=中性） */
export type TodoLevel = 'RED' | 'AMBER' | 'INFO';

export interface TodoCategory {
  /** 稳定 key（前端 Tab 的 key、单条待办的"消除提醒"都按它归组） */
  key: string;
  /** 分类名（Tab 上的文字） */
  label: string;
  /** 查看该分类所需权限码；用户无此权限 → 整个分类不下发 */
  permission: string;
  /** 每类最多下发的条数（工作台只是入口，不是完整列表） */
  limit: number;
}

export const TODO_CATEGORIES: TodoCategory[] = [
  { key: 'CONTRACT_DRAFT', label: '合同起草', permission: 'contract:view', limit: 8 },
  { key: 'CONTRACT_SIGN', label: '合同待签章', permission: 'contract:view', limit: 8 },
  { key: 'SETTLEMENT_DRAFT', label: '结算单待提交', permission: 'settlement:view', limit: 8 },
  { key: 'FINAL_SETTLEMENT', label: '总结算单待办理', permission: 'settlement:view', limit: 8 },
  { key: 'PAYMENT_PROCEDURE', label: '付款手续待编制', permission: 'payment:view', limit: 8 },
  { key: 'INVOICE_VERIFY', label: '待查验发票', permission: 'invoice:view', limit: 8 },
  { key: 'OVERDUE_INTEREST', label: '逾期利息待对账', permission: 'finance:view', limit: 8 },
  { key: 'PROCUREMENT_TODO', label: '采购待编制', permission: 'contract:view', limit: 8 },
  { key: 'OVERDUE_MILESTONE', label: '履约节点逾期', permission: 'contract:view', limit: 8 },
];

/** key → 分类（聚合查询按它分发） */
export const TODO_CATEGORY_BY_KEY: Record<string, TodoCategory> = Object.fromEntries(
  TODO_CATEGORIES.map((c) => [c.key, c]),
);

/** 单条待办的目标：能给编辑器页签就给（需求 3），否则落到模块列表 */
export interface TodoTarget {
  /** 目标路由（模块列表路径） */
  path: string;
  /** 能定位到编辑器页签时为 `'new'` 或记录 id；此时前端跳 `<path>?editor=<editor>` */
  editor?: string;
  /** 列表预筛参数（如 `{ status: 'WAIT_VERIFY' }`）；仅 path 形态时使用 */
  query?: Record<string, string>;
}

/** 单条待办 */
export interface TodoItem {
  /** 稳定标识（去重、"消除提醒"都按它）——`<模块>:<id>[:<语义>]` */
  key: string;
  title: string;
  /** 业务编号（合同号/单据号/发票号…；展示用） */
  code?: string;
  level: TodoLevel;
  /** 补充说明（如"已超时 6 小时"） */
  hint?: string;
  target: TodoTarget;
}

/** 某分类的聚合结果 */
export interface TodoGroup {
  key: string;
  label: string;
  /** 该分类的**全量条数**（items 最多 limit 条，count 可能更大） */
  count: number;
  items: TodoItem[];
}
