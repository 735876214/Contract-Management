import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { renderTemplate, pendingPlaceholders } from '../src/modules/template/template-render.ts';
/**
 * 合同模板占位符渲染的「语法契约」单测。
 *
 * 背景：`template.service.generate()` 曾同时兼容四种写法（`{{中文}}` / `{{ENGLISH_KEY}}` /
 * `{中文}` / 变量表每个 key 的 `{key}`），2026-10 定稿**只保留 `{{变量名}}`**——
 * 项目无存量业务数据、无需兼容，且单花括号会误伤富文本里的 CSS 花括号、并对已插入的表格做二次替换。
 * 本测试把「废弃写法不再被替换」钉死，防止将来有人"顺手"把兼容分支加回来。
 */

const T = { 合同清单: '<table><tr><td>清单</td></tr></table>' };

describe('renderTemplate：只认双花括号', () => {
  it('{{变量名}} 被替换，且同名可多处替换', () => {
    const out = renderTemplate({ html: '<p>{{合同编号}} / {{合同编号}}</p>', values: { 合同编号: 'HT-2026-0001' } });
    assert.equal(out, '<p>HT-2026-0001 / HT-2026-0001</p>');
  });

  it('**回归锁**：单花括号 {变量名} 一律不替换（含表格占位符）', () => {
    const out = renderTemplate({
      html: '<p>{合同编号} {合同清单} {合同额大写}</p>',
      values: { 合同编号: 'HT-1', 合同额大写: '壹万元' },
      tables: T,
    });
    assert.equal(out, '<p>{合同编号} {合同清单} {合同额大写}</p>');
  });

  it('**回归锁**：英文遗留表格 key 不替换', () => {
    const out = renderTemplate({
      html: '{{MATERIAL_CODE_TABLE}}{{CONTRACT_ITEM_TABLE}}',
      tables: { 物料编码清单: 'A', 合同清单: 'B' },
    });
    assert.equal(out, '{{MATERIAL_CODE_TABLE}}{{CONTRACT_ITEM_TABLE}}');
  });

  it('值里的字面量花括号（如富文本 CSS）不会被二次替换', () => {
    const out = renderTemplate({
      html: '<style>{{样式}}</style><p>{{合同编号}}</p>',
      values: { 样式: '.x{color:red}', 合同编号: 'HT-1' },
    });
    assert.equal(out, '<style>.x{color:red}</style><p>HT-1</p>');
  });

  it('值按原样插入：HTML 不转义（表格与富文本变量本身就是 HTML）', () => {
    const out = renderTemplate({ html: '<div>{{合同清单}}</div>', tables: T });
    assert.equal(out, '<div><table><tr><td>清单</td></tr></table></div>');
  });

  it('未提供值的占位符原样保留（不静默吞掉），并可被 pendingPlaceholders 列出', () => {
    const out = renderTemplate({ html: '<p>{{项目名称}}｜{{未知变量}}</p>', values: { 项目名称: '滨江项目' } });
    assert.equal(out, '<p>滨江项目｜{{未知变量}}</p>');
    assert.deepEqual(pendingPlaceholders(out), ['未知变量']);
  });

  it('null / undefined 值替换为空串，0 与空串正常输出（不被当成"无值"）', () => {
    const out = renderTemplate({
      html: '[{{甲}}][{{乙}}][{{丙}}][{{丁}}]',
      values: { 甲: null, 乙: undefined, 丙: 0, 丁: '' },
    });
    assert.equal(out, '[][][0][]');
  });

  it('同名键以**变量值**为准（变量先替换，补充协议填不上已被消费的占位符——沿用改造前行为）', () => {
    const out = renderTemplate({
      html: '<p>{{数量汇总}}</p>',
      values: { 数量汇总: '系统值' },
      supplement: { 数量汇总: '手工值' },
    });
    assert.equal(out, '<p>系统值</p>');
  });

  it('补充协议可填补变量表没有的键（补充协议占位符的正常用法）', () => {
    const out = renderTemplate({
      html: '<p>{{数量汇总}}｜{{补充协议表}}</p>',
      values: { 数量汇总: '系统值' },
      supplement: { 补充协议表: '<table>明细</table>' },
    });
    assert.equal(out, '<p>系统值｜<table>明细</table></p>');
  });

  it('表格先于变量替换（表头 HTML 里若带变量占位符，仍会被变量替换）', () => {
    const out = renderTemplate({
      html: '{{合同清单}}',
      tables: { 合同清单: '<th>{{项目名称}}</th>' },
      values: { 项目名称: '滨江项目' },
    });
    assert.equal(out, '<th>滨江项目</th>');
  });

  it('空输入 / 空取值表不抛错', () => {
    assert.equal(renderTemplate({ html: '' }), '');
    assert.equal(renderTemplate({ html: '<p>x</p>' }), '<p>x</p>');
    assert.equal(renderTemplate({ html: null as unknown as string, values: { a: 1 } }), '');
  });

  it('pendingPlaceholders：去重且保持出现顺序；无残留时为空数组', () => {
    assert.deepEqual(pendingPlaceholders('{{甲}}{{乙}}{{甲}}'), ['甲', '乙']);
    assert.deepEqual(pendingPlaceholders('<p>已全部替换</p>'), []);
    assert.deepEqual(pendingPlaceholders('单花括号 {甲} 不算未替换'), []);
  });
});

describe('renderTemplate：占位符形态归一（2026-10-17 防呆批次）', () => {
  it('全角花括号 ｛｛X｝｝ 归一后正常替换（此前残留且 pending 认不出）', () => {
    const out = renderTemplate({ html: '<p>｛｛合同清单｝｝</p>', tables: { 合同清单: '<table>T</table>' } });
    assert.equal(out, '<p><table>T</table></p>');
  });

  it('全角形态的残留能被 pendingPlaceholders 识别', () => {
    assert.deepEqual(pendingPlaceholders('｛｛未知变量｝｝'), ['未知变量']);
  });

  it('花括号内两侧空格 {{ X }} 归一后替换', () => {
    const out = renderTemplate({ html: '<p>{{ 合同清单 }}</p>', tables: { 合同清单: 'T' } });
    assert.equal(out, '<p>T</p>');
  });

  it('归一只作用于占位符形态：正文里的全角字符与空白不受影响', () => {
    const out = renderTemplate({ html: '<p>｛注意｝  空白保留{{合同编号}}</p>', values: { 合同编号: 'HT-1' } });
    assert.equal(out, '<p>｛注意｝  空白保留HT-1</p>');
  });

  it('**回归锁**：单花括号 {X} 仍不被归一、不被替换', () => {
    const out = renderTemplate({ html: '<p>{合同清单}</p>', tables: { 合同清单: 'T' } });
    assert.equal(out, '<p>{合同清单}</p>');
  });

  it('**回归锁**：被富文本标签拆散的占位符不归一、不替换（结构破坏，由前端防呆兜住）', () => {
    const out = renderTemplate({ html: '<p>{{合同<span></span>清单}}</p>', tables: { 合同清单: 'T' } });
    assert.equal(out, '<p>{{合同<span></span>清单}}</p>');
    assert.deepEqual(pendingPlaceholders(out), ['合同<span></span>清单']);
  });
});
