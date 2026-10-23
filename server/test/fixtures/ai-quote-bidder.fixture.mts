/**
 * 课题 3-9（采购报价与价差）**真值夹具**：注入已知异常 + 一条干净任务。
 *
 * 与 6-9 的 `ai-anomaly-payment.fixture.mts` 同一思路：夹具是**真值的唯一出处**，
 * 报告里的 12 条命中、2 高 / 10 需复核、按码分布都从这里数出来；改夹具必须改 spec。
 *
 * 设计原则（每条只触发它想触发的那一条，否则「命中率」是玄学）：
 * - 报价离散度只在 T2 触发 → 其余任务的四家首轮报价刻意拉开 ≥5%；
 * - 单行超控制价只在 T2 → 其余任务成交单价一律不高于控制价；
 * - 成交价显著低于控制价只在 T3 → 其余任务成交价都在 70%~100% 之间；
 * - 税率异常只在 T3 → 其余任务税额一律按 13% 精确反算。
 */

import type { QuoteTaskInput } from '../../src/modules/ai/quote/quote-types.ts';

/**
 * 脏夹具：5 个任务、12 条注入异常（2 HIGH / 10 MEDIUM）。
 *
 * | 任务 | 注入 |
 * |---|---|
 * | HT-CG-2026-001 | B1 降幅超阈值、B1 二轮倒挂 |
 * | HT-CG-2026-002 | B2 报价高度一致、B3 超控制价、B4 单行超控制价、B6 非最低价中标 |
 * | HT-CG-2026-003 | B3 显著低于控制价、B4 单价偏离市场价、B5 两轮税率漂移、B5 税率不在集合 |
 * | HT-CG-2026-004 | B7 家数不足、B7 中标单位无报价 |
 * | HT-CG-2026-005 | （干净，0 命中） |
 */
export function quoteAnomalyFixture(): QuoteTaskInput[] {
  return [
    // ---------------------------------------------------------------- T1
    {
      task: { id: 'task-q-001', taskNo: 'HT-CG-2026-001', name: '钢筋采购' },
      items: [
        { id: 'ti-001', materialBaseId: 'mb-001', materialName: '钢筋', spec: 'HRB400-20', unit: 't', qty: 100, planPrice: 1000, marketPrice: 950, infoPrice: 980 },
        { id: 'ti-002', materialBaseId: 'mb-002', materialName: '水泥', spec: 'P.O42.5', unit: 't', qty: 200, planPrice: 500, marketPrice: 520, infoPrice: 510 },
      ],
      bidders: [
        // 降幅 25% > 20% → B1_DROP_EXCESS
        { id: 'bd-001', taskId: 'task-q-001', bidderName: '甲公司', seq: 1, status: 'WON', passedFirst: '是', firstPreTaxTotal: 240000, firstTax: 31200, secondPreTaxTotal: 180000, secondTax: 23400 },
        // 二轮高于一轮 → B1_DROP_INVERTED
        { id: 'bd-002', taskId: 'task-q-001', bidderName: '乙公司', seq: 2, passedFirst: '是', firstPreTaxTotal: 235000, firstTax: 30550, secondPreTaxTotal: 238000, secondTax: 30940 },
        { id: 'bd-003', taskId: 'task-q-001', bidderName: '丙公司', seq: 3, passedFirst: '是', firstPreTaxTotal: 230000, firstTax: 29900, secondPreTaxTotal: 218000, secondTax: 28340 },
        { id: 'bd-004', taskId: 'task-q-001', bidderName: '丁公司', seq: 4, passedFirst: '是', firstPreTaxTotal: 205000, firstTax: 26650 },
      ],
      compareItems: [
        { materialBaseId: 'mb-001', materialName: '钢筋', spec: 'HRB400-20', unit: 't', qty: 100, planPrice: 1000, marketPrice: 950, dealPrice: 980 },
        { materialBaseId: 'mb-002', materialName: '水泥', spec: 'P.O42.5', unit: 't', qty: 200, planPrice: 500, marketPrice: 520, dealPrice: 500 },
      ],
    },
    // ---------------------------------------------------------------- T2
    {
      task: { id: 'task-q-002', taskNo: 'HT-CG-2026-002', name: '周转材料租赁' },
      items: [
        { id: 'ti-011', materialBaseId: 'mb-011', materialName: '钢管', spec: 'φ48×3.0', unit: 'm', qty: 50, planPrice: 2000, marketPrice: 2100, infoPrice: 2050 },
      ],
      bidders: [
        // 成交价 105000 > 控制价 100000 → B3_OVER_BUDGET；同时高于最低价 104000 → B6_NOT_LOWEST
        { id: 'bd-011', taskId: 'task-q-002', bidderName: '甲公司', seq: 1, status: 'WON', passedFirst: '是', firstPreTaxTotal: 105600, firstTax: 13728, secondPreTaxTotal: 105000, secondTax: 13650 },
        { id: 'bd-012', taskId: 'task-q-002', bidderName: '乙公司', seq: 2, passedFirst: '是', firstPreTaxTotal: 104800, firstTax: 13624, secondPreTaxTotal: 104000, secondTax: 13520 },
        { id: 'bd-013', taskId: 'task-q-002', bidderName: '丙公司', seq: 3, passedFirst: '是', firstPreTaxTotal: 105100, firstTax: 13663 },
        { id: 'bd-014', taskId: 'task-q-002', bidderName: '丁公司', seq: 4, passedFirst: '是', firstPreTaxTotal: 104900, firstTax: 13637 },
      ],
      // 四家首轮报价离散系数 0.29% < 3% → B2_SPREAD_TOO_LOW；成交单价 2200 > 控制价 2000 → B4_PRICE_OVER_CONTROL
      compareItems: [
        { materialBaseId: 'mb-011', materialName: '钢管', spec: 'φ48×3.0', unit: 'm', qty: 50, planPrice: 2000, marketPrice: 2100, dealPrice: 2200 },
      ],
    },
    // ---------------------------------------------------------------- T3
    {
      task: { id: 'task-q-003', taskNo: 'HT-CG-2026-003', name: '零星材料' },
      items: [
        { id: 'ti-021', materialBaseId: 'mb-021', materialName: '防水卷材', spec: 'SBS-3mm', unit: 'm2', qty: 100, planPrice: 1000, marketPrice: 600, infoPrice: 620 },
        { id: 'ti-022', materialBaseId: 'mb-022', materialName: '保温板', spec: 'XPS-50', unit: 'm3', qty: 100, planPrice: 1000, marketPrice: 620, infoPrice: 610 },
      ],
      bidders: [
        // final 130000 / 控制价 200000 = 65% < 70% → B3_UNDER_BUDGET；两轮税率 13%→9% → B5_TAX_RATE_DRIFT
        { id: 'bd-021', taskId: 'task-q-003', bidderName: '甲公司', seq: 1, status: 'WON', passedFirst: '是', firstPreTaxTotal: 190000, firstTax: 24700, secondPreTaxTotal: 185000, secondTax: 16650, finalPreTaxTotal: 130000 },
        { id: 'bd-022', taskId: 'task-q-003', bidderName: '乙公司', seq: 2, passedFirst: '是', firstPreTaxTotal: 188000, firstTax: 24440 },
        // 税额 30000 / 192000 = 15.63% → B5_TAX_RATE_INVALID
        { id: 'bd-023', taskId: 'task-q-003', bidderName: '丙公司', seq: 3, passedFirst: '是', firstPreTaxTotal: 192000, firstTax: 30000 },
        { id: 'bd-024', taskId: 'task-q-003', bidderName: '丁公司', seq: 4, passedFirst: '是', firstPreTaxTotal: 150000, firstTax: 19500 },
      ],
      // 成交单价 700 vs 市场价 600 → +16.67% > 15% → B4_PRICE_VS_MARKET
      compareItems: [
        { materialBaseId: 'mb-021', materialName: '防水卷材', spec: 'SBS-3mm', unit: 'm2', qty: 100, planPrice: 1000, marketPrice: 600, dealPrice: 700 },
        { materialBaseId: 'mb-022', materialName: '保温板', spec: 'XPS-50', unit: 'm3', qty: 100, planPrice: 1000, marketPrice: 620, dealPrice: 600 },
      ],
    },
    // ---------------------------------------------------------------- T4
    {
      task: { id: 'task-q-004', taskNo: 'HT-CG-2026-004', name: '小型机械租赁' },
      items: [
        { id: 'ti-031', materialBaseId: 'mb-031', materialName: '挖掘机', spec: 'PC200', unit: '台班', qty: 10, planPrice: 100 },
      ],
      bidders: [
        // 中标却没有任何报价 → B7_WINNER_NO_PRICE
        { id: 'bd-031', taskId: 'task-q-004', bidderName: '甲公司', seq: 1, status: 'WON', passedFirst: '是' },
        // 有效报价仅 1 家 < 3 → B7_FEW_BIDDERS
        { id: 'bd-032', taskId: 'task-q-004', bidderName: '乙公司', seq: 2, passedFirst: '是', firstPreTaxTotal: 1200, firstTax: 156 },
      ],
    },
    // ---------------------------------------------------------------- T5（干净）
    {
      task: { id: 'task-q-005', taskNo: 'HT-CG-2026-005', name: '劳保用品' },
      items: [
        { id: 'ti-041', materialBaseId: 'mb-041', materialName: '安全帽', spec: 'ABS', unit: '个', qty: 10, planPrice: 1000, marketPrice: 1050, infoPrice: 1020 },
      ],
      bidders: [
        { id: 'bd-041', taskId: 'task-q-005', bidderName: '甲公司', seq: 1, status: 'WON', passedFirst: '是', firstPreTaxTotal: 10500, firstTax: 1365, secondPreTaxTotal: 10000, secondTax: 1300 },
        { id: 'bd-042', taskId: 'task-q-005', bidderName: '乙公司', seq: 2, passedFirst: '是', firstPreTaxTotal: 11000, firstTax: 1430 },
        { id: 'bd-043', taskId: 'task-q-005', bidderName: '丙公司', seq: 3, passedFirst: '是', firstPreTaxTotal: 10000, firstTax: 1300 },
        { id: 'bd-044', taskId: 'task-q-005', bidderName: '丁公司', seq: 4, passedFirst: '是', firstPreTaxTotal: 11500, firstTax: 1495 },
      ],
      compareItems: [
        { materialBaseId: 'mb-041', materialName: '安全帽', spec: 'ABS', unit: '个', qty: 10, planPrice: 1000, marketPrice: 1050, dealPrice: 1000 },
      ],
    },
  ];
}

/** 干净夹具：只有 T5 一个任务，用于「一条都不该命中」的负向断言 */
export function cleanQuoteFixture(): QuoteTaskInput[] {
  return quoteAnomalyFixture().filter((t) => t.task.taskNo === 'HT-CG-2026-005');
}

/** 真值条目（`code` + `entityId` + 任务号），spec 按此对账 */
export interface QuoteTruth {
  code: string;
  entityId: string;
  taskNo: string;
}

/** 12 条注入异常的真值（顺序无关；spec 会排序后逐条断言） */
export function quoteTruth(): QuoteTruth[] {
  return [
    { code: 'B1_DROP_EXCESS', entityId: 'bd-001', taskNo: 'HT-CG-2026-001' },
    { code: 'B1_DROP_INVERTED', entityId: 'bd-002', taskNo: 'HT-CG-2026-001' },
    { code: 'B2_SPREAD_TOO_LOW', entityId: 'task-q-002', taskNo: 'HT-CG-2026-002' },
    { code: 'B3_OVER_BUDGET', entityId: 'bd-011', taskNo: 'HT-CG-2026-002' },
    { code: 'B4_PRICE_OVER_CONTROL', entityId: 'mb-011', taskNo: 'HT-CG-2026-002' },
    { code: 'B6_NOT_LOWEST', entityId: 'bd-011', taskNo: 'HT-CG-2026-002' },
    { code: 'B3_UNDER_BUDGET', entityId: 'bd-021', taskNo: 'HT-CG-2026-003' },
    { code: 'B4_PRICE_VS_MARKET', entityId: 'mb-021', taskNo: 'HT-CG-2026-003' },
    { code: 'B5_TAX_RATE_DRIFT', entityId: 'bd-021', taskNo: 'HT-CG-2026-003' },
    { code: 'B5_TAX_RATE_INVALID', entityId: 'bd-023', taskNo: 'HT-CG-2026-003' },
    { code: 'B7_FEW_BIDDERS', entityId: 'task-q-004', taskNo: 'HT-CG-2026-004' },
    { code: 'B7_WINNER_NO_PRICE', entityId: 'bd-031', taskNo: 'HT-CG-2026-004' },
  ];
}
