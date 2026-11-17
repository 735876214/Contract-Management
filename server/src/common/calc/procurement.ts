/**
 * 采购域派生规则（零依赖，前后端共用，单一实现）。
 *
 * 背景：采购各阶段的「派生金额/比率」此前散落在前端 utils 与服务端 service 各自实现：
 * - 前端 `web/src/utils/preMeetingMinutes.ts`：calcIncomeWan/calcCostWan/deriveCostRow/summarizeCost
 * - 前端 `web/src/utils/procurementResultReport.ts`：defaultFinalPrice
 * - 前端 `web/src/pages/Procurement/FrameworkExplanation.tsx`：询价最低价 autoFillRefSuppliers（内联 Math.min）
 * - 服务端 `constants/procurementFlow.ts`：candidatesFromBidders 里的「第二轮→第一轮」回退（与前端 defaultFinalPrice 同口径，却各写一遍）
 *
 * 任一侧改公式而另一侧没跟上，就会出现"同一批报价、前后端算出不同金额"——正是本项目反复出现的计算错误根因。
 * 本模块把这些规则收敛到**一份**，前后端都从这里引用；舍入/乘法/归一继续下沉到 money/amounts/numeric。
 *
 * 注意职责边界：这里只算"如何从原始录入派生出值"，不决定"派生值能否覆盖用户手工录入"。
 * 最终确认价、引用金额、占比在 UI 上均可人工编辑，服务端写库时的覆盖策略由 service 层按业务语义决定。
 */
import { round2 } from './money.ts';
import { num } from './numeric.ts';
import { mulDecimal } from './amounts.ts';

/**
 * 「是」判定（全站唯一口径）：兼容 是 / Y / YES / TRUE / 1。
 * 前端原 isYes 即此口径；服务端原「只认'是'」是它的子集，统一为宽松版不会漏判存量数据。
 */
export const isYesFlag = (v: unknown): boolean => {
  const s = String(v ?? '').trim().toUpperCase();
  return s === '是' || s === 'Y' || s === 'YES' || s === 'TRUE' || s === '1';
};

/** 可参与报价计算的最小供应商形状 */
export interface PriceSupplierLike {
  passedFirst?: unknown;
  firstPreTaxTotal?: unknown;
  secondPreTaxTotal?: unknown;
}

/**
 * 候选人「最终确认不含税价格」的默认回退：
 * 优先第二轮报价（仅当通过第一轮且有报价），否则回退第一轮报价；都没有返回 null。
 * ——前后端、以及服务端生成合同时的取价，必须都走这一份。
 */
export function defaultFinalPrice(supplier: PriceSupplierLike | null | undefined): number | null {
  if (!supplier) return null;
  const first = num(supplier.firstPreTaxTotal);
  const second = num(supplier.secondPreTaxTotal);
  if (isYesFlag(supplier.passedFirst) && second !== null) return second;
  return first;
}

/** 询价情况表行（取报价最低供应商用） */
export interface InquiryRowLike {
  unit?: unknown;
  totalPrice?: unknown;
}

/**
 * 从询价情况表取「报价最低」的单位与金额（自动填充引用供应商）。
 * 过滤掉无单位名或无有效报价的行；并列最低全部保留。返回空数组表示无有效报价。
 */
export function lowestPriceSuppliers(rows: InquiryRowLike[] = []): Array<{ supplier: string; amount: number }> {
  const priced = rows
    .filter((r) => String(r?.unit ?? '').trim() && num(r?.totalPrice) !== null)
    .map((r) => ({ supplier: String(r.unit).trim(), amount: num(r.totalPrice)! }));
  if (!priced.length) return [];
  const min = priced.reduce((m, r) => Math.min(m, r.amount), priced[0].amount);
  return priced.filter((r) => r.amount === min);
}

/* ---------------- 采前会成本分析表 ---------------- */

/** 万元金额格式所需数值：元 ÷ 10000，保留 2 位（用整数分乘法避免浮点尾差） */
const toWan = (price: unknown, qty: unknown): number => {
  const yuan = mulDecimal(price, qty, 2) ?? 0;
  return round2(yuan / 10000) ?? 0;
};

/** 清单收入（万元）= 收入单价（元）× 暂定数量 ÷ 10000 */
export const calcIncomeWan = (incomePrice: unknown, qty: unknown): number => toWan(incomePrice, qty);

/** 预计采购成本（万元）= 控制价（元）× 暂定数量 ÷ 10000 */
export const calcCostWan = (planPrice: unknown, qty: unknown): number => toWan(planPrice, qty);

/** 预计效益额（万元）= 清单收入 − 预计采购成本 */
export const calcBenefitWan = (income: unknown, cost: unknown): number =>
  round2((num(income) ?? 0) - (num(cost) ?? 0)) ?? 0;

/** 效益率（%）= 效益额 ÷ 收入 × 100；收入为 0 时按 0 */
export const calcBenefitRate = (income: unknown, benefit: unknown): number => {
  const i = num(income) ?? 0;
  if (i === 0) return 0;
  return round2(((num(benefit) ?? 0) / i) * 100) ?? 0;
};

/** 成本分析行（income / cost 均为「万元」） */
export interface CostRowLike {
  materialName?: unknown;
  spec?: unknown;
  income?: unknown;
  cost?: unknown;
}

/** 单行派生值：清单收入 / 预计采购成本 / 预计效益额 / 效益率 */
export function deriveCostRow(row: CostRowLike | null | undefined) {
  const income = round2(num(row?.income) ?? 0) ?? 0;
  const cost = round2(num(row?.cost) ?? 0) ?? 0;
  const benefit = calcBenefitWan(income, cost);
  return { income, cost, benefit, rate: calcBenefitRate(income, benefit) };
}

/** 表底汇总：清单收入、预计采购成本、预计效益额（效益率按合计口径计算） */
export function summarizeCost(rows: CostRowLike[] = []) {
  const total = rows.reduce<{ income: number; cost: number; benefit: number }>(
    (acc, r) => {
      const d = deriveCostRow(r);
      acc.income = round2(acc.income + d.income) ?? acc.income;
      acc.cost = round2(acc.cost + d.cost) ?? acc.cost;
      acc.benefit = round2(acc.benefit + d.benefit) ?? acc.benefit;
      return acc;
    },
    { income: 0, cost: 0, benefit: 0 },
  );
  return { ...total, rate: calcBenefitRate(total.income, total.benefit) };
}

/** 总采购清单行（incomePrice / planPrice 单位：元） */
export interface TotalListRowLike {
  materialName?: unknown;
  spec?: unknown;
  qty?: unknown;
  incomePrice?: unknown;
  planPrice?: unknown;
}

/** 由「总采购清单」明细换算成本分析表的初始行（income/cost 单位：万元） */
export function costRowsFromTotalList(items: TotalListRowLike[] = []): Array<{ materialName: string; spec: string; income: number; cost: number }> {
  return items.map((i) => ({
    materialName: String(i.materialName ?? ''),
    spec: String(i.spec ?? ''),
    income: calcIncomeWan(i.incomePrice, i.qty),
    cost: calcCostWan(i.planPrice, i.qty),
  }));
}
