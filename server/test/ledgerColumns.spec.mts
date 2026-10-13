import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { LEDGER_COLUMNS, ledgerColumnWidthPx } from '../src/modules/ledger/ledger-columns.ts';

/**
 * 合同台账列宽单位契约（回归锁定）。
 *
 * 背景：`LEDGER_COLUMNS[].width` 是 **Excel 字符宽**（8~30），而前端 antd 表格需要**像素**。
 * 早期直接把字符值当像素传给 antd → 42 列表头全被挤成竖排文字，合同台账在**桌面端也破版**
 * （375px 截图核验时发现）。本测试锁定：「原始值仍是字符宽」+「换算后必 ≥ 最小像素宽」，
 * 两个方向都不会再被误改。
 */

/** 中文表头所需的最小像素宽：低于此值会被浏览器压成竖排文字 */
const MIN_SAFE_PX = 100;
/** Excel 字符宽的合理上限（超过说明有人把像素值直接写进了原始表） */
const MAX_CHAR_WIDTH = 60;

describe('合同台账列宽换算', () => {
  it('换算后的像素宽一律不低于安全下限（防「列被挤成竖排」复发）', () => {
    const tooNarrow = LEDGER_COLUMNS.filter((c) => ledgerColumnWidthPx(c.width) < MIN_SAFE_PX).map(
      (c) => `${c.key}=${ledgerColumnWidthPx(c.width)}px`,
    );
    assert.deepEqual(tooNarrow, [], `以下列换算后过窄：\n  ${tooNarrow.join('\n  ')}`);
  });

  it('原始 width 必须仍是「Excel 字符宽」量级，不得直接写入像素值', () => {
    const suspicious = LEDGER_COLUMNS.filter((c) => c.width != null && c.width > MAX_CHAR_WIDTH).map(
      (c) => `${c.key}=${c.width}`,
    );
    assert.deepEqual(
      suspicious,
      [],
      `以下列的原始 width 看起来已是像素值（>${MAX_CHAR_WIDTH}）。` +
        `若确实要改为像素，请同步删除 ledgerColumnWidthPx 的换算并更新本测试：\n  ${suspicious.join('\n  ')}`,
    );
  });

  it('换算按 ~8px/字符并带下限：20 → 160，8（序号）→ 100（下限兜底）', () => {
    assert.equal(ledgerColumnWidthPx(20), 160);
    assert.equal(ledgerColumnWidthPx(8), MIN_SAFE_PX);
    assert.equal(ledgerColumnWidthPx(30), 240);
  });

  it('空值 / 0 / 非法值回退到默认字符宽（不产生 NaN 或 0px 列）', () => {
    for (const v of [undefined, 0, null as never, NaN, 'x' as never]) {
      const px = ledgerColumnWidthPx(v as number);
      assert.ok(Number.isFinite(px) && px >= MIN_SAFE_PX, `${String(v)} → ${px}`);
    }
  });

  it('列清单本身完整（防误删导致台账缺列）', () => {
    assert.ok(LEDGER_COLUMNS.length >= 30, `LEDGER_COLUMNS 仅 ${LEDGER_COLUMNS.length} 列`);
    const keys = LEDGER_COLUMNS.map((c) => c.key);
    assert.equal(new Set(keys).size, keys.length, '存在重复的列 key');
    // 冻结前两列依赖这两个 key（见 web/src/pages/Ledger.tsx 的 FROZEN_LEFT_KEYS）
    assert.ok(keys.includes('index') && keys.includes('contractCode'), '缺少 index / contractCode 列');
  });
});
