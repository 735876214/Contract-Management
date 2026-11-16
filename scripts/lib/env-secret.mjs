/**
 * JWT_SECRET 的弱值判定（worktree 建树脚本与 verify-module 共用）。
 *
 * `jwt.strategy.ts` 会 fail-fast 拒绝缺省、`cms-super-secret-key` 与 `change-me*`；
 * 两个脚本都必须用同一判据，否则会出现「手动跑能过、verify 里启动期整文件失败」。
 */
export function isWeakJwtSecret(value) {
  const v = String(value ?? '').trim();
  return !v || v === 'cms-super-secret-key' || v.startsWith('change-me');
}
