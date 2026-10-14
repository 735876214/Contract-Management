/**
 * 合同台账「合规性问题」判定（**零运行时依赖**，供 ledger.service 与单测共用）。
 *
 * 抽出来的原因：这段判定含 4 条业务规则且**不落库**（每次列表实时计算），
 * 此前作为 `ledger.service` 的私有方法无法单测；金额/日期口径一旦改错只会在页面上体现。
 *
 * 规则（与实现注释保持一致）：
 * - **执行类合同**（PURCHASE_EXEC / LEASE_EXEC）：只比「进场 vs 签订」——进场早于签订即"未签合同先进场"；
 *   无进场日期则不判定（返回空串）；有进场但缺签订日期 → "时间数据不完整"。**不看招标/定标**。
 * - **非执行类合同**：按「招标 → 定标 → 签订」顺序，进场早于任一节点即报对应问题（优先级同上）；
 *   三个节点日期全缺 → "时间数据不完整"；进场日期缺失 → "时间数据不完整"。
 * - 边界：进场日期**等于**节点日期不算问题（用严格小于比较）。
 */

/** 执行类合同类型（与 contract_type 字典项编码一致） */
export const LEDGER_EXEC_CONTRACT_TYPES: readonly string[] = ['PURCHASE_EXEC', 'LEASE_EXEC'];

/** 合规性问题文案（空串表示"不判定"，如执行类合同未填进场日期） */
export const LEDGER_COMPLIANCE = {
  OK: '无问题',
  INCOMPLETE: '时间数据不完整',
  ENTRY_BEFORE_BID: '未招标进场',
  ENTRY_BEFORE_WIN: '未定标进场',
  ENTRY_BEFORE_SIGN: '未签合同进场',
  /** 执行类合同专用：先进场后签合同 */
  ENTRY_BEFORE_SIGN_EXEC: '未签合同先进场',
} as const;

const toTime = (v: unknown): number | null => {
  if (v === null || v === undefined || v === '') return null;
  const t = new Date(v as any).getTime();
  return Number.isNaN(t) ? null : t;
};

/**
 * 计算台账行的合规性问题。
 * @param typeCode 合同类型（dict: contract_type）
 * @param entry    首次进场日期（来自日报）
 * @param bidStart 开始招标时间 / @param bidWin 定标时间 / @param sign 合同签订时间
 */
export function calcLedgerCompliance(
  typeCode: string,
  entry: Date | string | null,
  bidStart: unknown,
  bidWin: unknown,
  sign: unknown,
): string {
  const entryT = toTime(entry);

  if (LEDGER_EXEC_CONTRACT_TYPES.includes(String(typeCode ?? ''))) {
    if (!entryT) return '';
    const signT = toTime(sign);
    if (!signT) return LEDGER_COMPLIANCE.INCOMPLETE;
    return entryT >= signT ? LEDGER_COMPLIANCE.OK : LEDGER_COMPLIANCE.ENTRY_BEFORE_SIGN_EXEC;
  }

  if (!entryT) return LEDGER_COMPLIANCE.INCOMPLETE;
  const bidStartT = toTime(bidStart);
  const bidWinT = toTime(bidWin);
  const signT = toTime(sign);
  if (!bidStartT && !bidWinT && !signT) return LEDGER_COMPLIANCE.INCOMPLETE;
  if (bidStartT && entryT < bidStartT) return LEDGER_COMPLIANCE.ENTRY_BEFORE_BID;
  if (bidWinT && entryT < bidWinT) return LEDGER_COMPLIANCE.ENTRY_BEFORE_WIN;
  if (signT && entryT < signT) return LEDGER_COMPLIANCE.ENTRY_BEFORE_SIGN;
  return LEDGER_COMPLIANCE.OK;
}
