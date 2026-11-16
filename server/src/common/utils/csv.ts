/**
 * CSV 单元格转义 + **公式注入防护**。
 *
 * 背景（第 19 轮审计）：合同物资清单的 CSV 导出把「备注」「物资名称」等用户可填字段原样
 * 拼进文本。Excel / WPS 打开 CSV 时会把以 `= + - @` 开头的单元格当公式执行，
 * 于是备注里写 `=cmd|'/c calc'!A1` 或 `=HYPERLINK("http://evil","点我")`
 * 就能在**别人的机器上**执行命令 / 弹钓鱼链接（CSV injection）。
 *
 * 处置：以危险字符开头的值前面补一个单引号（Excel 里显示为文本，不会执行），
 * 再按 RFC 4180 做引号包裹。数字保持原样（数字不会以这些字符开头）。
 */

/** 会被 Excel 当成公式/命令的起始字符 */
const FORMULA_LEAD = /^[=+\-@\t\r]/;

export function csvCell(value: unknown): string {
  const raw = value === null || value === undefined ? '' : String(value);
  // 纯数字（含负号开头）不是注入：`-5` 要保留为数字而不是变成 `'-5`
  const isPlainNumber = /^[+-]?\d+(\.\d+)?$/.test(raw);
  const guarded = !isPlainNumber && FORMULA_LEAD.test(raw) ? `'${raw}` : raw;
  return /[",\n\r]/.test(guarded) ? `"${guarded.replace(/"/g, '""')}"` : guarded;
}

/** 把二维数组拼成 CSV 文本（不含 BOM，调用方自行决定是否加） */
export function toCsv(rows: readonly (readonly unknown[])[]): string {
  return rows.map((cols) => cols.map(csvCell).join(',')).join('\r\n');
}
