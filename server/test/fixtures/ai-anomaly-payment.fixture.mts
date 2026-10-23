/**
 * AI 预警 · 结算/付款异常（6-9）—— **测试夹具（D 日数据真值）**。
 *
 * == 这个文件为什么存在 ==
 * 计划 `docs/AI应用落地计划.md` §4.1 的 D 日：把规则做成**一条命令可跑的真值测试**，
 * 让业务/审核方核的是「命中判据」而不是我的口头说明。做法不是「复制一份生产数据」，
 * 而是**按字段逐个构造**一个覆盖 8 条规则的数据集 —— 每个对象都对应一个真实业务场景，
 * 并在这里写明「它为什么该被命中 / 为什么不该」。任何后续改阈值的动作都会先撞到这份夹具，
 * 从而必须显式确认「这次改动会让哪类命中消失」。
 *
 * == 编排（同一份数据里既有脏也有净）==
 * - 脏：跨期重复结算、同物资超结、总结算快照偏离、超付、无合同付款、票款不一致、
 *   结算早于收领单、手续开累偏离 —— 8 条规则各至少一条命中；
 * - 净：`cleanPaymentFixture()` 是一份「账、票、手续全对」的同构数据，必须 **0 命中**
 *   —— 防误报比防漏报更重要：财务面板一次误报就会失去信任。
 *
 * == 用法 ==
 * ```ts
 * import { paymentAnomalyFixture, cleanPaymentFixture } from './fixtures/ai-anomaly-payment.fixture.mts';
 * const { input, expected } = paymentAnomalyFixture();
 * ```
 * 夹具**不含任何 IO**，也不依赖 Prisma 类型：只构造 `PaymentAnomalyInput` 的结构化子集。
 */

import type {
  PaymentAnomalyInput,
  SettlementRow,
  PaymentRow,
  InvoiceRow,
  ProcedureRow,
  ReceiptRow,
  FinalSettlementItemRow,
  MaterialQtyRow,
  ContractRow,
} from '../../src/modules/ai/anomaly/anomaly-types.ts';
import { ANOMALY_CODES, type AnomalyCode } from '../../src/modules/ai/anomaly/anomaly-types.ts';

/** 本地时区日期（不用 'YYYY-MM-DD' 字符串：后者按 UTC 解析，跨时区会把日/月挪一位） */
const d = (y: number, m: number, day: number): Date => new Date(y, m - 1, day, 0, 0, 0, 0);

/** 模拟 Prisma `Decimal`：只有 `toString()` 才参与金额解析（绝经浮点） */
const dec = (v: string) => ({ toString: () => v });

export interface AnomalyFixtureCase {
  input: PaymentAnomalyInput;
  expected: {
    /** 期望命中总数 */
    total: number;
    high: number;
    medium: number;
    byCode: Partial<Record<AnomalyCode, number>>;
    /** 期望出现在 `notEvaluated` 里的片段（用于锁「缺口径必须说出来」） */
    notEvaluatedIncludes: string[];
  };
}

// ---------------------------------------------------------------------------
// 脏数据：8 条规则各至少一条命中
// ---------------------------------------------------------------------------

/**
 * 场景表（每行都是夹具里真实存在的一组对象）：
 *
 * | 编号 | 场景 | 期望 |
 * |------|------|------|
 * | C1 | HT-2026-001 已签章，付款比例 80% | 参与 R2/R6 |
 * | C2 | HT-2026-002 仍是草稿（未签章），无付款比例 | R3 命中 + R2 记 notEvaluated |
 * | S1 | 2026-03 结算 100,000（M1×100、M2×50） | 与 S2 构成 R1-a |
 * | S2 | 2026-04 结算 100,000（同批物资） | R1-a 命中（后一张报 S2） |
 * | S3 | 2026-05 结算 50,000（M1×200） | 推 M1 累计 400 > 清单 300 → R1-b；票 45,000 → R4；收领单 06-05 → R5 |
 * | S4 | 草稿结算 1,000,000 | 不计入任何累计（锁 DRAFT 排除） |
 * | P1 | 2026-04-10 付 200,000 | R2 超付主体；PR1 快照比它小 50,000 → R6 |
 * | P2 | 2026-05-20 付 30,000 | R2 累计 |
 * | P3 | 无合同付款 50,000 | R3 高风险 |
 * | P4 | 挂未签章合同 C2 付款 10,000 | R3 需复核 |
 * | P5 | 挂不存在合同 20,000 | R3 需复核 |
 * | P6 | 状态 FAILED 付款 99,999 | 不计入累计（锁失败付款排除） |
 * | I1/I2 | S1 两张发票 60,000+40,000 | 合计 100,000 = 结算额 → 不命中 |
 * | I3 | S1 作废发票 999,999 | 不参与比较（锁作废排除） |
 * | I4 | S3 一张发票 45,000 | R4 命中（差 5,000） |
 * | R1/R2 | 收领单：S1@03-05、S3@06-05 | S1 正常；S3 命中 R5 |
 * | PR1 | 手续单开累结算 100,000 / 开累付款 150,000 @04-10 | 实时应为 100,000 / 200,000 → R6 |
 * | PR2 | 手续单开累结算 250,000 / 开累付款 230,000 @05-31 | 与实时一致 → 不命中 |
 * | FS1 | 总结算单明细引用 S3，金额 40,000 | S3 当前 50,000 → R1-c |
 */
export function paymentAnomalyFixture(): AnomalyFixtureCase {
  const contracts: ContractRow[] = [
    { id: 'C1', code: 'HT-2026-001', name: '一号主合同', amount: dec('1000000.00'), status: 'SIGNED', currentPayRatio: dec('0.8') },
    // 未签章 + 没有付款比例：既测 R3，也测「R2 缺口径必须记 notEvaluated」
    { id: 'C2', code: 'HT-2026-002', name: '二号草稿合同', amount: dec('200000.00'), status: 'DRAFT', currentPayRatio: null },
  ];

  const settlements: SettlementRow[] = [
    {
      id: 'S1',
      contractId: 'C1',
      code: 'JS-2026-03',
      actualAmount: dec('100000.00'),
      settleDate: d(2026, 3, 31),
      statusCode: 'CONFIRMED',
      items: [
        { materialBaseId: 'M1', qty: dec('100.0000'), totalWithTax: dec('70000.00') },
        { materialBaseId: 'M2', qty: dec('50.0000'), totalWithTax: dec('30000.00') },
      ],
    },
    {
      id: 'S2',
      contractId: 'C1',
      code: 'JS-2026-04',
      actualAmount: 100000, // number 形式也要能解析（历史导入数据里有 number）
      settleDate: d(2026, 4, 30),
      statusCode: 'CONFIRMED',
      items: [
        { materialBaseId: 'M1', qty: dec('100.0000'), totalWithTax: dec('70000.00') },
        { materialBaseId: 'M2', qty: dec('50.0000'), totalWithTax: dec('30000.00') },
      ],
    },
    {
      id: 'S3',
      contractId: 'C1',
      code: 'JS-2026-05',
      actualAmount: dec('50000.00'),
      settleDate: d(2026, 5, 31),
      statusCode: 'CONFIRMED',
      items: [{ materialBaseId: 'M1', qty: dec('200.0000'), totalWithTax: dec('50000.00') }],
    },
    {
      // 草稿：金额巨大，一旦被计入任何累计都会把结论彻底带偏 —— 用来锁「DRAFT 排除」
      id: 'S4',
      contractId: 'C1',
      code: 'JS-2026-06-DRAFT',
      actualAmount: dec('1000000.00'),
      settleDate: d(2026, 6, 30),
      statusCode: 'DRAFT',
      items: [{ materialBaseId: 'M1', qty: dec('9999.0000'), totalWithTax: dec('1000000.00') }],
    },
  ];

  const payments: PaymentRow[] = [
    { id: 'P1', contractId: 'C1', amount: dec('200000.00'), payDate: d(2026, 4, 10), statusCode: 'PAID' },
    { id: 'P2', contractId: 'C1', amount: dec('30000.00'), payDate: d(2026, 5, 20), statusCode: 'PAID' },
    { id: 'P3', contractId: null, amount: dec('50000.00'), payDate: d(2026, 5, 6), statusCode: 'PAID' },
    { id: 'P4', contractId: 'C2', amount: dec('10000.00'), payDate: d(2026, 5, 8), statusCode: 'PAID' },
    { id: 'P5', contractId: 'C-missing', amount: dec('20000.00'), payDate: d(2026, 5, 9), statusCode: 'PAID' },
    { id: 'P6', contractId: 'C1', amount: dec('99999.00'), payDate: d(2026, 5, 10), statusCode: 'FAILED' },
  ];

  const invoices: InvoiceRow[] = [
    { id: 'I1', settlementId: 'S1', amountWithTax: dec('60000.00'), statusCode: 'VERIFIED', invoiceNo: 'FP-001' },
    { id: 'I2', settlementId: 'S1', amountWithTax: dec('40000.00'), statusCode: 'VERIFIED', invoiceNo: 'FP-002' },
    // 作废发票：若参与比较会让 S1 变成「票大于款」的假命中
    { id: 'I3', settlementId: 'S1', amountWithTax: dec('999999.00'), statusCode: 'CANCELLED', invoiceNo: 'FP-VOID' },
    { id: 'I4', settlementId: 'S3', amountWithTax: dec('45000.00'), statusCode: 'VERIFIED', invoiceNo: 'FP-004' },
  ];

  const receipts: ReceiptRow[] = [
    { id: 'R1', settlementId: 'S1', orderDate: d(2026, 3, 5) },
    // 收领单晚于结算单（06-05 > 05-31）→ R5
    { id: 'R2', settlementId: 'S3', orderDate: d(2026, 6, 5) },
  ];

  const procedures: ProcedureRow[] = [
    { id: 'PR1', code: 'SX-2026-04-01', contractId: 'C1', settleCumAmount: dec('100000.00'), paidCumAmount: dec('150000.00'), payDate: d(2026, 4, 10) },
    // 截止 05-20：结算 250,000 / 付款 230,000，与快照完全一致 → 不该命中
    { id: 'PR2', code: 'SX-2026-05-01', contractId: 'C1', settleCumAmount: dec('250000.00'), paidCumAmount: dec('230000.00'), payDate: d(2026, 5, 31) },
  ];

  const finalSettlementItems: FinalSettlementItemRow[] = [
    { id: 'FSI1', finalSettlementId: 'FS1', settlementId: 'S3', settleMonth: '2026-05', amount: dec('40000.00') },
    // 快照与 S1 一致 → 不该命中
    { id: 'FSI2', finalSettlementId: 'FS1', settlementId: 'S1', settleMonth: '2026-03', amount: dec('100000.00') },
  ];

  // 合同链清单量（C1）：M1 300、M2 100 —— 已结 M1 = 100+100+200 = 400 → 超 100（33.3%）
  const contractMaterials: MaterialQtyRow[] = [
    { contractId: 'C1', materialBaseId: 'M1', qty: dec('300.0000'), name: '螺纹钢 HRB400 Φ20' },
    { contractId: 'C1', materialBaseId: 'M2', qty: dec('100.0000'), name: '商品混凝土 C30' },
  ];

  return {
    input: {
      contracts,
      settlements,
      payments,
      invoices,
      procedures,
      receipts,
      finalSettlementItems,
      contractMaterials,
    },
    expected: {
      total: 10,
      high: 3,
      medium: 7,
      byCode: {
        [ANOMALY_CODES.R1_DUP_ACROSS_PERIOD]: 1,
        [ANOMALY_CODES.R1_DUP_MATERIAL_QTY]: 1,
        [ANOMALY_CODES.R1_FINAL_SNAPSHOT_DRIFT]: 1,
        [ANOMALY_CODES.R2_OVERPAY]: 1,
        [ANOMALY_CODES.R3_PAY_WITHOUT_CONTRACT]: 3,
        [ANOMALY_CODES.R4_INVOICE_MISMATCH]: 1,
        [ANOMALY_CODES.R5_SETTLE_BEFORE_RECEIPT]: 1,
        [ANOMALY_CODES.R6_PROCEDURE_SNAPSHOT_DRIFT]: 1,
      },
      notEvaluatedIncludes: ['R2 未判定：HT-2026-002'],
    },
  };
}

// ---------------------------------------------------------------------------
// 净数据：账、票、手续全对 → 必须 0 命中
// ---------------------------------------------------------------------------

/**
 * 干净的同一套结构：单张结算单、付款**恰好等于**比例上限、发票合计等于结算额、
 * 收领单早于结算日、手续单快照与台账一致、已结量等于清单量（在容差内）。
 *
 * 这里的每个「恰好」都是刻意的边界：
 * - 付款 = 上限 → 不算超付（`amount-guard` 的既有口径：等于上限不算超）；
 * - 已结量 = 清单量 → 不算超结（容差只允许上浮，不允许把 100% 判成超标）。
 */
export function cleanPaymentFixture(): AnomalyFixtureCase {
  const contracts: ContractRow[] = [
    { id: 'C1', code: 'HT-2026-001', name: '一号主合同', amount: dec('1000000.00'), status: 'SIGNED', currentPayRatio: dec('0.8') },
  ];
  const settlements: SettlementRow[] = [
    {
      id: 'S1',
      contractId: 'C1',
      code: 'JS-2026-03',
      actualAmount: dec('100000.00'),
      settleDate: d(2026, 3, 31),
      statusCode: 'CONFIRMED',
      items: [{ materialBaseId: 'M1', qty: dec('100.0000'), totalWithTax: dec('100000.00') }],
    },
  ];
  const payments: PaymentRow[] = [
    // 100,000 × 80% = 80,000：恰好等于上限
    { id: 'P1', contractId: 'C1', amount: dec('80000.00'), payDate: d(2026, 4, 10), statusCode: 'PAID' },
  ];
  const invoices: InvoiceRow[] = [
    { id: 'I1', settlementId: 'S1', amountWithTax: dec('60000.00'), statusCode: 'VERIFIED', invoiceNo: 'FP-001' },
    { id: 'I2', settlementId: 'S1', amountWithTax: dec('40000.00'), statusCode: 'VERIFIED', invoiceNo: 'FP-002' },
  ];
  const receipts: ReceiptRow[] = [{ id: 'R1', settlementId: 'S1', orderDate: d(2026, 3, 5) }];
  const procedures: ProcedureRow[] = [
    { id: 'PR1', code: 'SX-2026-04-01', contractId: 'C1', settleCumAmount: dec('100000.00'), paidCumAmount: dec('80000.00'), payDate: d(2026, 4, 10) },
  ];
  const finalSettlementItems: FinalSettlementItemRow[] = [
    { id: 'FSI1', finalSettlementId: 'FS1', settlementId: 'S1', settleMonth: '2026-03', amount: dec('100000.00') },
  ];
  const contractMaterials: MaterialQtyRow[] = [
    { contractId: 'C1', materialBaseId: 'M1', qty: dec('100.0000'), name: '螺纹钢 HRB400 Φ20' },
  ];

  return {
    input: { contracts, settlements, payments, invoices, procedures, receipts, finalSettlementItems, contractMaterials },
    expected: { total: 0, high: 0, medium: 0, byCode: {}, notEvaluatedIncludes: [] },
  };
}
