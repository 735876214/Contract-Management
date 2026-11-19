import { canonicalMonthKey } from '../../common/calc';

/**
 * 逾期利息台账的「按合同 + 结算月合并成一行」。
 *
 * 背景：计息引擎里一个逾期项通常由两条记录组成——
 *   - 材料款主行（materialAmount/应付款金额/应付款日期/逾期起始日期）；
 *   - 付款行或「计息承载行」（paymentDate/paymentAmount/计息金额/逾期天数/逾期利息）。
 * 逐行直出会被拆成两行，业务要求同一合同同一结算月只显示一行。
 *
 * 合并口径：金额求和、日期取最早（付款日期有多笔时取最晚并在备注列出全部）、
 * 逾期天数取最大、任一被减免则整行视为减免；`id` 取材料款主行（无则首行），
 * `ids` 保留全部原始记录 id（供删除等动作逐条处理）。
 *
 * 纯函数、无副作用：合计/统计仍应由调用方在**合并前**用未合并行计算。
 */
export interface OverdueMergeable {
  contractId?: string | null;
  settlementMonth?: string | null;
  [k: string]: any;
}

export function mergeOverdueRowsByMonth<T extends OverdueMergeable>(rows: T[]): T[] {
  const r2 = (x: number) => Math.round(x * 100) / 100;
  const toTime = (d: any) => (d ? new Date(d).getTime() : NaN);

  const order: string[] = [];
  const groups = new Map<string, T[]>();
  for (const r of rows) {
    const key = `${r.contractId ?? ''}|${canonicalMonthKey(r.settlementMonth) ?? r.settlementMonth ?? ''}`;
    let g = groups.get(key);
    if (!g) {
      g = [];
      groups.set(key, g);
      order.push(key);
    }
    g.push(r);
  }

  return order.map((key) => {
    const g = groups.get(key)!;
    if (g.length === 1) return g[0];

    const first: any = g[0];
    const sumBy = (f: (r: any) => any) => r2(g.reduce((a, r) => a + (Number(f(r)) || 0), 0));
    const mats = g.filter((r: any) => (Number(r.materialAmount) || 0) > 0);
    const pays = g.filter((r: any) => (Number(r.paymentAmount) || 0) > 0);

    const materialAmount = sumBy((r) => r.materialAmount);
    const payableAmount = sumBy((r) => r.payableAmount);
    const paymentAmount = sumBy((r) => r.paymentAmount);
    const interestAmount = sumBy((r) => r.interestAmount);
    const overdueInterest = sumBy((r) => r.overdueInterest);

    const days = g.map((r: any) => Number(r.overdueDays) || 0);
    const payTimes = pays
      .map((r: any) => toTime(r.paymentDate))
      .filter((t) => !isNaN(t))
      .sort((a, b) => a - b);
    const earliest = (times: number[]) =>
      times.length ? new Date(Math.min(...times)) : null;

    const rep: any = mats[0] || first;
    let remark = first.remark || '';
    if (payTimes.length > 1) {
      const ds = payTimes.map((t) => new Date(t).toISOString().slice(0, 10)).join('、');
      remark = remark ? `${remark}；付款日期：${ds}` : `付款日期：${ds}`;
    }

    return {
      ...first,
      id: rep.id,
      ids: g.map((r: any) => r.id).filter(Boolean),
      materialAmount: materialAmount || first.materialAmount,
      paymentRatio:
        mats.length === 1
          ? mats[0].paymentRatio
          : materialAmount > 0
            ? r2(payableAmount / materialAmount)
            : first.paymentRatio,
      payableAmount: payableAmount || first.payableAmount,
      payableDate:
        earliest(mats.map((r: any) => toTime(r.payableDate)).filter((t) => !isNaN(t))) ?? first.payableDate,
      overdueStartDate:
        earliest(g.map((r: any) => toTime(r.overdueStartDate)).filter((t) => !isNaN(t))) ?? first.overdueStartDate,
      paymentDate: payTimes.length ? new Date(payTimes[payTimes.length - 1]) : first.paymentDate,
      paymentAmount: paymentAmount || first.paymentAmount,
      interestAmount: interestAmount || first.interestAmount,
      overdueDays: Math.max(...days, 0) || null,
      overdueInterest,
      waived: g.every((r: any) => r.waived),
      periodSeq: Math.min(...g.map((r: any) => Number(r.periodSeq) || 0)),
      remark,
    } as T;
  });
}
