/**
 * 前端 API 响应类型的公共原语（`web/src/api/types/` 的地基）。
 *
 * ## 为什么要有这一层
 *
 * `web/src/api/modules.ts` 里 224 个端点原先一律 `http.get<any, any>`：后端有 Prisma 类型、
 * 有 `constants/metrics.ts` 的口径登记，前端却对响应结构一无所知——字段改名、金额下发成
 * string 还是 number，全靠运行时炸。这层把「后端返回什么」变成编译期可见。
 *
 * ## 三条硬约定（写类型时照抄，别自己发明）
 *
 * 1. **分页一律 `Paged<T>`**。唯一来源是 `server/src/common/utils/helpers.ts#buildResult()`，
 *    形状 `{ list, total, page, pageSize }`，且 `pageSize` 是**实际切片大小**（导出场景传 5000 时
 *    也是 5000，不是夹到 500——2026-11-22 审计修的就是这个）。
 * 2. **金额/数量用 `Decimalish`**。同一个后端存在两种 JSON 类型（2026-11-24 实测）：
 *    `GET /ledger/contracts` 的行过了 `num()` → `amount: 500000`（number），
 *    而 `GET /contracts` 把 Prisma `Decimal` 原样漏出 → `amount: "500000"`（string）。
 *    所以前端**一律先 `Number(v)` 再算**，别假设是哪种；纯展示走 `utils/money.ts`。
 * 3. **「未填」是 `null`，不是 0**。全站三态口径：`formatMoney` 会把 `null` 显示成 `-`，
 *    而 0 会显示成 `¥0.00`——两者在业务上不等价，类型里不要用 `| 0` 糊过去。
 *
 * ⚠️ `web/src/api/types/*` 必须保持**零依赖**（只 import 同目录文件）：`server/test-integration/*.int.spec.ts`
 * 会直接 import 这里的 `*_ROW_KEYS` 常量做跨端契约校验（沿用 `frontendChainParity.spec.mts` 的做法）。
 */

/** 后端 Decimal/金额字段的两种落地形态：number（过了 num()）或 string（Prisma 原样）。 */
export type Decimalish = number | string;

/** 分页响应（形状见 `server/src/common/utils/helpers.ts#buildResult`）。 */
export interface Paged<T> {
  list: T[];
  total: number;
  /** 当前页码（1 起） */
  page: number;
  /** **实际**切片大小，不一定是请求里的 pageSize */
  pageSize: number;
}

/**
 * 列表查询参数的公共部分。
 *
 * ⚠️ `pageSize` 上限是 **500**（`paginate()` 的 maxPageSize），传更大也只取 500；
 * 要更大得用导出/批量专用端点（`paginate(query, 5000)`）。
 */
export interface ListParams {
  page?: number;
  pageSize?: number;
  keyword?: string;
}

/**
 * 后端日期字段的两种形态：
 * - 过 `fmtDate` 的列 → `'YYYY-MM-DD'`（本机日口径）；
 * - 直接回 Prisma DateTime 的列 → ISO 串 `'2026-01-05T00:00:00.000Z'`（**UTC 零点**，
 *   所以别在前端再 `new Date(str).getMonth()` 之类地拆，用 `utils` 里的本地日原语）。
 * 未填一律 `null`。
 */
export type Dateish = string | null;

/** 实体 id（cuid 字符串）。 */
export type Id = string;

/** 可写载荷的公共尾部：乐观锁版本号（`assertVersion` / `versionedUpdate` 用）。 */
export interface Versioned {
  version?: number;
}
