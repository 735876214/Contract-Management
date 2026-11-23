/**
 * 导入接口的「请求里没带文件」结果。
 *
 * 起因（2026-11-22 质量审计）：13 个 controller 各写一遍这行字面量，且有**三种返回形状**
 * （结构化 errors[{row,message}] / errors:string[] 带 updated / 不带 updated）。
 * 形状是各模块前端解析契约的一部分，**这里只去重、不统一形状**：
 * 想收敛形状要改前端解析，属于另一件事，别顺手改。
 */

/** 结构化口径（total/created/updated/errors[{row,message}]/valid） */
export function noFileImportResult() {
  return { total: 0, created: 0, updated: 0, errors: [{ row: 0, message: '未上传文件' }], valid: false };
}

/** 旧扁平口径：`{ created, updated, errors: string[] }` */
export function noFileImportResultLegacy() {
  return { created: 0, updated: 0, errors: ['未上传文件'] };
}

/** 旧扁平口径（无 updated）：`{ created, errors: string[] }` */
export function noFileImportResultLegacyNoUpdate() {
  return { created: 0, errors: ['未上传文件'] };
}
