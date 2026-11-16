/**
 * Excel 工作表名净化。
 *
 * 背景（2026-10-21 第 12 轮审计）：字典类型名直接当 sheet 名传给了
 * `wb.addWorksheet()`（`excel.service.ts` / `dict.service.ts:332`）。
 * Excel 对 sheet 名有硬约束——不能含 `* ? : \ / [ ]`、不能为空、长度 ≤ 31；
 * exceljs 遇到非法字符直接 throw「cannot include any of the following characters」，
 * 于是管理员把字典命名为「备注[1]」之后，这个字典的导出就永久 500（运行期才炸）。
 *
 * 处置：所有动态来源的 sheet 名统一过这里，非法字符替换成 `_`、超长截断、
 * 空名回落 fallback。名称只影响显示，不影响任何取数逻辑。
 */
export function sanitizeSheetName(name: unknown, fallback = 'Sheet1'): string {
  const raw = String(name ?? '')
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x1f*?:\\/[\]]/g, '_')
    .trim();
  const trimmed = raw.replace(/^'+|'+$/g, '').trim();
  if (!trimmed) return fallback;
  return trimmed.slice(0, 31);
}
