/**
 * 存储「键」与路径的**纯逻辑**（零依赖、无 fs、无 Nest → 可被 `server/test/*.spec.mts` 直接单测）。
 *
 * 为什么要这层：落盘写入点散落多处（上传、合同签章件、导入错误报告），每处都自己拼
 * `UPLOAD_DIR` 相对/绝对路径与文件名，规则易漂移、也难以为将来换对象存储（MinIO/S3）做统一改造。
 * 这里把**与存储后端无关**的部分抽出来：键的规范化与安全校验、相对键 ↔ 绝对路径、对外 URL。
 *
 * 键（key）约定：**相对 POSIX 路径**，如 `2026-10/1730000000000-ab12cd34.pdf`、`signed/xxx.pdf`。
 * 统一用 `/` 分隔（不用 `path.join` 以免在 Windows 上落库成 `signed\xxx.pdf`，
 * 那种值在 Linux 下读不到、也无法拼成 URL）。
 */

import * as path from 'path';

/** 存储键非法（越权路径）——由服务层翻译为 400 */
export class StorageKeyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StorageKeyError';
  }
}

/** 上传根目录：`UPLOAD_DIR` 为相对路径时按进程工作目录解析（与改造前各处的口径一致） */
export function resolveUploadRoot(uploadDir?: string, cwd = process.cwd()): string {
  const dir = uploadDir && uploadDir.trim() ? uploadDir : './uploads';
  return path.isAbsolute(dir) ? dir : path.resolve(cwd, dir);
}

/** 默认子目录 = 当前月份 `YYYY-MM`（上传接口的历史行为，按月分目录避免单目录过大） */
export function defaultSubDir(now: Date = new Date()): string {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  return `${y}-${m}`;
}

/** 生成存储文件名：`<时间戳>-<8位随机><扩展名>`（与上传/签章件的历史命名一致，避免撞名） */
export function storageFileName(ext = '', now: Date = new Date()): string {
  const suffix = (ext || '').trim();
  const clean = suffix && !suffix.startsWith('.') ? `.${suffix}` : suffix;
  const rand = Math.random().toString(36).slice(2, 10);
  return `${now.getTime()}-${rand}${clean}`;
}

/** 规范化键：反斜杠转 `/`、去掉 `./` 与重复/首尾分隔符 */
export function normalizeStorageKey(key: string): string {
  return String(key ?? '')
    .replace(/\\/g, '/')
    .split('/')
    .filter((seg) => seg !== '' && seg !== '.')
    .join('/');
}

/**
 * 校验键安全：拒绝绝对路径、`..` 段、Windows 驱动器号与 UNC。
 * 越权路径一律抛 `StorageKeyError`（**不做静默纠正**——把 `..` 悄悄吃掉反而会掩盖调用方的 bug）。
 */
export function assertSafeStorageKey(key: string): void {
  const raw = String(key ?? '');
  if (!raw.trim()) throw new StorageKeyError('存储键不能为空');
  if (/^([a-zA-Z]:|[\\/]{1,2})/.test(raw)) throw new StorageKeyError(`存储键不能是绝对路径：${key}`);
  const segments = raw.replace(/\\/g, '/').split('/').filter((s) => s !== '' && s !== '.');
  if (segments.some((s) => s === '..')) throw new StorageKeyError(`存储键不能包含上级目录引用：${key}`);
}

/** 相对键 → 绝对路径（`root` 下的规范化拼接；调用方应先 `assertSafeStorageKey`） */
export function absPathOf(root: string, key: string): string {
  const normalized = normalizeStorageKey(key);
  return normalized ? path.join(root, ...normalized.split('/')) : root;
}

/** 相对键 → 对外可访问 URL（前缀 `/api/files`，由 `FileServeController`（需登录）提供，见 `main.ts` 注释） */
export function publicUrlOf(key: string, prefix = '/api/files'): string {
  const normalized = normalizeStorageKey(key);
  return normalized ? `${prefix}/${normalized}` : prefix;
}
