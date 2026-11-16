/**
 * 项目资料归档的**命名与目录纯逻辑**（附件需求 2026-10-17）。
 *
 * 为什么单独抽零依赖文件：命名规则错了会让归档包「看起来对、实际对不上业务」
 * （如发票的账期取错字段、重名覆盖），且这些规则要被 `archiveNaming.spec.mts` 直接加载锁定
 * （`.mts` 硬约束：零相对 import）。IO（查库、读文件、zip）在 `archive.service.ts`。
 *
 * 口径（业务 2026-10-17 逐条确认）：
 * - 目录第一段 = `Project.nameAbbr`（文字版简称），为空回退 `name`；
 * - 收领单/发票 = `供应商-物资-结算账期-单据名.pdf`（**图片统一转单页 PDF**，扩展名固定 .pdf）；
 * - 月度结算单/总结算书是 **Excel**（系统数据导出，不是上传附件）；
 * - 分包领用按分包商分目录、盈亏分析按账期导出；
 * - 重名自动追加 `(2)`；空目录放 `_说明.txt`（占位可见）。
 */

/** 收集到的单个文件（IO 前的中间形态） */
export interface ArchiveFile {
  /** ZIP 内相对路径（已含项目简称与目录序号，POSIX `/` 分隔） */
  zipPath: string;
  /** 原始显示名（entries 接口给前端看） */
  fileName: string;
  /** StorageService 键（真实落盘文件）；Excel 动态生成时为空 */
  storageKey?: string;
  /** 动态生成的内容（Excel）；真实文件时为空 */
  buffer?: Buffer;
  /** 图片转 PDF：storageKey 指向 jpg/png 时为 true（service 读出后调 imageToPdf） */
  isImage?: boolean;
}

/** 归档目录分类（注册表；与 `archiveCategories.ts` 配套） */
export interface ArchiveCategory {
  key: string;
  /** ZIP 内目录（相对项目根，POSIX `/`，带序号前缀） */
  dir: string;
  label: string;
}

/** 项目简称段：nameAbbr 为空回退 name；再为空用「未命名项目」 */
export function projectRootOf(nameAbbr: string | null | undefined, name: string | null | undefined): string {
  return sanitizeSegment(nameAbbr || name || '未命名项目');
}

/** 目录段清洗：ZIP 路径非法字符（`\/:*?"<>|`）替换为 `_`，去首尾空白与点 */
export function sanitizeSegment(input: string): string {
  return String(input || '')
    .replace(/[\\/:*?"<>|]/g, '_')
    .replace(/^[\s.]+|[\s.]+$/g, '')
    .trim() || '_';
}

/** 从 StorageService 键/URL 提取扩展名（含点，小写；无扩展名返回 ''） */
export function extOf(keyOrName: string): string {
  const name = String(keyOrName || '').split('/').pop() || '';
  const i = name.lastIndexOf('.');
  return i < 0 ? '' : name.slice(i).toLowerCase();
}

/**
 * 「供应商-物资-结算账期-单据名」式命名（收领单/发票）。
 * ⚠️ 图片统一转单页 PDF：无论原文件是 jpg/png 还是 pdf，**扩展名一律 .pdf**（修正 5）。
 * 各段缺省时段位用 `-` 占位（保持"四段式"结构可读，与需求举例一致）。
 */
export function businessFileName(
  parts: { supplier?: string | null; material?: string | null; period?: string | null; docName: string },
  forcePdf: boolean,
): string {
  const seg = (v: string | null | undefined) => sanitizeSegment(v || '-') || '-';
  const base = `${seg(parts.supplier)}-${seg(parts.material)}-${seg(parts.period)}-${sanitizeSegment(parts.docName)}`;
  return `${base}.pdf`;
}

/**
 * 「供应商-物资-结算账期-单据名」式命名，但**保留真实扩展名**。
 *
 * 用于收领单/发票里**不能转 PDF** 的附件（如 docx、gif/webp/bmp）：`businessFileName()` 恒输出 .pdf，
 * 而这些文件会原样打包（`imageToPdf` 回退），若仍叫 .pdf 就会出现「名字是 PDF、内容是 Word/PNG」打不开的文件。
 */
export function businessFileNameKeepExt(
  parts: { supplier?: string | null; material?: string | null; period?: string | null; docName: string },
  originalName: string | null | undefined,
): string {
  const seg = (v: string | null | undefined) => sanitizeSegment(v || '-') || '-';
  const base = `${seg(parts.supplier)}-${seg(parts.material)}-${seg(parts.period)}-${sanitizeSegment(parts.docName)}`;
  return `${base}${extOf(originalName || '') || '.bin'}`;
}

/** 非图片附件的命名：保留原扩展名，主体可带前缀（如 `合同编号-文件名`） */
export function prefixedFileName(prefix: string, originalName: string): string {
  const ext = extOf(originalName);
  const base = sanitizeSegment(originalName.slice(0, originalName.length - ext.length)) || '附件';
  return `${sanitizeSegment(prefix)}-${base}${ext}`;
}

/** 重名消解：已存在同名路径时追加 (2)、(3)…（保留扩展名） */
export function dedupePath(existing: Set<string>, desired: string): string {
  if (!existing.has(desired)) return desired;
  const i = desired.lastIndexOf('.');
  const base = i < 0 ? desired : desired.slice(0, i);
  const ext = i < 0 ? '' : desired.slice(i);
  let n = 2;
  while (existing.has(`${base}(${n})${ext}`)) n += 1;
  return `${base}(${n})${ext}`;
}

/** 空目录的占位说明文件名 */
export const PLACEHOLDER_NAME = '_说明.txt';

/** 占位说明文案（让包内目录结构与需求一致、空目录可见） */
export function placeholderText(dir: string, label: string): string {
  return `该目录（${dir}）由「${label}」提供数据。\r\n当前暂无文件：对应模块尚未录入数据或未上传附件。\r\n`;
}

/** 账期目录段：`2026.1` → `2026年1月`（需求举例 `月度结算单/2026年1月/…`） */
export function periodDirOf(period: string | null | undefined): string {
  const raw = String(period || '').trim();
  const m = raw.match(/^(\d{4})[.\-/年]\s*(\d{1,2})/);
  if (m) return `${m[1]}年${Number(m[2])}月`;
  return sanitizeSegment(raw || '未分账期');
}

/** 图片 → 单页 PDF 后的 ZIP 文件名（收领单/发票专用：强制 .pdf） */
export function imagePdfName(
  parts: { supplier?: string | null; material?: string | null; period?: string | null; docName: string },
): string {
  return businessFileName(parts, true);
}
