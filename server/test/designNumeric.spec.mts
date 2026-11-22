import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * **数字排版锁**（DESIGN.md §2「数字排版」）。
 *
 * 两条已经定下的口径，本文件把它们从「口头约定」变成 CI 可捕获的规则：
 * 1. **等宽数字**：表格与 KPI 数字一律 font-variant-numeric: tabular-nums。
 *    Inter 默认是比例数字（"1" 比 "8" 窄），金额列右对齐后位数一变中间就歪；
 *    等宽数字让整列天然成"数字塔"。实现只有 index.css 一处（全局），页面不得各自覆盖。
 * 2. **金额列右对齐**：单行列定义里带小数金额语义的列必须 align: right；
 *    宽度**不做统一**（由页面按数量级给，100–160），因为统一宽度会截断大额。
 *
 * ⚠️ 联动：新增本文件要在 docs/development.md §5 登记（docStats.spec.mts 会校验）。
 */

const repoRoot = fileURLToPath(new URL('../../', import.meta.url));
const WEB_SRC = repoRoot + 'web/src';

const walk = (dir: string, out: string[] = []): string[] => {
  for (const name of readdirSync(dir)) {
    const full = dir + '/' + name;
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.(ts|tsx|css|less)$/.test(name)) out.push(full);
  }
  return out;
};

const relOf = (full: string) => full.substring(WEB_SRC.length + 1).replace(/\\/g, '/');

/** 金额语义的列标题（排除日期/时间这类被"付款"误伤的词） */
const AMOUNT_TITLE = /(金额|单价|总价|合价|合计|总额|含税|不含税)/;
const NON_MONEY = /(日期|时间|状态|方式|说明|备注)/;
const AMOUNT_COL_RE = /title:\s*'([^']*)'[^\n]*dataIndex:[^\n]*render:/;

describe('数字排版锁（DESIGN.md §2）', () => {
  const files = walk(WEB_SRC);

  it('index.css 必须声明表格/KPI 的等宽数字', () => {
    const css = readFileSync(WEB_SRC + '/index.css', 'utf8');
    assert.ok(
      /\.ant-table[^{]*\{[^}]*font-variant-numeric:\s*tabular-nums/.test(css),
      'index.css 里 .ant-table 的 tabular-nums 规则丢失：金额列上下两行会对不齐',
    );
    assert.ok(
      /\.ant-statistic-content[^{]*\{[^}]*tabular-nums|,\s*[\r\n]*\s*\.ant-statistic-content\s*\{/.test(css),
      'index.css 里 KPI 数字（.ant-statistic-content）也应等宽',
    );
  });

  it('等宽数字只许在 index.css 收口，别处不得改回比例数字', () => {
    const offenders = files
      .filter((f) => relOf(f) !== 'index.css')
      .filter((f) => /font-variant-numeric:\s*normal/.test(readFileSync(f, 'utf8')))
      .map(relOf);
    assert.deepEqual(offenders, [], '这些文件把数字改回比例数字了（等宽数字是全局口径）：\n  ' + offenders.join('\n  '));
  });

  it('金额列必须右对齐（单行列定义）', () => {
    const offenders: string[] = [];
    for (const f of files) {
      if (!/\.(ts|tsx)$/.test(f)) continue;
      readFileSync(f, 'utf8').split('\n').forEach((line, i) => {
        const m = line.match(AMOUNT_COL_RE);
        if (!m) return;
        if (!AMOUNT_TITLE.test(m[1])) return; // 只锁金额语义的列
        if (NON_MONEY.test(m[1])) return;
        if (/align:\s*'right'/.test(line)) return;
        offenders.push(relOf(f) + ':' + (i + 1) + '  ' + line.trim().slice(0, 120));
      });
    }
    assert.deepEqual(offenders, [], '这些金额列没写 align: \'right\'（数字要能竖着比大小）：\n  ' + offenders.join('\n  '));
  });
});
