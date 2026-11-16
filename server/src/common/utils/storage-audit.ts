/**
 * 本地文件存储审计（纯函数，零依赖；供 `server/scripts/storage-audit.mjs` 与 `.mts` 单测使用）。
 *
 * 只回答四个问题，**不删除任何文件**：
 * - `missing`：数据库有引用、磁盘没有对应文件（下载会 400/404）；
 * - `orphans`：磁盘有文件、数据库没有任何引用（重签/删除业务行后的残留）；
 * - `duplicates`：同一个键被多条记录引用（信息项，正常也可能出现）；
 * - `invalid`：引用无法通过 `assertSafeStorageKey`（`..`、绝对路径等）。
 */

import { assertSafeStorageKey, normalizeStorageKey, StorageKeyError } from './storage-keys.ts';
import { storageKeyFromUrl } from './storage-url.ts';

export interface StoredRef {
  /** 业务来源，如 `Contract` / `Invoice` */
  source: string;
  /** 记录 ID（便于人工核对） */
  id: string;
  /** 字段名，如 `signedFilePath` */
  field: string;
  /** 数据库里的原始值（键或 URL） */
  raw: string;
}

export interface StorageAuditResult {
  referenceCount: number;
  fileCount: number;
  missing: StoredRef[];
  orphans: string[];
  duplicates: { key: string; refs: StoredRef[] }[];
  invalid: { ref: StoredRef; error: string }[];
}

/** 比较数据库引用与磁盘文件键；`fileKeys` 为相对存储根目录的 POSIX 键 */
export function buildStorageAudit(refs: StoredRef[], fileKeys: string[]): StorageAuditResult {
  const files = new Set(fileKeys.map((k) => normalizeStorageKey(String(k ?? ''))).filter(Boolean));
  const byKey = new Map<string, StoredRef[]>();
  const invalid: { ref: StoredRef; error: string }[] = [];

  for (const ref of refs) {
    const raw = String(ref.raw ?? '').trim();
    if (!raw) continue;
    const key = storageKeyFromUrl(raw);
    if (!key) continue;
    try {
      assertSafeStorageKey(key);
    } catch (e) {
      invalid.push({ ref, error: e instanceof StorageKeyError ? e.message : String(e) });
      continue;
    }
    const list = byKey.get(key) ?? [];
    list.push(ref);
    byKey.set(key, list);
  }

  const missing: StoredRef[] = [];
  const duplicates: { key: string; refs: StoredRef[] }[] = [];
  for (const [key, list] of byKey) {
    if (!files.has(key)) missing.push(...list);
    if (list.length > 1) duplicates.push({ key, refs: list });
  }
  const orphans = [...files].filter((k) => !byKey.has(k)).sort();
  duplicates.sort((a, b) => a.key.localeCompare(b.key));

  return {
    referenceCount: [...byKey.values()].reduce((s, list) => s + list.length, 0),
    fileCount: files.size,
    missing,
    orphans,
    duplicates,
    invalid,
  };
}
