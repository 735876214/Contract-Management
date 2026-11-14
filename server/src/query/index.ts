/**
 * 跨域只读查询层（Read Model）。
 *
 * 约定：**只有这里**可以直接对多个业务域的表做只读查询；业务模块（尤其 `archive` / `ai`
 * 这类聚合器）应通过本层取数，而不是在 service 里散写 `prisma.<任意模型>`。
 * 边界由 `scripts/check-module-boundaries.mjs` 锁定。
 */
export * from './archive-queries';
