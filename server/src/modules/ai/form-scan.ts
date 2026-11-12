/**
 * 表单单元格扫描（**零运行时依赖**：只处理「字符串矩阵」，不碰 ExcelJS）。
 *
 * 为什么要把"扫描"和"读写 xlsx"拆开：xlsx 读写要 ExcelJS（CJS 包，`.mts` spec 里 import
 * 容易踩互操作坑），而**判断"哪一格是标签、哪一格该填值"才是真正容易出错的逻辑**，
 * 它必须能被单测穷举。所以：`ai.service` 负责"xlsx ↔ 矩阵"，本文件负责矩阵 → 候选槽位。
 *
 * 企业表单的实际形态（2026-10 实测的合同/结算/报名表）：
 * - **横向**成对：`项目名称：[____]  项目编号：[____]`（标签在左，值在右）
 * - **纵向**成对：`项目名称：` 单元格在上一行，值在下一行（"标题式"表格）
 * - **表格区**：`序号 | 名称 | 数量 | 单位` 是**表头**，不是待填槽位 —— 必须排除，
 *   否则模型会把"数量"映射成"合同金额"之类，填进真正的业务明细里。
 *
 * 排除表头的判据（`looksLikeHeaderRun`）：本格右侧连续 2 格都是"标签样"文本 → 视为表头行的一部分。
 * 表单里的标签格右邻通常是**空值格**，所以不会被误判；而 `序号|名称|数量` 的三连非空一定会命中。
 */

/** 一个非空单元格（由 ai.service 从 xlsx 逐格读出） */
export interface FormCell {
  sheet: string;
  /** 1 基行号（与 Excel 行号一致，便于用户核对） */
  row: number;
  /** 1 基列号 */
  col: number;
  text: string;
}

/** 待填槽位：`label` 是标签文本，`row/col` 是**值单元格**的位置 */
export interface FormCandidate {
  sheet: string;
  /** 值单元格的 Excel 引用，如 `D5`（回填时按它定位，也是前端展示给用户的定位符） */
  cellRef: string;
  row: number;
  col: number;
  /** 去除尾部冒号/空格后的标签文本 */
  label: string;
  /** 已填的值（空串 = 未填）。仅用于前端展示"将覆盖"，**不送模型** */
  currentValue: string;
}

/** 1 基列号 → Excel 列字母（A/B/…/AA） */
export function colLetter(n: number): string {
  let x = Math.floor(Number(n) || 0);
  let s = '';
  while (x > 0) {
    const m = (x - 1) % 26;
    s = String.fromCharCode(65 + m) + s;
    x = Math.floor((x - 1) / 26);
  }
  return s;
}

/** (row, col) 1 基坐标 → 引用串，如 `(5, 4)` → `D5` */
export function cellRefOf(row: number, col: number): string {
  return `${colLetter(col)}${Math.floor(Number(row) || 0)}`;
}

/** 标签里的尾部冒号/空白（`项目名称：` / `项目名称:` / `项目名称 ： `）统一剔除 */
export function trimLabel(text: string): string {
  return String(text ?? '')
    .replace(/[\s\u3000]+/g, ' ')
    .trim()
    .replace(/[：:]+\s*$/, '')
    .trim();
}

/**
 * 文本是否"像标签"：
 * - 含中文（纯英文/数字多半是表头缩写或数据，不是标签）
 * - 长度 ≤ 24（长句是说明文字，不是字段名）
 * - 无换行、不以句号结尾（说明段落）
 * - 不是纯数字/纯日期/百分比（那是值，不是标签）
 */
export function looksLikeLabel(text: string): boolean {
  const t = String(text ?? '').trim();
  if (!t) return false;
  if (t.length > 24) return false;
  if (/\n/.test(t)) return false;
  if (!/[\u4e00-\u9fa5]/.test(t)) return false;
  if (/[。；;]$/.test(t)) return false;
  // 纯数字/日期/百分比/金额形态：这些是**值**
  if (/^[\d\s.,:：\-\/年月日%元万元]+$/.test(t)) return false;
  return true;
}

/** 冒号结尾 = **确定的**标签（`项目名称：`）；右邻必是值，不需要再猜 */
function isStrongLabel(text: string): boolean {
  return /[：:]\s*$/.test(String(text ?? ''));
}

/**
 * 扫描一个工作表的单元格，产出待填槽位。
 *
 * 两遍处理：
 * 1. **先找表头连排**：某格右侧连续 2 格都是标签样文本（`序号 | 名称 | 数量`）→ 这三格都是表头，
 *    整段标记后不再参与配对。只靠"右邻是否像值"是不够的：`数量` 这类短名词会被误判成值。
 * 2. 再按优先级配对：
 *    - 右邻为空 → 横向槽位（最常见）；
 *    - 本格**冒号结尾** → 右邻就是值，横向槽位（`currentValue` 带上现值，允许覆盖）。
 *      冒号是"确定是标签"的强信号，避免把已填的「上海某某建设有限公司」当成另一个标签；
 *    - 右邻是标签样文本且右二也为空 → 纵向槽位（"标签在上、值在下"的标题式表格）；
 *    - 其余 → 横向槽位，现值带上。
 *
 * 排除：表头段内的格子；已被更早标签占用的值格（同一格不会被两个标签同时指向）。
 */
export function scanSheetCells(cells: readonly FormCell[]): FormCandidate[] {
  const byKey = new Map<string, FormCell>();
  for (const c of cells) {
    const t = String(c.text ?? '').trim();
    if (!t) continue;
    byKey.set(`${c.sheet}|${c.row}|${c.col}`, { ...c, text: t });
  }
  const at = (sheet: string, row: number, col: number): FormCell | undefined =>
    byKey.get(`${sheet}|${row}|${col}`);

  const ordered = [...byKey.values()].sort((a, b) =>
    a.sheet === b.sheet ? (a.row === b.row ? a.col - b.col : a.row - b.row) : a.sheet.localeCompare(b.sheet),
  );

  // ---- 第一遍 A：已被「冒号标签」认领的值格 → 不再当作标签分析 ----
  // 反例：`供应商名称：` 右邻填「某某建设」，若不排除，第二遍会把「某某建设」当成标签再配一对。
  const claimed = new Set<string>();
  for (const c of ordered) {
    if (!looksLikeLabel(c.text) || !isStrongLabel(c.text)) continue;
    claimed.add(`${c.sheet}|${c.row}|${c.col + 1}`);
  }

  // ---- 第一遍 B：表头连排标记（序号 | 名称 | 数量 这类表头不能当槽位）----
  const headerCells = new Set<string>();
  for (const c of ordered) {
    if (!looksLikeLabel(c.text)) continue;
    const h1 = at(c.sheet, c.row, c.col + 1);
    const h2 = at(c.sheet, c.row, c.col + 2);
    if (h1 && h2 && looksLikeLabel(h1.text) && looksLikeLabel(h2.text)) {
      for (let i = 0; i <= 2; i += 1) headerCells.add(`${c.sheet}|${c.row}|${c.col + i}`);
    }
  }

  const used = new Set<string>();
  const out: FormCandidate[] = [];

  const push = (sheet: string, row: number, col: number, label: string, currentValue: string): void => {
    const key = `${sheet}|${row}|${col}`;
    if (used.has(key)) return;
    used.add(key);
    out.push({ sheet, row, col, cellRef: cellRefOf(row, col), label, currentValue });
  };

  for (const c of ordered) {
    if (!looksLikeLabel(c.text)) continue;
    const selfKey = `${c.sheet}|${c.row}|${c.col}`;
    if (headerCells.has(selfKey) || claimed.has(selfKey)) continue;
    const label = trimLabel(c.text);
    if (!label) continue;

    const right = at(c.sheet, c.row, c.col + 1);

    // 横向配对：右邻为空 → 空槽位
    if (!right) {
      push(c.sheet, c.row, c.col + 1, label, '');
      continue;
    }

    // 冒号结尾 = 确定是标签，右邻就是值（允许覆盖已有内容）
    if (isStrongLabel(c.text)) {
      push(c.sheet, c.row, c.col + 1, label, right.text);
      continue;
    }

    // 右邻也是标签样文本 → 本格不是"标签+值"的一对，改为纵向配对
    if (looksLikeLabel(right.text)) {
      const below = at(c.sheet, c.row + 1, c.col);
      if (!below) push(c.sheet, c.row + 1, c.col, label, '');
      continue;
    }

    push(c.sheet, c.row, c.col + 1, label, right.text);
  }

  return out;
}

/** 表格区（行级填充用）：表头行 + 下方连续空行 */
export interface FormTableRegion {
  sheet: string;
  /** 表头所在行（1 基） */
  headerRow: number;
  /** 第一行可写数据行（1 基） */
  startRow: number;
  /** 表头列 */
  columns: Array<{ col: number; letter: string; label: string }>;
  /** 表头下方连续空行数（≤ 上限） */
  emptyRows: number;
}

/**
 * 识别「表头连排 + 下方连续空行」的表格区（Phase 4 行级填充）。
 *
 * 与 `scanSheetCells` 的表头排除同源：连续 ≥2 个非空格即视为表头候选；
 * 只收**下方至少 1 行空行**的区域（没有空行就没地方写，不能算可填表区）。
 * 同一行可能出现多个表头段（并列小表），逐个登记；上限由调用方截断。
 */
export function detectTableRegions(cells: readonly FormCell[], maxRegions = 10): FormTableRegion[] {
  const bySheet = new Map<string, Map<string, FormCell>>();
  for (const c of cells) {
    const t = String(c.text ?? '').trim();
    if (!t) continue;
    const sheet = bySheet.get(c.sheet) ?? new Map<string, FormCell>();
    sheet.set(`${c.row}|${c.col}`, { ...c, text: t });
    bySheet.set(c.sheet, sheet);
  }

  const out: FormTableRegion[] = [];
  for (const [sheet, grid] of bySheet) {
    const rows = [...new Set([...grid.values()].map((c) => c.row))].sort((a, b) => a - b);
    for (const row of rows) {
      const rowCells = [...grid.values()].filter((c) => c.row === row).sort((a, b) => a.col - b.col);
      // 找出连续的非空段（长度 ≥2）
      const runs: FormCell[][] = [];
      let run: FormCell[] = [];
      for (const c of rowCells) {
        if (run.length && c.col !== run[run.length - 1].col + 1) {
          if (run.length >= 2) runs.push(run);
          run = [];
        }
        run.push(c);
      }
      if (run.length >= 2) runs.push(run);

      for (const r of runs) {
        if (out.length >= maxRegions) return out;
        // 表头至少含一个"像标签"的格：否则纯数字/编号的数据行也会被当成表头
        if (!r.some((c) => looksLikeLabel(c.text))) continue;
        const cols = r.map((c) => c.col);
        let emptyRows = 0;
        for (let rr = row + 1; rr <= row + 500; rr += 1) {
          const hasValue = cols.some((col) => grid.has(`${rr}|${col}`));
          if (hasValue) break;
          emptyRows += 1;
        }
        if (emptyRows < 1) continue;
        out.push({
          sheet,
          headerRow: row,
          startRow: row + 1,
          columns: r.map((c) => ({ col: c.col, letter: colLetter(c.col), label: trimLabel(c.text) })),
          emptyRows,
        });
      }
    }
  }
  return out;
}

/**
 * 全簿扫描：按 sheet 分组后逐表扫描，结果按 (sheet, row, col) 排序并截断到 `maxCandidates`。
 * 截断**保留**前 N 个（按阅读顺序），并返回被丢弃的数量 —— 前端要提示"请精简上传或分段处理"，
 * 静默截断会让用户以为整张表都被识别了。
 */
export function scanWorkbook(
  cells: readonly FormCell[],
  maxCandidates: number,
): { candidates: FormCandidate[]; truncated: number } {
  const bySheet = new Map<string, FormCell[]>();
  for (const c of cells) {
    const list = bySheet.get(c.sheet) ?? [];
    list.push(c);
    bySheet.set(c.sheet, list);
  }

  const all: FormCandidate[] = [];
  for (const [sheet, list] of bySheet) {
    for (const cand of scanSheetCells(list)) all.push({ ...cand, sheet });
  }
  all.sort((a, b) =>
    a.sheet === b.sheet ? (a.row === b.row ? a.col - b.col : a.row - b.row) : a.sheet.localeCompare(b.sheet),
  );

  const limit = Math.max(1, Math.floor(Number(maxCandidates) || 1));
  if (all.length <= limit) return { candidates: all, truncated: 0 };
  return { candidates: all.slice(0, limit), truncated: all.length - limit };
}
