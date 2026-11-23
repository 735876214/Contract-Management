/**
 * 「是」判定（全站唯一口径）：兼容 是 / Y / YES / TRUE / 1。
 * 前端原 isYes 即此口径；服务端原「只认'是'」是它的子集，统一为宽松版不会漏判存量数据。
 */
export declare const isYesFlag: (v: unknown) => boolean;
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
export declare function defaultFinalPrice(supplier: PriceSupplierLike | null | undefined): number | null;
/** 询价情况表行（取报价最低供应商用） */
export interface InquiryRowLike {
    unit?: unknown;
    totalPrice?: unknown;
}
/**
 * 从询价情况表取「报价最低」的单位与金额（自动填充引用供应商）。
 * 过滤掉无单位名或无有效报价的行；并列最低全部保留。返回空数组表示无有效报价。
 */
export declare function lowestPriceSuppliers(rows?: InquiryRowLike[]): Array<{
    supplier: string;
    amount: number;
}>;
/** 清单收入（万元）= 收入单价（元）× 暂定数量 ÷ 10000 */
export declare const calcIncomeWan: (incomePrice: unknown, qty: unknown) => number;
/** 预计采购成本（万元）= 控制价（元）× 暂定数量 ÷ 10000 */
export declare const calcCostWan: (planPrice: unknown, qty: unknown) => number;
/** 预计效益额（万元）= 清单收入 − 预计采购成本 */
export declare const calcBenefitWan: (income: unknown, cost: unknown) => number;
/** 效益率（%）= 效益额 ÷ 收入 × 100；收入为 0 时按 0 */
export declare const calcBenefitRate: (income: unknown, benefit: unknown) => number;
/** 成本分析行（income / cost 均为「万元」） */
export interface CostRowLike {
    materialName?: unknown;
    spec?: unknown;
    income?: unknown;
    cost?: unknown;
}
/** 单行派生值：清单收入 / 预计采购成本 / 预计效益额 / 效益率 */
export declare function deriveCostRow(row: CostRowLike | null | undefined): {
    income: number;
    cost: number;
    benefit: number;
    rate: number;
};
/** 表底汇总：清单收入、预计采购成本、预计效益额（效益率按合计口径计算） */
export declare function summarizeCost(rows?: CostRowLike[]): {
    rate: number;
    income: number;
    cost: number;
    benefit: number;
};
/** 总采购清单行（incomePrice / planPrice 单位：元） */
export interface TotalListRowLike {
    materialName?: unknown;
    spec?: unknown;
    qty?: unknown;
    incomePrice?: unknown;
    planPrice?: unknown;
}
/** 由「总采购清单」明细换算成本分析表的初始行（income/cost 单位：万元） */
export declare function costRowsFromTotalList(items?: TotalListRowLike[]): Array<{
    materialName: string;
    spec: string;
    income: number;
    cost: number;
}>;
