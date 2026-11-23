/**
 * 总结算书「编号」纯函数层（零依赖，供服务与纯函数单测共用）。
 *
 * 编号规则：`<分公司简称>-<项目编号>-WZZJS-<结算年份>-<流水号>`
 *   - 分公司简称：项目管理里的 `branchCompanyAbbr`（无则回落 `TMHB`）
 *   - 项目编号：项目 `codeAbbr`（无则 `code`）
 *   - 结算年份：单据生成（createdAt）所在**本地**年份
 *   - 流水号：同项目当年按创建顺序两位递增（`Math.max(1, seq)`，缺省 1）
 *
 * 之所以单独抽出：编号需要「落库、稳定、可测」，格式化与流水号夹取是最容易出错的
 * 纯计算（跨年零点、seq 为 0/负数、补零位数），在真库里反而不好复现边界。
 */

/** 分公司简称：仅允许大写字母与数字，长度 1..20（前端同名校验与之镜像） */
export const BRANCH_ABBR_RE = /^[A-Z0-9]{1,20}$/;

/** 分公司简称归一：去空格 + 转大写；空串视为未填（返回 null） */
export function normalizeBranchAbbr(value: unknown): string | null {
  const v = String(value ?? '').trim().toUpperCase();
  return v ? v : null;
}

export interface DocNumberParts {
  /** 分公司简称前缀（不含横线），如 TMHB */
  branchPrefix: string | null | undefined;
  /** 项目编号，如 BJWSZX */
  projectCode: string | null | undefined;
  /** 结算年份（4 位） */
  year: number;
  /** 同项目当年顺序号（1 起；<=0 或缺失按 1） */
  seq: number;
}

/**
 * 生成总结算书编号。前缀/项目编号为空时给可读兜底（`TMHB` / 空），
 * 流水号向下兼容为至少两位、超过两位不截断。
 */
export function formatFinalSettlementDocNumber(parts: DocNumberParts): string {
  const branch = (String(parts.branchPrefix ?? '').trim() || 'TMHB').toUpperCase();
  const projectCode = String(parts.projectCode ?? '').trim().toUpperCase();
  const year = Number.isFinite(parts.year) ? Math.trunc(parts.year) : new Date().getFullYear();
  const seq = Number.isFinite(parts.seq) && parts.seq > 0 ? Math.trunc(parts.seq) : 1;
  return `${branch}-${projectCode}-WZZJS-${year}-${String(seq).padStart(2, '0')}`;
}
