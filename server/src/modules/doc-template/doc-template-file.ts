/**
 * **单据模板文件键 / 文件名的纯逻辑**（零依赖，可被 `.mts` 单测直接加载）。
 *
 * URL / 公开地址 / 相对键的归一化已收编到 `common/utils/storage-url.ts`；
 * 这里保留同名导出，避免改动既有导入与测试。
 */

import { storageKeyFromUrl } from '../../common/utils/storage-url.ts';

/** URL / 公开地址 / 相对键 → StorageService 相对键（POSIX 分隔，去掉 `./` 与重复斜杠） */
export function normalizeDocTemplateFileKey(raw: unknown): string {
  return storageKeyFromUrl(raw);
}

/** 是否为 Excel 工作簿文件名（单据模板只收 `.xlsx`；`.xlsm` 宏会在写出时丢失，故不支持） */
export function isExcelTemplateFileName(name: unknown): boolean {
  return /\.xlsx$/i.test(String(name ?? '').trim());
}
