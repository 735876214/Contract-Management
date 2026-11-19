#!/usr/bin/env node
/**
 * 历史文件键迁移：`<子目录>/<文件>` → `p/<projectId>/<子目录>/<文件>`（**幂等，可重复执行**）。
 *
 * 背景：2026-11-19 审计 P1 —— 上传/归档的文件键此前不含项目归属，读取端只能「登录即可读」，
 * 任一登录用户拿到键就能跨项目下载。现在新写入的键都带 `p/<projectId>/` 前缀，
 * 存量键需要就地搬迁到同样形态，读取端（`FileServeController`）才能按项目复核成员身份。
 *
 * 用法（必须在 server 目录执行，且先 build）：
 *   cd server
 *   npm run build
 *   DATABASE_URL="postgresql://..." UPLOAD_DIR="/data/uploads" node scripts/storage-migrate.mjs           # 预演
 *   DATABASE_URL="postgresql://..." UPLOAD_DIR="/data/uploads" node scripts/storage-migrate.mjs --apply   # 真搬
 *
 * 规则：
 * - 只搬**能确定归属项目**的引用（行上有 projectId，或能从合同/项目关系推出）；
 * - 磁盘上先把文件复制/改名到新键，再更新数据库字段（先盘后库：任何一步失败都不会出现
 *   「库里指向不存在的文件」）；
 * - 已经带 `p/` 前缀的键跳过；全局资源（合同模板文件、未绑定项目的导入错误文件）跳过；
 * - 找不到文件的引用只报告不改，交给 `storage-audit.mjs` 继续核对。
 */
import { PrismaClient } from '@prisma/client';
import { mkdir, copyFile, stat, unlink } from 'node:fs/promises';
import path from 'node:path';
import { resolveUploadRoot, normalizeStorageKey } from '../dist/src/common/utils/storage-keys.js';

const args = process.argv.slice(2);
const apply = args.includes('--apply');
const prisma = new PrismaClient();
const root = resolveUploadRoot(process.env.UPLOAD_DIR);

/** 数据库里可能存裸键，也可能存 `/api/files/<键>`；拆出裸键并记住原形态 */
function toKey(raw) {
  if (raw === null || raw === undefined) return null;
  const s = String(raw).trim();
  if (!s) return null;
  const m = /^\/api\/files\/(.+)$/.exec(s);
  const key = normalizeStorageKey(m ? m[1] : s);
  return key ? { key, urlForm: Boolean(m) } : null;
}

const refs = [];
const addRef = (model, id, field, raw, projectId) => {
  const parsed = toKey(raw);
  if (!parsed || !projectId) return;
  if (parsed.key.startsWith('p/')) return; // 已迁移
  refs.push({ model, id, field, ...parsed, projectId });
};
const addJsonRefs = (model, id, field, raw, projectId) => {
  if (!raw || !projectId) return;
  let list;
  try {
    list = JSON.parse(String(raw));
  } catch {
    console.warn(`[storage-migrate] 附件 JSON 非法，跳过：${model}#${id}.${field}`);
    return;
  }
  if (!Array.isArray(list)) return;
  for (const item of list) addRef(model, id, field, item?.url ?? item?.key ?? item?.fileUrl, projectId);
};

async function collect() {
  (await prisma.contract.findMany({ where: { signedFilePath: { not: null } }, select: { id: true, projectId: true, signedFilePath: true } }))
    .forEach((r) => addRef('contract', r.id, 'signedFilePath', r.signedFilePath, r.projectId));

  (await prisma.contractAttachment.findMany({ select: { id: true, url: true, contract: { select: { projectId: true } } } }))
    .forEach((r) => addRef('contractAttachment', r.id, 'url', r.url, r.contract?.projectId));

  (await prisma.receiptOrder.findMany({ where: { scanUrl: { not: null } }, select: { id: true, projectId: true, scanUrl: true } }))
    .forEach((r) => addRef('receiptOrder', r.id, 'scanUrl', r.scanUrl, r.projectId));

  (await prisma.invoice.findMany({ where: { imageUrl: { not: null } }, select: { id: true, projectId: true, imageUrl: true } }))
    .forEach((r) => addRef('invoice', r.id, 'imageUrl', r.imageUrl, r.projectId));

  (await prisma.paymentRecord.findMany({ where: { receiptUrl: { not: null } }, select: { id: true, projectId: true, receiptUrl: true } }))
    .forEach((r) => addRef('paymentRecord', r.id, 'receiptUrl', r.receiptUrl, r.projectId));

  (await prisma.finalSettlement.findMany({ where: { attachmentUrl: { not: null } }, select: { id: true, projectId: true, attachmentUrl: true } }))
    .forEach((r) => addRef('finalSettlement', r.id, 'attachmentUrl', r.attachmentUrl, r.projectId));

  (await prisma.procurementBidder.findMany({ where: { bidFileUrl: { not: null } }, select: { id: true, projectId: true, bidFileUrl: true } }))
    .forEach((r) => addRef('procurementBidder', r.id, 'bidFileUrl', r.bidFileUrl, r.projectId));

  (await prisma.laborAuthLedger.findMany())
    .forEach((r) => {
      addRef('laborAuthLedger', r.id, 'idCardFront', r.idCardFront, r.projectId);
      addRef('laborAuthLedger', r.id, 'idCardBack', r.idCardBack, r.projectId);
      addRef('laborAuthLedger', r.id, 'signatureScreenshot', r.signatureScreenshot, r.projectId);
      addRef('laborAuthLedger', r.id, 'signedAuthFile', r.signedAuthFile, r.projectId);
    });

  (await prisma.frameworkExplanation.findMany({ select: { id: true, projectId: true, attachments: true } }))
    .forEach((r) => addJsonRefs('frameworkExplanation', r.id, 'attachments', r.attachments, r.projectId));
  (await prisma.preMeetingMinutes.findMany({ select: { id: true, projectId: true, inquirySheets: true } }))
    .forEach((r) => addJsonRefs('preMeetingMinutes', r.id, 'inquirySheets', r.inquirySheets, r.projectId));
  (await prisma.inspectionReport.findMany({ select: { id: true, projectId: true, photos: true } }))
    .forEach((r) => addJsonRefs('inspectionReport', r.id, 'photos', r.photos, r.projectId));
}

/** 移动磁盘文件：先复制到新键，复制成功后再删旧文件（先盘后库，避免库里指向空文件） */
async function moveFile(fromKey, toKey) {
  const from = path.join(root, fromKey);
  const to = path.join(root, toKey);
  try {
    await stat(from);
  } catch {
    return 'missing';
  }
  await mkdir(path.dirname(to), { recursive: true });
  let exists = true;
  try {
    await stat(to);
  } catch {
    exists = false;
  }
  if (!exists) await copyFile(from, to);
  await unlink(from);
  return 'moved';
}

/** 把引用值按原形态（裸键 / `/api/files/…`）改写成新键 */
function rewrite(raw, newKey) {
  return /^\/api\/files\//.test(String(raw)) ? `/api/files/${newKey}` : newKey;
}

async function applyOne(ref, newKey) {
  const row = await prisma[ref.model].findUnique({ where: { id: ref.id } });
  if (!row) return;
  const raw = row[ref.field];
  if (raw === null || raw === undefined) return;

  if (Array.isArray(raw)) {
    const next = raw.map((item) => {
      if (!item || typeof item !== 'object') return item;
      const v = item.url ?? item.key ?? item.fileUrl;
      const parsed = toKey(v);
      if (!parsed || parsed.key !== ref.key) return item;
      const replaced = rewrite(v, newKey);
      return 'url' in item ? { ...item, url: replaced } : 'key' in item ? { ...item, key: replaced } : { ...item, fileUrl: replaced };
    });
    await prisma[ref.model].update({ where: { id: ref.id }, data: { [ref.field]: next } });
    return;
  }

  const parsed = toKey(raw);
  if (!parsed || parsed.key !== ref.key) return;
  await prisma[ref.model].update({ where: { id: ref.id }, data: { [ref.field]: rewrite(raw, newKey) } });
}

async function main() {
  console.log(`历史文件键迁移${apply ? '（真执行）' : '（预演，加 --apply 才写库）'}`);
  console.log(`存储根目录: ${root}`);
  await collect();

  const uniq = new Map();
  for (const r of refs) uniq.set(`${r.projectId}|${r.key}`, r);
  console.log(`待迁移引用: ${refs.length} 条，去重后 ${uniq.size} 个「项目+键」组合`);

  let moved = 0;
  let missing = 0;
  for (const r of uniq.values()) {
    const newKey = `p/${r.projectId}/${r.key}`;
    if (!apply) {
      console.log(`  [dry] ${r.model}#${r.id}.${r.field}: ${r.key} → ${newKey}`);
      continue;
    }
    const st = await moveFile(r.key, newKey);
    if (st === 'missing') {
      missing += 1;
      console.warn(`  [skip] 磁盘缺少文件: ${r.key}`);
      continue;
    }
    moved += 1;
  }

  if (apply) {
    for (const r of refs) {
      await applyOne(r, `p/${r.projectId}/${r.key}`);
    }
    console.log(`已搬运文件: ${moved} 个；缺失: ${missing} 个；已更新数据库引用: ${refs.length} 条`);
    console.log('提示：迁移后请再跑一次 `node scripts/storage-audit.mjs` 核对 missing/orphans。');
  } else {
    console.log('预演结束。确认无误后加 --apply 执行。');
  }

  await prisma.$disconnect();
}

main().catch(async (e) => {
  console.error('[storage-migrate] 执行失败:', e);
  await prisma.$disconnect();
  process.exitCode = 1;
});
