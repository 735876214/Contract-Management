#!/usr/bin/env node
/**
 * 本地文件存储审计（**只读，不删除任何文件**）。
 *
 * 用法（必须在 server 目录执行，且先 build）：
 *   cd server
 *   npm run build
 *   DATABASE_URL="postgresql://..." UPLOAD_DIR="/data/uploads" node scripts/storage-audit.mjs
 *
 * 参数：
 *   --json         输出机器可读 JSON（完整结果）
 *   --limit=50     每类最多展示多少条（默认 50）
 *   --strict       发现 missing / orphans 时退出码 1（供巡检任务使用）
 *
 * 说明：
 * - 读取数据库里所有已知文件字段（键 / `/api/files/...` URL / JSON 内 URL）；
 * - 递归扫描 UPLOAD_DIR，键为相对存储根目录的 POSIX 路径；
 * - 清理由人工确认后手动执行，本脚本不做任何删除。
 */
import { PrismaClient } from '@prisma/client';
import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { buildStorageAudit } from '../dist/src/common/utils/storage-audit.js';
import { resolveUploadRoot } from '../dist/src/common/utils/storage-keys.js';

const args = process.argv.slice(2);
const asJson = args.includes('--json');
const strict = args.includes('--strict');
const limitArg = args.find((a) => a.startsWith('--limit='));
const limit = Math.max(1, Number(limitArg?.split('=')[1] || 50) || 50);

const prisma = new PrismaClient();
const root = resolveUploadRoot(process.env.UPLOAD_DIR);
const refs = [];

const add = (source, id, field, raw) => {
  if (raw === null || raw === undefined || String(raw).trim() === '') return;
  refs.push({ source, id: String(id), field, raw: String(raw) });
};

/** JSON 附件字段：[{fileName,url,size}] 或 [{url}] / [{key}] */
const addJson = (source, id, field, raw) => {
  if (!raw) return;
  let list;
  try {
    list = JSON.parse(String(raw));
  } catch {
    return;
  }
  if (!Array.isArray(list)) return;
  for (const item of list) {
    add(source, id, field, item?.url ?? item?.key ?? item?.fileUrl ?? '');
  }
};

async function walk(dir, prefix = '') {
  const out = [];
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const rel = prefix ? `${prefix}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...(await walk(path.join(dir, e.name), rel)));
    else if (e.isFile()) out.push(rel);
  }
  return out;
}

async function main() {
  // 1) 收集数据库引用
  const contracts = await prisma.contract.findMany({
    where: { signedFilePath: { not: null } },
    select: { id: true, signedFilePath: true },
  });
  contracts.forEach((r) => add('Contract', r.id, 'signedFilePath', r.signedFilePath));

  (await prisma.contractAttachment.findMany({ select: { id: true, contractId: true, url: true } })).forEach((r) =>
    add('ContractAttachment', r.id, 'url', r.url),
  );
  (await prisma.contractTemplate.findMany({ where: { fileUrl: { not: null } }, select: { id: true, fileUrl: true } })).forEach(
    (r) => add('ContractTemplate', r.id, 'fileUrl', r.fileUrl),
  );
  (await prisma.receiptOrder.findMany({ where: { scanUrl: { not: null } }, select: { id: true, scanUrl: true } })).forEach(
    (r) => add('ReceiptOrder', r.id, 'scanUrl', r.scanUrl),
  );
  (
    await prisma.finalSettlement.findMany({
      where: { attachmentUrl: { not: null } },
      select: { id: true, attachmentUrl: true },
    })
  ).forEach((r) => add('FinalSettlement', r.id, 'attachmentUrl', r.attachmentUrl));
  (await prisma.invoice.findMany({ where: { imageUrl: { not: null } }, select: { id: true, imageUrl: true } })).forEach((r) =>
    add('Invoice', r.id, 'imageUrl', r.imageUrl),
  );
  (await prisma.laborAuthLedger.findMany()).forEach((r) => {
    add('LaborAuthLedger', r.id, 'idCardFront', r.idCardFront);
    add('LaborAuthLedger', r.id, 'idCardBack', r.idCardBack);
    add('LaborAuthLedger', r.id, 'signatureScreenshot', r.signatureScreenshot);
    add('LaborAuthLedger', r.id, 'signedAuthFile', r.signedAuthFile);
  });
  (await prisma.procurementBidder.findMany({ where: { bidFileUrl: { not: null } }, select: { id: true, bidFileUrl: true } })).forEach(
    (r) => add('ProcurementBidder', r.id, 'bidFileUrl', r.bidFileUrl),
  );
  (await prisma.paymentRecord.findMany({ where: { receiptUrl: { not: null } }, select: { id: true, receiptUrl: true } })).forEach(
    (r) => add('PaymentRecord', r.id, 'receiptUrl', r.receiptUrl),
  );
  (await prisma.importTask.findMany({ where: { errorFileUrl: { not: null } }, select: { id: true, errorFileUrl: true } })).forEach(
    (r) => add('ImportTask', r.id, 'errorFileUrl', r.errorFileUrl),
  );
  (await prisma.frameworkExplanation.findMany({ select: { id: true, attachments: true } })).forEach((r) =>
    addJson('FrameworkExplanation', r.id, 'attachments', r.attachments),
  );
  (await prisma.preMeetingMinutes.findMany({ select: { id: true, inquirySheets: true } })).forEach((r) =>
    addJson('PreMeetingMinutes', r.id, 'inquirySheets', r.inquirySheets),
  );
  (await prisma.inspectionReport.findMany({ select: { id: true, photos: true } })).forEach((r) =>
    addJson('InspectionReport', r.id, 'photos', r.photos),
  );

  // 2) 扫描磁盘
  const files = await walk(root);

  // 3) 对比
  const result = buildStorageAudit(refs, files);
  const payload = { root, ...result };

  if (asJson) {
    console.log(JSON.stringify(payload, null, 2));
  } else {
    console.log(`本地文件审计（只读）`);
    console.log(`存储根目录: ${root}`);
    console.log(`数据库引用: ${result.referenceCount} 条；磁盘文件: ${result.fileCount} 个`);
    console.log(`缺失引用（库有、盘无）: ${result.missing.length}`);
    result.missing.slice(0, limit).forEach((m) => console.log(`  - ${m.source}#${m.id} ${m.field} → ${m.raw}`));
    if (result.missing.length > limit) console.log(`  … 其余 ${result.missing.length - limit} 条未显示`);
    console.log(`孤儿文件（盘有、库无）: ${result.orphans.length}`);
    result.orphans.slice(0, limit).forEach((k) => console.log(`  - ${k}`));
    if (result.orphans.length > limit) console.log(`  … 其余 ${result.orphans.length - limit} 条未显示`);
    console.log(`重复引用: ${result.duplicates.length}`);
    result.duplicates.slice(0, limit).forEach((d) => console.log(`  - ${d.key}（${d.refs.length} 条）`));
    console.log(`非法引用: ${result.invalid.length}`);
    result.invalid.slice(0, limit).forEach((i) => console.log(`  - ${i.ref.source}#${i.ref.id} ${i.ref.field}: ${i.error}`));
    if (result.missing.length || result.orphans.length) {
      console.log(`\n提示：本脚本只读。确认后可人工删除孤儿文件；缺失引用请恢复文件或修正业务数据。`);
    }
  }

  await prisma.$disconnect();
  if (strict && (result.missing.length || result.orphans.length)) process.exitCode = 1;
}

main().catch(async (e) => {
  console.error('[storage-audit] 执行失败:', e);
  await prisma.$disconnect();
  process.exitCode = 1;
});
