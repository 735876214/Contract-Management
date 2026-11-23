/**
 * 触发浏览器下载（`<a download>` + object URL 回收）——**全站唯一实现**。
 *
 * 为什么单独一个零依赖文件（而不是放进 `utils/download.ts`）：`utils/download.ts` 依赖
 * `@/store/auth` 与 localStorage，而本函数会被 `server/test/*.spec.mts` 间接加载
 * （Node 原生类型擦除，解析不了 `@/` 别名、也加载不了 React store）。
 *
 * 收敛前有 3 份几乎相同的拷贝（`docExport.ts` / `procurementExport.ts` / `reportExport.ts`），
 * 差异只在"什么时候 revoke"：回收太早会让部分浏览器（Safari / 旧版 Firefox）在点击与读流之间
 * 拿到已释放的 URL，下载变空白文件。统一为「延迟 1 秒回收」，用 `a.remove()` 而不是
 * `removeChild`（父节点可能已被框架改动）。
 */
export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  a.remove();
  // 延迟回收：立即 revoke 时 Safari/旧版 Firefox 可能读到已释放的 URL → 空白文件
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
