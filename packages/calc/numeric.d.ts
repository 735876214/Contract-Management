/**
 * Decimal / 表单字符串 → number 的统一入口（零依赖，前后端共用）。
 * Prisma Decimal 经 JSON 序列化后是字符串，前端函数签名即便写 number 也常收到字符串，
 * 因此禁止在各模块手写 Number() / parseFloat() / `|| 0` 混用。
 */
export declare function num(v: unknown): number | null;
/** 语义别名：强调"取不到就是没有"，不是 0 */
export declare const numOrNull: typeof num;
/** 求和，忽略空值（保留 helpers.sum 的既有口径） */
export declare function sum(list: any[], pick: (item: any) => any): number;
