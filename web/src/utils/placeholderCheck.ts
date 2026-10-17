/**
 * 占位符写法防呆（2026-10-17 自合同模板抽为共享）：保存前扫出三类**会导致变量/
 * 清单表格静默不替换**的写法，调用方弹窗警告（可继续保存）。
 * 渲染端只归一全角与带空格两种形态，被标签拆散的救不回来。
 * 使用方：合同模板（Templates.tsx）、采购模板（Procurement/Templates.tsx）。
 */
export function checkPlaceholders(html?: string): string[] {
  const problems: string[] = [];
  const text = html || '';
  if (/｛｛[^｛｝]{1,40}｝｝/.test(text)) problems.push('存在全角花括号 ｛｛…｝｝ 占位符（渲染时会自动归一，但建议改为半角 {{…}}）');
  if (/\{\{\s{1,10}\S[\s\S]{0,38}?\s{1,10}\}\}/.test(text)) problems.push('存在花括号内带空格的 {{ … }} 占位符（渲染时会自动归一，但建议写成 {{变量名}}）');
  if (/(?<!\{)\{[^{}]{1,20}\}(?!\})/.test(text.replace(/<[^>]+>/g, ''))) {
    problems.push('存在单花括号 {…} 写法——单花括号已废弃、永远不会被替换，请用变量面板插入 {{…}}');
  }
  return problems;
}
