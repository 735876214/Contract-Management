/**
 * 合同模板占位符渲染（**零依赖纯函数**，供 `template.service.generate()` 调用并可单测）。
 *
 * == 语法契约（docs/06 #5，2026-10 定稿）==
 * **只支持双花括号 `{{变量名}}`**（与采购模板体系一致）。
 * 已移除的支持：单花括号 `{变量名}`、英文遗留表格 key（`MATERIAL_CODE_TABLE`/`CONTRACT_ITEM_TABLE`）。
 * 移除依据：本项目**无存量业务数据**，无需兼容；而单花括号替换还会误伤富文本里的
 * `<style>.x{color:red}</style>` / `#{...}` 之类字面量，并会对已插入的表格 HTML 做二次替换。
 * 存量模板内容已由迁移 `20261018000000_canonicalize_template_placeholders` 统一为双花括号。
 *
 * 替换语义（保持改造前行为）：
 * - 值**按原样插入、不做 HTML 转义**（表格与富文本变量本身就是 HTML）；
 * - 替换顺序 表格 → 变量 → 补充协议；**同名键以先替换者为准**（占位符被消费后，后一轮自然无效），
 *   故补充协议只能填补变量表里没有的键；
 * - 逐个 `split/join`（非正则），故值中出现的 `$&` 等不会被当作替换模式；
 * - 未提供值的占位符**原样保留**在正文中，交由 `pendingPlaceholders()` 核对。
 */

export interface RenderTemplateInput {
  /** 富文本 HTML 正文 */
  html: string;
  /** 表格占位符 → HTML（如 `{ 物料编码清单: '<table>…</table>' }`） */
  tables?: Record<string, string> | null;
  /** 变量值表（键即占位符名） */
  values?: Record<string, unknown> | null;
  /** 补充协议占位符值（由前端解析后存于 formData.supplement），用于填补变量表未覆盖的键 */
  supplement?: Record<string, unknown> | null;
}

const str = (v: unknown): string => (v === null || v === undefined ? '' : String(v));

/** 把 `{{key}}` 全部替换为 value（不做转义） */
const replaceKey = (html: string, key: string, value: unknown): string =>
  html.split(`{{${key}}}`).join(str(value));

/** 渲染合同正文：表格 → 变量 → 补充协议 */
export function renderTemplate(input: RenderTemplateInput): string {
  let html = str(input.html);
  for (const [key, value] of Object.entries(input.tables || {})) {
    html = replaceKey(html, key, value);
  }
  for (const [key, value] of Object.entries(input.values || {})) {
    html = replaceKey(html, key, value);
  }
  for (const [key, value] of Object.entries(input.supplement || {})) {
    html = replaceKey(html, key, value);
  }
  return html;
}

/**
 * 取出正文中**仍未被替换**的 `{{占位符}}` 名（去重、保持出现顺序）。
 * 生成后若有残留，说明模板里有取值表未覆盖的占位符——值得记日志提醒维护者。
 */
export function pendingPlaceholders(html: string): string[] {
  const found = str(html).match(/\{\{([^{}]{1,60})\}\}/g) || [];
  const names = found.map((m) => m.slice(2, -2));
  return Array.from(new Set(names));
}
