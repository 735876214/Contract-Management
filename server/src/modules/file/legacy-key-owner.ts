import type { PrismaClient } from '@prisma/client';

/**
 * 历史文件键（**没有 `p/<projectId>/` 前缀**）的归属反查。
 *
 * 2026-11-19 审计 P1 的残留：新上传的键都带项目前缀，读取端按前缀校验项目成员即可；
 * 但审计之前落盘的文件键形如 `2026-10/1730000000-ab12cd.pdf`，**键里没有任何归属信息**，
 * 之前只能「登录即可读」——任一登录用户拿到键就能跨项目下载。
 *
 * 这里用「数据库里还有谁引用这个键」反推归属，把历史键也纳入同一套校验：
 * - 命中一条带 `projectId` 的业务行 → 按该项目校验成员身份；
 * - 命中全局资源（合同模板文件、未绑定项目的导入错误文件）→ 登录即可；
 * - 完全没人引用 → 视为无法确定归属，**拒绝**（不再默认放行）。
 *
 * 成本控制：只在历史键上触发（新键走前缀判断，不查库）；结果做 60s 的进程内缓存，
 * 避免列表页缩略图反复打同一批键。跑过 `server/scripts/storage-migrate.mjs` 之后
 * 历史上项目内的键都会变成 `p/<projectId>/…`，这条路径最终只会剩下全局资源。
 */
export type LegacyKeyOwner = { projectId: string | null };

const CACHE_TTL_MS = 60_000;
const CACHE_MAX = 500;
const cache = new Map<string, { at: number; owner: LegacyKeyOwner | null }>();

/** 数据库里既可能存裸键，也可能存 `/api/files/<键>` 形式的对外 URL */
function candidates(key: string): string[] {
  return [key, `/api/files/${key}`];
}

/**
 * 反查历史键的归属。
 * @returns `null` = 没有任何业务数据引用（无法确定归属）
 */
export async function resolveLegacyKeyOwner(db: PrismaClient, key: string): Promise<LegacyKeyOwner | null> {
  const now = Date.now();
  const hit = cache.get(key);
  if (hit && now - hit.at < CACHE_TTL_MS) return hit.owner;

  const owner = await lookup(db, key);

  if (cache.size >= CACHE_MAX) {
    // 简单淘汰：清掉最旧的一批，避免无界增长
    for (const [k, v] of cache) {
      if (now - v.at >= CACHE_TTL_MS) cache.delete(k);
    }
    if (cache.size >= CACHE_MAX) cache.clear();
  }
  cache.set(key, { at: now, owner });
  return owner;
}

async function lookup(db: PrismaClient, key: string): Promise<LegacyKeyOwner | null> {
  const vals = candidates(key);

  // 1) 带项目归属的业务行（按命中概率与表体量排序）
  const contract = await db.contract.findFirst({
    where: { signedFilePath: { in: vals } },
    select: { projectId: true },
  });
  if (contract) return { projectId: contract.projectId };

  const attachment = await db.contractAttachment.findFirst({
    where: { url: { in: vals } },
    select: { contract: { select: { projectId: true } } },
  });
  if (attachment) return { projectId: attachment.contract.projectId };

  const receipt = await db.receiptOrder.findFirst({
    where: { scanUrl: { in: vals } },
    select: { projectId: true },
  });
  if (receipt) return { projectId: receipt.projectId };

  const invoice = await db.invoice.findFirst({ where: { imageUrl: { in: vals } }, select: { projectId: true } });
  if (invoice) return { projectId: invoice.projectId };

  const payment = await db.paymentRecord.findFirst({
    where: { receiptUrl: { in: vals } },
    select: { projectId: true },
  });
  if (payment) return { projectId: payment.projectId };

  const final = await db.finalSettlement.findFirst({
    where: { attachmentUrl: { in: vals } },
    select: { projectId: true },
  });
  if (final) return { projectId: final.projectId };

  const bidder = await db.procurementBidder.findFirst({
    where: { bidFileUrl: { in: vals } },
    select: { projectId: true },
  });
  if (bidder) return { projectId: bidder.projectId };

  const labor = await db.laborAuthLedger.findFirst({
    where: {
      OR: [
        { idCardFront: { in: vals } },
        { idCardBack: { in: vals } },
        { signatureScreenshot: { in: vals } },
        { signedAuthFile: { in: vals } },
      ],
    },
    select: { projectId: true },
  });
  if (labor) return { projectId: labor.projectId };

  // 2) 全局资源：合同模板文件（模板不属任何项目）
  const template = await db.contractTemplate.findFirst({ where: { fileUrl: { in: vals } }, select: { id: true } });
  if (template) return { projectId: null };

  // 3) 导入错误文件：绑定项目就按项目校验，没绑项目（历史任务）按全局处理
  const importTask = await db.importTask.findFirst({
    where: { errorFileUrl: { in: vals } },
    select: { projectId: true },
  });
  if (importTask) return { projectId: importTask.projectId ?? null };

  return null;
}

/** 仅供测试/运维使用：清空反查缓存 */
export function clearLegacyKeyOwnerCache(): void {
  cache.clear();
}
