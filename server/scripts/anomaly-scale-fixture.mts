import { PrismaClient } from '@prisma/client';

/**
 * 取数成本的**压测夹具**：造 N 份合同及其配套单据（结算/付款/发票/收领单/手续/总结算/清单）。
 *
 * 只用于「量化 P1-4 第三阶段的取数成本」，见 docs/ai-anomaly-input-cost.md。
 *
 * ⚠️ **只许写到测试库**：库名不含 test/int 时直接拒绝（与 test-integration/helpers.ts 同一道闸门），
 * 避免有人顺手在开发库/生产库上跑出几十万行脏数据。
 *
 * 用法（在 server/ 下）：
 *   DATABASE_URL="postgresql://cms:cms123456@localhost:15432/cms_int?schema=public" \
 *     npm run seed:scale-fixture -- 3000
 */
const prisma = new PrismaClient();

function assertTestDatabase(): void {
  const url = process.env.DATABASE_URL || '';
  if (!url) throw new Error('需要 DATABASE_URL（示例：postgresql://cms:cms123456@localhost:15432/cms_int?schema=public）');
  const dbName = (url.split('/').pop() || '').split('?')[0];
  if (!/test|int/i.test(dbName)) throw new Error('拒绝在疑似正式库上造压测数据：库名「' + dbName + '」必须含 test 或 int');
}
assertTestDatabase();

const N = Number(process.argv[2] || 200);
if (!Number.isFinite(N) || N <= 0 || N > 20000) throw new Error('合同数必须在 1..20000 之间（再大请先扩到独立压测库）');
const code = 'SCALE-' + N + '-' + Date.now().toString(36).toUpperCase();

async function main() {
  const project = await prisma.project.create({ data: { code, name: '压测项目 ' + code } as any });
  const sup = await prisma.supplier.create({ data: { name: '压测供应商 ' + code, projectId: project.id } as any });
  // 共享物资基础库（每个合同 2 行清单）
  const mats = [];
  for (let i = 0; i < 5; i += 1) {
    mats.push(await prisma.materialBase.create({ data: { name: '压测物资' + i + '-' + code, spec: 'φ' + i, categoryLevel1: '建筑材料', unit: '吨(t)', isAsset: false, isSafetyMaterial: false, status: 1 } as any }));
  }

  const t0 = Date.now();
  for (let c = 0; c < N; c += 1) {
    const contract = await prisma.contract.create({
      data: {
        projectId: project.id,
        code: code + '-HT-' + c,
        name: '压测合同 ' + c,
        typeCode: 'PURCHASE',
        status: 'SIGNED',
        supplierId: sup.id,
        amount: 1000000 + c,
        signDate: new Date(2026, 0, 10),
      } as any,
    });
    for (let m = 0; m < 2; m += 1) {
      await prisma.contractMaterial.create({
        data: { contractId: contract.id, materialBaseId: mats[m].id, unit: '吨(t)', qty: 100 + m, priceBeforeTax: 100, taxRatePct: 13, priceWithTax: 113, totalWithTax: 11300, sortOrder: m } as any,
      });
    }
    let firstSettlementId: string | null = null;
    for (let s = 0; s < 3; s += 1) {
      const st = await prisma.settlement.create({
        data: {
          projectId: project.id,
          contractId: contract.id,
          code: code + '-JS-' + c + '-' + s,
          statusCode: 'CONFIRMED',
          amount: 20000 + s,
          deductAmount: 0,
          actualAmount: 20000 + s,
          settleDate: new Date(2026, s, 20),
        } as any,
      });
      if (!firstSettlementId) firstSettlementId = st.id;
      for (let it = 0; it < 2; it += 1) {
        await prisma.settlementItem.create({
          data: { settlementId: st.id, materialBaseId: mats[it].id, qty: 10 + it, totalWithTax: 1130, sortOrder: it } as any,
        });
      }
    }
    for (let p = 0; p < 5; p += 1) {
      await prisma.paymentRecord.create({
        data: {
          projectId: project.id,
          contractId: contract.id,
          statusCode: 'PAID',
          amount: 5000 + p,
          payDate: new Date(2026, p, 15),
          payMonth: '2026-0' + (p + 1),
        } as any,
      });
    }
    for (let v = 0; v < 2; v += 1) {
      await prisma.invoice.create({
        data: {
          projectId: project.id,
          contractId: contract.id,
          settlementId: firstSettlementId,
          invoiceNo: code + '-FP-' + c + '-' + v,
          typeCode: 'VAT_SPECIAL',
          statusCode: 'VERIFIED',
          amountBeforeTax: 10000,
          taxRatePct: 13,
          amountWithTax: 11300,
        } as any,
      });
    }
    for (let r = 0; r < 2; r += 1) {
      await prisma.receiptOrder.create({
        data: {
          projectId: project.id,
          orderNo: code + '-SO-' + c + '-' + r,
          materialContractId: contract.id,
          settlementId: firstSettlementId,
          supplierId: sup.id,
          supplierType: 'SUPPLIER',
          supplyUnitId: sup.id,
          status: 'SAVED',
          orderDate: new Date(2026, r, 5),
        } as any,
      });
    }
    await prisma.paymentProcedure.create({
      data: {
        projectId: project.id,
        contractId: contract.id,
        code: code + '-SX-' + c,
        settleCumAmount: 60000,
        paidCumAmount: 25000,
        unpaidAmount: 35000,
        payDate: new Date(2026, 5, 1),
      } as any,
    });
    const fs1 = await prisma.finalSettlement.create({
      data: { projectId: project.id, contractId: contract.id, statusCode: 'SETTLED', totalAmount: 60000, code: code + '-ZJS-' + c } as any,
    });
    for (let it = 0; it < 2; it += 1) {
      await prisma.finalSettlementItem.create({
        data: { finalSettlementId: fs1.id, settleMonth: '2026-0' + (it + 1), amount: 30000, sortOrder: it } as any,
      });
    }
  }
  console.log(JSON.stringify({ projectId: project.id, code, contracts: N, seedMs: Date.now() - t0 }));
}

main()
  .catch((e) => {
    console.error('seed failed:', e && e.message ? e.message : e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
