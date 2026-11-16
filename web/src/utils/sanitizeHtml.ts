import DOMPurify from 'dompurify';

/**
 * 富文本 HTML 的渲染前净化（2026-10-18 安全修复）。
 *
 * 条款 / 合同模板 / 采购文档的 HTML 由有编辑权限的用户录入并落库，模板变量（项目名、供应商名等）
 * 服务端替换时**不做 HTML 转义**；直接 `dangerouslySetInnerHTML` 会形成存储型 XSS。
 * 所有渲染用户可编辑 HTML 的位置都必须先过这里。
 */
export function sanitizeHtml(html: unknown): string {
  return DOMPurify.sanitize(String(html ?? ''), { USE_PROFILES: { html: true } });
}
