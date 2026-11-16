import {
  centsToYuan,
  moneyToCents,
  type AnomalyCode,
  type PaymentAnomalyInput,
  type ContractRow,
  type Finding,
  type ProcedureRow,
  type SettlementRow,
  type PaymentRow,
} from './anomaly-types.ts';

/**
 * 异常预警的**合成评测夹具 + 评分器**（课题 6-9 的 M3 评测）。
 *
 * 为什么要有它：生产库里没有业务单据（见 `docs/AI应用落地计划.md` §2.1），
 * 于是"召回率 90%、误报 ≤ 2"这条验收指标无从度量。这个模块用**确定性随机**
 * 造出「结构真实 + 已知答案」的数据集：每条注入的异常都登记进 ground truth，
 * 规则跑完后按 `(规则码, 命中对象ID)` 对账，得出召回 / 误报 / 漏报样本。
 *
 * 三条设计约束：
 * 1. **纯函数、无 DB、无时钟**：同一个 seed 必须给出同一个数据集，评测才能复现；
 * 2. **注入互不串味**：每条注入只放在自己的合同上，且刻意避免"副产物命中"
 *    （例：给某合同加一笔付款会让付款手续的开累快照失配 → 那条合同的 R6 会连带命中，
 *    于是**注入合同一律不生成付款手续**，付款手续只出现在专用于 R6 的合同上）；
 * 3. **干净合同必须真干净**：金额互不相同（防 R1-a 误命中）、发票与结算等额、
 *    收领单早于结算日、累计付款恰好等于付款比例上限（卡在边界上，验证容差不误报）。
 *
 * 口径与规则层一致：金额一律以「分」为单位经 `moneyToCents` 换算，不写浮点常量。
 */

// ---------------------------------------------------------------------------
// 确定性随机
// ---------------------------------------------------------------------------

/** mulberry32：32 位状态的小 PRNG。用它而不是 Math.random，评测才可复现 */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 取 `[min, max]` 内的整数（含端点） */
function randInt(rnd: () => number, min: number, max: number): number {
  return min + Math.floor(rnd() * (max - min + 1));
}

// ---------------------------------------------------------------------------
// 真值登记
// ---------------------------------------------------------------------------

/** 一条注入异常：评测时按 `(code, entityId)` 与命中结果对账 */
export interface TruthItem {
  code: AnomalyCode;
  /** 期望被报出的对象 ID（R1-a 报"后一张"，所以这里登记后一张） */
  entityId: string;
  contractId: string;
  note: string;
}

export interface SyntheticDataset {
  input: PaymentAnomalyInput;
  truth: TruthItem[];
  meta: {
    seed: number;
    contracts: number;
    periods: number;
    /** 本数据集实际注入的条数（= truth.length，留字段便于报告引用） */
    injected: number;
    /** 注入用到的规则码（去重） */
    codes: AnomalyCode[];
  };
}

// ---------------------------------------------------------------------------
// 数据集生成
// ---------------------------------------------------------------------------

export interface BuildOptions {
  seed?: number;
  /** 合同数（默认 12：8 条注入各占 1 份 + 4 份干净） */
  contracts?: number;
  /** 每份合同的结算期数（默认 5） */
  periods?: number;
}

/** 每期的清单量分配（和为 100 / 50），刻意让各期金额互不相同 */
const QTY1 = [30, 25, 20, 15, 10];
const QTY2 = [15, 10, 10, 10, 5];

const PRICE1 = 100;
const PRICE2 = 50;

/** R1-b 注入：清单量比累计结算量少的量 */
const OVER_QTY = 30;

const day = (month: number, d: number) => `2026-${String(month).padStart(2, '0')}-${String(d).padStart(2, '0')}`;

/**
 * 生成数据集。
 *
 * 注入分配（每个码一份合同，互不重叠）：
 *  - 合同 0：R1-a 跨期重复（第二张金额相同、明细相同、日期更晚）
 *  - 合同 1：R1-b 同物资重复计量（累计结算量 130 > 清单 100）
 *  - 合同 2：R1-c 总结算快照偏离（终期明细金额比月度结算少 100）
 *  - 合同 3：R2 超付（额外一笔付款把累计推到比例上限之上）
 *  - 合同 4：R3 无合同付款（一笔无 `contractId`、一笔指向不存在的合同）
 *  - 合同 5：R4 票款不一致（多开一张发票）
 *  - 合同 6：R5 结算早于收领单（收领单日期晚于结算日）
 *  - 合同 7：R6 付款手续快照偏离（开累付款比台账少 5000）
 *  - 其余：干净合同
 */
export function buildSyntheticDataset(options: BuildOptions = {}): SyntheticDataset {
  const seed = options.seed ?? 20261023;
  const contractCount = options.contracts ?? 12;
  const periods = options.periods ?? 5;
  if (periods > QTY1.length) {
    throw new Error(`periods 最多 ${QTY1.length}（清单量分配表只有这么多档）`);
  }
  const rnd = mulberry32(seed);

  const input: PaymentAnomalyInput = {
    contracts: [],
    settlements: [],
    payments: [],
    invoices: [],
    procedures: [],
    receipts: [],
    finalSettlementItems: [],
    contractMaterials: [],
  };
  const truth: TruthItem[] = [];

  for (let i = 0; i < contractCount; i++) {
    const contractId = `c${String(i + 1).padStart(2, '0')}`;
    const code = `HT-2026-${String(i + 1).padStart(3, '0')}`;
    const m1 = `m${String(i + 1).padStart(2, '0')}-a`;
    const m2 = `m${String(i + 1).padStart(2, '0')}-b`;

    const contract: ContractRow = {
      id: contractId,
      code,
      name: `${code} 物资采购合同`,
      amount: 100_000,
      status: 'SIGNED',
      execStatus: 'EXECUTING',
      // 付款比例 80%：干净合同累计付款恰好等于上限，用于验证容差不误报
      currentPayRatio: 0.8,
    };
    input.contracts.push(contract);

    // —— 各期结算单（金额互不相同，明细两张物资）——
    const settlements: SettlementRow[] = [];
    for (let p = 0; p < periods; p++) {
      const qty1 = QTY1[p];
      const qty2 = QTY2[p];
      const amount = qty1 * PRICE1 + qty2 * PRICE2;
      const settleId = `${contractId}-s${p + 1}`;
      settlements.push({
        id: settleId,
        contractId,
        code: `${code}-JS${p + 1}`,
        amount,
        actualAmount: amount,
        settleDate: day(p + 1, 20),
        statusCode: 'CONFIRMED',
        items: [
          { materialBaseId: m1, qty: qty1, totalWithTax: qty1 * PRICE1 },
          { materialBaseId: m2, qty: qty2, totalWithTax: qty2 * PRICE2 },
        ],
      });
    }
    input.settlements.push(...settlements);

    // —— 付款：累计恰好 = 累计结算 × 80%（边界值，见 r2Overpay 的容差约定）——
    const settledTotal = settlements.reduce((sum, s) => sum + Number(s.amount), 0);
    const limit = Math.floor(settledTotal * 0.8);
    const perPay = Math.floor(limit / periods);
    const payments: PaymentRow[] = [];
    for (let p = 0; p < periods; p++) {
      const amount = p === periods - 1 ? limit - perPay * (periods - 1) : perPay;
      if (amount <= 0) continue;
      payments.push({
        id: `${contractId}-p${p + 1}`,
        contractId,
        amount,
        payDate: day(p + 1, 28),
        payMonth: `2026-${String(p + 1).padStart(2, '0')}`,
        statusCode: 'PAID',
      });
    }
    input.payments.push(...payments);

    // —— 发票与结算等额、收领单早于结算日（干净基线）——
    for (const s of settlements) {
      input.invoices.push({
        id: `${s.id}-inv`,
        settlementId: s.id,
        amountWithTax: s.amount,
        statusCode: 'VERIFIED',
        invoiceNo: `FP-${s.id}`,
      });
      input.receipts!.push({ id: `${s.id}-rc`, settlementId: s.id, orderDate: day(Number(s.settleDate!.toString().slice(5, 7)), 15) });
    }

    // —— 注入（每份合同只注入一种）——
    switch (i) {
      case 0: {
        // R1-a：跨期重复——金额相同、明细重合度 100%、月份更晚
        const dupId = `${contractId}-s${periods + 1}`;
        const base = settlements[0];
        const dup: SettlementRow = {
          ...base,
          id: dupId,
          code: `${code}-JS${periods + 1}`,
          settleDate: day(periods + 1, 20),
          items: (base.items ?? []).map((it) => ({ ...it })),
        };
        input.settlements.push(dup);
        input.invoices.push({
          id: `${dupId}-inv`,
          settlementId: dupId,
          amountWithTax: dup.amount,
          statusCode: 'VERIFIED',
          invoiceNo: `FP-${dupId}`,
        });
        input.receipts!.push({ id: `${dupId}-rc`, settlementId: dupId, orderDate: day(periods + 1, 15) });
        truth.push({
          code: 'R1_DUP_ACROSS_PERIOD',
          entityId: dupId,
          contractId,
          note: '同一合同两个月份的结算单金额相同、明细完全重合',
        });
        break;
      }
      case 1: {
        // R1-b：不新增单据，只把**清单量**裁到比累计结算量少 30（在下方生成清单量时生效）。
        // 这样做避免了"改结算金额 → 连带命中 R4/R2"的串味，单测里另有改单据的定向用例。
        truth.push({
          code: 'R1_DUP_MATERIAL_QTY',
          entityId: contractId,
          contractId,
          note: `物资 ${m1} 累计结算量比清单量多 ${OVER_QTY}`,
        });
        break;
      }
      case 2: {
        // R1-c：总结算明细的快照金额比月度结算少 100（跨过 1 元容差，金额仍为正）
        const s = settlements[1];
        input.finalSettlementItems!.push({
          id: `${contractId}-fsi`,
          finalSettlementId: `${contractId}-fs`,
          settlementId: s.id,
          settleMonth: `2026-${String(2).padStart(2, '0')}`,
          amount: Number(s.amount) - 100,
        });
        truth.push({
          code: 'R1_FINAL_SNAPSHOT_DRIFT',
          // 规则在"金额偏离"分支报的是**被引用的月度结算单 id**（可追溯到要核查的那张单），
          // 只有"未关联/引用不存在"两个分支才报 summary/finalSettlement 侧 id。
          entityId: s.id,
          contractId,
          note: '总结算明细金额 = 月度结算金额 - 100',
        });
        break;
      }
      case 3: {
        // R2：额外一笔付款把累计推到上限之上（合同比例 80%，上限 = 结算总额 × 0.8）
        const extra = 5000 + randInt(rnd, 0, 999);
        const payId = `${contractId}-px`;
        input.payments.push({
          id: payId,
          contractId,
          amount: extra,
          payDate: day(periods, 25),
          payMonth: `2026-${String(periods).padStart(2, '0')}`,
          statusCode: 'PAID',
        });
        truth.push({
          code: 'R2_OVERPAY',
          entityId: contractId,
          contractId,
          note: `累计付款 = 上限 + ${extra}`,
        });
        break;
      }
      case 4: {
        // R3：一笔无合同 + 一笔指向不存在的合同
        const p1 = `${contractId}-pn`;
        const p2 = `${contractId}-pm`;
        input.payments.push(
          { id: p1, contractId: null, amount: 1200, payDate: day(2, 10), payMonth: '2026-02', statusCode: 'PAID' },
          { id: p2, contractId: 'c-not-exist', amount: 800, payDate: day(3, 10), payMonth: '2026-03', statusCode: 'PAID' },
        );
        truth.push(
          { code: 'R3_PAY_WITHOUT_CONTRACT', entityId: p1, contractId, note: '付款未关联合同' },
          { code: 'R3_PAY_WITHOUT_CONTRACT', entityId: p2, contractId, note: '付款指向不在本项目的合同' },
        );
        break;
      }
      case 5: {
        // R4：多开一张发票（合计超出结算金额）
        const s = settlements[2];
        const invId = `${s.id}-inv-extra`;
        input.invoices.push({
          id: invId,
          settlementId: s.id,
          amountWithTax: 666,
          statusCode: 'VERIFIED',
          invoiceNo: `FP-EXTRA-${s.id}`,
        });
        truth.push({ code: 'R4_INVOICE_MISMATCH', entityId: s.id, contractId, note: '发票合计 = 结算金额 + 666' });
        break;
      }
      case 6: {
        // R5：收领单日期晚于结算日
        const s = settlements[3];
        const rc = input.receipts!.find((x) => x.settlementId === s.id)!;
        rc.orderDate = day(Number(s.settleDate!.toString().slice(5, 7)) + 1, 5);
        truth.push({ code: 'R5_SETTLE_BEFORE_RECEIPT', entityId: s.id, contractId, note: '收领单晚于结算日 15 天' });
        break;
      }
      case 7: {
        // R6：付款手续快照的开累付款比台账少 5000
        const payDay = day(periods, 28);
        const snap = liveSumsAt(contractId, input, payDay);
        input.procedures!.push({
          id: `${contractId}-proc`,
          code: `${code}-FK1`,
          contractId,
          settleCumAmount: snap.settled,
          paidCumAmount: snap.paid - 5000,
          payDate: payDay,
        });
        truth.push({
          code: 'R6_PROCEDURE_SNAPSHOT_DRIFT',
          entityId: `${contractId}-proc`,
          contractId,
          note: '手续开累付款比台账少 5000',
        });
        break;
      }
      default: {
        // 干净合同：给一张完全对齐的付款手续单（用来验证 R6 不误报）
        const payDay = day(periods, 28);
        const snap = liveSumsAt(contractId, input, payDay);
        input.procedures!.push({
          id: `${contractId}-proc`,
          code: `${code}-FK1`,
          contractId,
          settleCumAmount: snap.settled,
          paidCumAmount: snap.paid,
          payDate: payDay,
        });
      }
    }

    // —— 合同清单量：按本合同**累计结算量反推**（干净合同天然不触发 R1-b）——
    const settledQtyOf = (materialBaseId: string): number => {
      let total = 0;
      for (const s of input.settlements) {
        if (s.contractId !== contractId || s.statusCode === 'DRAFT') continue;
        for (const it of s.items ?? []) {
          if (it.materialBaseId === materialBaseId) total += Number(it.qty ?? 0);
        }
      }
      return total;
    };
    input.contractMaterials!.push(
      { contractId, materialBaseId: m1, qty: settledQtyOf(m1) - (i === 1 ? OVER_QTY : 0), name: `${code} 钢筋` },
      { contractId, materialBaseId: m2, qty: settledQtyOf(m2), name: `${code} 水泥` },
    );
  }

  return {
    input,
    truth,
    meta: {
      seed,
      contracts: contractCount,
      periods,
      injected: truth.length,
      codes: Array.from(new Set(truth.map((t) => t.code))),
    },
  };
}

/** 某合同在 `payDay` 之前的台账开累（与 R6 的 live 计算同口径，用于造干净快照） */
function liveSumsAt(contractId: string, input: PaymentAnomalyInput, payDay: string): { settled: number; paid: number } {
  let settled = 0;
  for (const s of input.settlements) {
    if (s.contractId !== contractId || s.statusCode === 'DRAFT') continue;
    const d = s.settleDate ? String(s.settleDate) : null;
    if (!d || d > payDay) continue;
    settled += Number(s.actualAmount ?? s.amount ?? 0);
  }
  let paid = 0;
  for (const p of input.payments) {
    if (p.contractId !== contractId) continue;
    if (p.statusCode === 'FAILED' || p.statusCode === 'REFUNDED') continue;
    const d = p.payDate ? String(p.payDate) : null;
    if (d ? d > payDay : (p.payMonth ?? '') > payDay.slice(0, 7)) continue;
    paid += Number(p.amount ?? 0);
  }
  return { settled, paid };
}

// ---------------------------------------------------------------------------
// 评分
// ---------------------------------------------------------------------------

export interface CodeScore {
  code: AnomalyCode;
  injected: number;
  caught: number;
  missed: number;
  /** 该规则报出、但 ground truth 里没有的条数 */
  falsePositives: number;
  recall: number;
  precision: number | null;
}

export interface BenchScore {
  injected: number;
  caught: number;
  missed: number;
  falsePositives: number;
  /** 规则共报出多少条（= caught + falsePositives） */
  reported: number;
  recall: number;
  precision: number | null;
  byCode: CodeScore[];
  /** 漏报样本（给人看：哪条真值没被抓到） */
  missedSamples: TruthItem[];
  /** 误报样本（给人看：报了但没注入的，通常是真规则漏洞或夹具串味） */
  falsePositiveSamples: Finding[];
}

/**
 * 按 `(规则码, 命中对象ID)` 对账。
 *
 * 为什么不做"一个异常对多条命中"的模糊匹配：预警的用途是让人**逐条核查单据**，
 * 报错对象等于报了个查不到的单据，不能算命中。
 */
export function scoreFindings(findings: Finding[], truth: TruthItem[]): BenchScore {
  const byCode = new Map<AnomalyCode, { injected: number; caught: number; fp: number }>();
  const used = new Set<number>();
  const missedSamples: TruthItem[] = [];

  for (const t of truth) {
    const bucket = byCode.get(t.code) ?? { injected: 0, caught: 0, fp: 0 };
    bucket.injected++;
    const hitIndex = findings.findIndex((f, idx) => !used.has(idx) && f.code === t.code && f.entityId === t.entityId);
    if (hitIndex >= 0) {
      used.add(hitIndex);
      bucket.caught++;
    } else {
      missedSamples.push(t);
    }
    byCode.set(t.code, bucket);
  }

  const falsePositiveSamples: Finding[] = [];
  findings.forEach((f, idx) => {
    const bucket = byCode.get(f.code as AnomalyCode) ?? { injected: 0, caught: 0, fp: 0 };
    if (!used.has(idx)) {
      bucket.fp++;
      falsePositiveSamples.push(f);
    }
    byCode.set(f.code as AnomalyCode, bucket);
  });

  const codeScores: CodeScore[] = [...byCode.entries()]
    .map(([code, b]) => ({
      code,
      injected: b.injected,
      caught: b.caught,
      missed: b.injected - b.caught,
      falsePositives: b.fp,
      recall: b.injected === 0 ? 0 : b.caught / b.injected,
      precision: b.caught + b.fp === 0 ? null : b.caught / (b.caught + b.fp),
    }))
    .sort((a, b) => (a.code < b.code ? -1 : 1));

  const injected = truth.length;
  const caught = codeScores.reduce((s, c) => s + c.caught, 0);
  const falsePositives = codeScores.reduce((s, c) => s + c.falsePositives, 0);
  return {
    injected,
    caught,
    missed: injected - caught,
    falsePositives,
    reported: caught + falsePositives,
    recall: injected === 0 ? 1 : caught / injected,
    precision: caught + falsePositives === 0 ? null : caught / (caught + falsePositives),
    byCode: codeScores,
    missedSamples,
    falsePositiveSamples,
  };
}

/** 把评分渲染成一段可贴进评测报告/MR 描述的 Markdown */
export function scoreToMarkdown(score: BenchScore): string {
  const pct = (v: number) => `${(v * 100).toFixed(1)}%`;
  const lines: string[] = [];
  lines.push(`- 注入 ${score.injected} 条，命中 ${score.caught} 条，漏报 ${score.missed} 条，误报 ${score.falsePositives} 条`);
  lines.push(`- 召回率 **${pct(score.recall)}**，准确率 ${score.precision === null ? '—' : pct(score.precision)}`);
  lines.push('');
  lines.push('| 规则码 | 注入 | 命中 | 漏报 | 误报 | 召回 |');
  lines.push('|---|---|---|---|---|---|');
  for (const c of score.byCode) {
    lines.push(`| ${c.code} | ${c.injected} | ${c.caught} | ${c.missed} | ${c.falsePositives} | ${pct(c.recall)} |`);
  }
  if (score.missedSamples.length) {
    lines.push('');
    lines.push('漏报样本：');
    for (const m of score.missedSamples) lines.push(`- ${m.code} · ${m.entityId}（${m.note}）`);
  }
  return lines.join('\n');
}

/** 便于报告引用：数据集规模 */
export function datasetStats(d: SyntheticDataset): Record<string, number> {
  return {
    合同: d.input.contracts.length,
    结算单: d.input.settlements.length,
    付款: d.input.payments.length,
    发票: d.input.invoices.length,
    付款手续: d.input.procedures?.length ?? 0,
    收领单: d.input.receipts?.length ?? 0,
    总结算明细: d.input.finalSettlementItems?.length ?? 0,
    清单物资行: d.input.contractMaterials?.length ?? 0,
    '注入异常': d.truth.length,
  };
}

/** 只给测试用：金额转字符串（保证断言里不出现浮点比较） */
export function yuanOf(v: unknown): string | null {
  const cents = moneyToCents(v);
  return cents === null ? null : centsToYuan(cents);
}
