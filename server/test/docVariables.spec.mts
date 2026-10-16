import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  PAYMENT_DOC_VARIABLES,
  buildPaymentDocValues,
  formatDocMoney,
  formatDocDate,
} from '../src/modules/doc-template/doc-template-vars.ts';
import { PAYMENT_DOC_VAR_GROUPS } from '../../web/src/constants/docVariables.ts';

/**
 * **单据模板变量锁**（业务口径 2026-10-16 的第三套变量体系）。
 *
 * 三件事会悄悄坏掉：
 * ① 面板里有、取值表里没有（作者插了变量却静默不替换）；
 * ② 金额类变量名**漏了单位后缀**（`(元)`）——同名不同单位视为缺陷（docs/06 的既有约定）；
 * ③ 变量面板插入的是**单花括号**：渲染器只认 `{{}}`，插成 `{名}` 会静默不替换。
 *    这条 2026-10-16 真渲染时发现过（`insertVariable` 的默认值没跟着语法收敛改），故用源码扫描钉住。
 */

describe('单据模板变量：前后端镜像', () => {
  it('面板（前端）与取值表（后端）的变量名**逐条一致**', () => {
    const backend = PAYMENT_DOC_VARIABLES.map((v) => v.name).sort();
    const front = PAYMENT_DOC_VAR_GROUPS.flatMap((g) => g.items.map((i) => i.key)).sort();
    assert.deepEqual(front, backend, 'web/src/constants/docVariables.ts 与 doc-template-vars.ts 必须一致');
  });

  it('金额类变量名必须带单位后缀（(元)）', () => {
    const money = PAYMENT_DOC_VARIABLES.filter((v) => /金额/.test(v.name));
    assert.ok(money.length >= 3, '应至少有开累结算/开累付款/未付款三个金额变量');
    for (const v of money) {
      assert.match(v.name, /\(元\)$/, `金额变量「${v.name}」必须带单位后缀 (元)`);
    }
  });

  it('面板里给出的 raw 都是双花括号（避免插出无效占位符）', () => {
    for (const g of PAYMENT_DOC_VAR_GROUPS) {
      for (const i of g.items) {
        assert.equal(i.raw, `{{${i.key}}}`, `变量 ${i.key} 的 raw 必须是 {{${i.key}}}`);
      }
    }
  });
});

describe('付款单取值表', () => {
  const base = {
    procedure: {
      code: 'FK-HT-1-20261016',
      settleCumAmount: 1000,
      paidCumAmount: 2000,
      unpaidAmount: -1000,
      payDate: new Date(2026, 9, 16),
      remark: '验收',
    },
    contract: { code: 'HT-1', name: '钢筋采购合同' },
    supplier: { name: '宏基钢材贸易有限公司' },
    project: { name: '滨江项目', nameAbbr: '滨江', code: 'PRJ-1' },
    now: new Date(2026, 9, 20),
  };

  it('常规取值', () => {
    const v = buildPaymentDocValues(base);
    assert.equal(v.单据编号, 'FK-HT-1-20261016');
    assert.equal(v.供应商名称, '宏基钢材贸易有限公司');
    assert.equal(v['开累结算金额(元)'], '1,000.00');
    assert.equal(v['开累付款金额(元)'], '2,000.00');
    assert.equal(v['未付款金额(元)'], '-1,000.00', '付超时为负数，照实展示');
    assert.equal(v.付款时间, '2026-10-16');
    assert.equal(v.打印日期, '2026-10-20', '打印日期取生成当天，不是付款日期');
  });

  it('缺失的关联对象不炸，且**不把空值写成 "undefined"**', () => {
    const v = buildPaymentDocValues({ procedure: { code: null } });
    assert.equal(v.单据编号, '');
    assert.equal(v.供应商名称, '');
    assert.equal(v['开累结算金额(元)'], '');
    assert.equal(v.付款时间, '');
  });

  it('格式化工具对空值/非法值返回空串（由渲染器原样保留占位符）', () => {
    assert.equal(formatDocMoney(null), '');
    assert.equal(formatDocMoney('不是数字'), '');
    assert.equal(formatDocDate(undefined), '');
    assert.equal(formatDocDate('不是日期'), '');
  });
});

describe('变量面板插入的是双花括号（源码扫描锁）', () => {
  it('RichTextEditor.insertVariable 的默认插入文本是 {{key}}', () => {
    const src = readFileSync(
      fileURLToPath(new URL('../../web/src/components/RichTextEditor.tsx', import.meta.url)),
      'utf8',
    );
    assert.match(
      src,
      /item\.raw \|\| `\{\{\$\{item\.key\}\}\}`/,
      'insertVariable 的默认文本必须是 `{{key}}`：渲染器只认双花括号，插成 `{key}` 会静默不替换',
    );
    assert.ok(
      !/item\.raw \|\| `\{\$\{item\.key\}\}`/.test(src),
      '不要退回单花括号版本（2026-10-16 已修：面板插单花括号 → 正文里留着占位符不替换）',
    );
  });
});
