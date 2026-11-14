import { PrismaClient } from '@prisma/client';
import { notDraft } from '../common/utils/contract-chain';

/**
 * 归档模块的跨域只读查询（Read Model）。
 *
 * 为什么单独一层：
 * - `archive` 是"全库视角"的聚合器，需要读合同/收领单/结算/总结算/发票/成本/财务等 11 个域；
 *   如果直接在 service 里写 `prisma.<任意模型>`，跨域读就会无声扩散、无法审计。
 * - 因此把**跨域读取**集中到这里：`modules/archive/**` 不允许再出现 `prisma.<模型>`，
 *   由 `scripts/check-module-boundaries.mjs` 锁定。
 *
 * 约定：
 * - 只读，不写、不开事务；
 * - 每个函数都显式带 `projectId`（项目隔离铁律）；
 * - 返回**扁平化**的字段，调用方（归档命名/导出）不需要再关心表结构。
 */

const projectSelect = {
  id: true,
  name: true,
  nameAbbr: true,
  settlementStartDate: true,
} as const;

export function archiveProject(prisma: PrismaClient, projectId: string) {
  return prisma.project.findUnique({ where: { id: projectId }, select: projectSelect });
}

/** 合同签章件 + 附件（归档文件名用） */
export async function archiveContracts(prisma: PrismaClient, projectId: string) {
  const rows = await prisma.contract.findMany({
    where: { projectId },
    select: {
      id: true,
      code: true,
      signedFilePath: true,
      signedFileName: true,
      attachments: { select: { fileName: true, url: true } },
    },
  });
  return rows.map((c) => ({
    id: c.id,
    code: c.code,
    signedFilePath: c.signedFilePath,
    signedFileName: c.signedFileName,
    attachments: c.attachments.map((a) => ({ fileName: a.fileName, url: a.url })),
  }));
}

/** 收领单扫描件（附供应商/物资/账期） */
export async function archiveReceiptScans(prisma: PrismaClient, projectId: string) {
  const rows = await prisma.receiptOrder.findMany({
    where: { projectId, scanUrl: { not: null } },
    select: {
      id: true,
      scanUrl: true,
      scanFileName: true,
      orderDate: true,
      settlementId: true,
      materialContractNo: true,
      details: { select: { materialName: true }, take: 1 },
      supplier: { select: { name: true } },
      settlement: { select: { settleDate: true } },
    },
  });
  return rows.map((o) => ({
    id: o.id,
    scanUrl: o.scanUrl,
    scanFileName: o.scanFileName,
    orderDate: o.orderDate,
    settlementId: o.settlementId,
    materialContractNo: o.materialContractNo,
    materialName: o.details[0]?.materialName ?? null,
    supplierName: o.supplier?.name ?? null,
    settleDate: o.settlement?.settleDate ?? null,
  }));
}

/** 非草稿结算单的结算日期（按月归档用） */
export async function archiveMonthlySettlementDates(prisma: PrismaClient, projectId: string) {
  const rows = await prisma.settlement.findMany({
    // `notDraft`（不是 `NOT: {statusCode:'DRAFT'}`）：statusCode 可空，NOT 会连带排除 NULL
    where: { projectId, ...notDraft },
    select: { settleDate: true },
  });
  return rows.map((r) => r.settleDate);
}

/** 总结算单 + 合同/供应商（归档文件名与合规单导出用） */
export async function archiveFinalSettlements(prisma: PrismaClient, projectId: string) {
  const rows = await prisma.finalSettlement.findMany({
    where: { projectId },
    select: {
      id: true,
      code: true,
      attachmentUrl: true,
      attachmentName: true,
      contract: { select: { id: true, name: true, supplier: { select: { name: true } } } },
    },
  });
  return rows.map((f) => ({
    id: f.id,
    code: f.code,
    attachmentUrl: f.attachmentUrl,
    attachmentName: f.attachmentName,
    contractId: f.contract.id,
    contractName: f.contract.name,
    supplierName: f.contract.supplier?.name ?? null,
  }));
}

/** 分包单位领用单据（按单导出三表工作簿） */
export function archiveLaborReceivingDocs(prisma: PrismaClient, projectId: string) {
  return prisma.laborReceivingDoc.findMany({
    where: { projectId },
    orderBy: [{ period: 'asc' }, { subcontractorName: 'asc' }],
    select: { id: true, subcontractorName: true, period: true },
  });
}

/** 带图片的发票（附合同/供应商） */
export async function archiveInvoiceImages(prisma: PrismaClient, projectId: string) {
  const rows = await prisma.invoice.findMany({
    where: { projectId, imageUrl: { not: null } },
    select: {
      id: true,
      imageUrl: true,
      issuer: true,
      settlePeriod: true,
      contract: { select: { id: true, name: true, supplier: { select: { name: true } } } },
    },
  });
  return rows.map((i) => ({
    id: i.id,
    imageUrl: i.imageUrl,
    issuer: i.issuer,
    settlePeriod: i.settlePeriod,
    contractName: i.contract?.name ?? null,
    supplierName: i.contract?.supplier?.name ?? null,
  }));
}

/** 月度盈亏记录（一月一条，按 period 升序） */
export function archiveMonthlyProfitLoss(prisma: PrismaClient, projectId: string) {
  return prisma.monthlyProfitLoss.findMany({
    where: { projectId },
    orderBy: { period: 'asc' },
    select: { id: true, period: true },
  });
}

/** 合同 + 保理/逾期费用条数（决定是否产出对应工作簿） */
export async function archiveContractsWithFinance(prisma: PrismaClient, projectId: string) {
  const contracts = await prisma.contract.findMany({
    where: { projectId },
    select: { id: true, code: true, name: true, supplier: { select: { name: true } } },
  });
  const out = [];
  for (const c of contracts) {
    const [factoring, overdue] = await Promise.all([
      prisma.factoringCost.count({ where: { contractId: c.id } }),
      prisma.overdueInterest.count({ where: { contractId: c.id } }),
    ]);
    out.push({
      id: c.id,
      code: c.code,
      name: c.name,
      supplierName: c.supplier?.name ?? null,
      factoringCount: factoring,
      overdueCount: overdue,
    });
  }
  return out;
}

/** 分包授权台账（签章授权书归档用） */
export function archiveLaborAuthLedgers(prisma: PrismaClient, projectId: string) {
  return prisma.laborAuthLedger.findMany({
    where: { projectId },
    select: { id: true, subcontractorName: true, signedAuthFile: true },
  });
}
