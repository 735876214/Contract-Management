import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { docxXmlToText, looksLikeContract } from '../src/modules/ai/docx-text.ts';
import {
  REGISTER_FIELDS,
  foldText,
  guessContractType,
  guessPaymentMode,
  isRealDay,
  normalizeDateText,
  normalizeExtraction,
  normalizeMoneyText,
  normalizePercentText,
  taxRateFraction,
  textHasDate,
  textHasMoney,
} from '../src/modules/ai/register-fields.ts';

/**
 * 「文件登记」的纯函数层。
 *
 * 两条底线由本文件锁死：
 * 1. **模型输出不可信**：金额/日期/税率必须按程序规则规整，不合法就置空并记 warn；
 * 2. **每个值都要回原文核对**——抽取结果里的 `verified:false` 是给人看的复核信号，
 *    不能因为模型自评 0.95 就当成已核实（合同里把联系人当法定代表人的错抽就是这么漏的）。
 */

const SAMPLE = `
安全劳保采购执行合同
合同编号：CSCEC-WZCG-ZJJXM-G2-2026003
项目名称：紫金街雨污分流及老旧街区更新改造工程(道路部分)（二标段）
需方（甲方）：中国建筑第八工程局有限公司
供方（乙方）：高邑潜玛贸易有限公司
签订地点：朔州市政府
签订时间：2026年 8 月    日
本合同含税总价为人民币 36,476.97 元（大写：叁万陆仟肆佰柒拾陆元玖角柒分），
其中不含税金额 32280.50 元，增值税税额 4196.47 元，税率 13%。
6.1 无预付款，月度结算，次月30日前支付当月结算价款的65%。
供方开户行：中国工商银行股份有限公司高邑支行  账号：0402023709300122764
联系人：李瑶  电话：13931111264  邮箱：122137404@qq.com
`;

describe('register-fields：金额 / 日期 / 税率规整', () => {
  it('金额去掉千分位、货币符号与「元」', () => {
    assert.equal(normalizeMoneyText('36,476.97'), '36476.97');
    assert.equal(normalizeMoneyText('￥1,234.00元'), '1234.00');
    assert.equal(normalizeMoneyText(' 36476.97 '), '36476.97');
    assert.equal(normalizeMoneyText('叁万陆仟'), null);
    assert.equal(normalizeMoneyText(null), null);
  });

  it('日期接受多种写法，只有年月时按 1 号补齐', () => {
    assert.equal(normalizeDateText('2026-08-01'), '2026-08-01');
    assert.equal(normalizeDateText('2026/8/1'), '2026-08-01');
    assert.equal(normalizeDateText('2026年8月1日'), '2026-08-01');
    assert.equal(normalizeDateText('2026年8月'), '2026-08-01');
    assert.equal(normalizeDateText('八月一日'), null);
  });

  it('税率既能吃 13 也能吃 13% 与 0.13', () => {
    assert.equal(normalizePercentText('13'), '13');
    assert.equal(normalizePercentText('13%'), '13');
    assert.equal(normalizePercentText(0.13), '13');
    assert.equal(normalizePercentText('130'), null);
    assert.equal(normalizePercentText('abc'), null);
  });

  it('金额/日期在原文里的核对必须是「真命中」而不是恒真', () => {
    const folded = foldText(SAMPLE);
    assert.equal(textHasMoney(folded, '36476.97'), true);
    assert.equal(textHasMoney(folded, '1234.00'), false);
    // 原文只写到月：2026-08-01 仍应视为命中（日缺省）
    assert.equal(textHasDate(folded, '2026-08-01'), true);
    assert.equal(textHasDate(folded, '2026-09-01'), false);
  });
});

describe('register-fields：按条款兜底推断（判不出就返回 null，不猜）', () => {
  it('合同类型：执行合同优先于采购合同', () => {
    assert.equal(guessContractType(foldText('安全劳保采购执行合同')), 'PURCHASE_EXEC');
    assert.equal(guessContractType(foldText('材料采购合同')), 'PURCHASE');
    assert.equal(guessContractType(foldText('设备租赁合同')), 'LEASE');
    assert.equal(guessContractType(foldText('机械设备租赁执行合同')), 'LEASE_EXEC');
    assert.equal(guessContractType(foldText('这是一份说明文件')), null);
  });

  it('付款安排：65% 月度结算 → M65_1，无规则 → null', () => {
    assert.equal(guessPaymentMode(foldText(SAMPLE)), 'M65_1');
    assert.equal(guessPaymentMode(foldText('双方另行约定支付方式')), null);
  });
});

describe('normalizeExtraction：模型输出 → 可审阅草案', () => {
  const raw = {
    supplier: {
      name: '高邑潜玛贸易有限公司',
      legalPerson: '李瑶', // 故意错抽：原文法定代表人栏是空的
      bankName: '中国工商银行股份有限公司高邑支行',
      bankAccount: '0402023709300122764',
      contactName: '李瑶',
      contactPhone: '13931111264',
    },
    contract: {
      code: 'CSCEC-WZCG-ZJJXM-G2-2026003',
      name: '安全劳保采购执行合同',
      typeCode: 'PURCHASE_EXEC',
      signDate: '2026年 8 月',
      amountWithTax: '36,476.97',
      amountWithoutTax: 32280.5,
      taxAmount: 4196.47,
      taxRatePct: '13%',
      paymentMode: 'M65_1',
    },
    items: [
      { name: '安全帽', unit: '顶', qty: 10, unitPriceWithTax: 12, amountWithTax: 120 },
      { name: '马甲', unit: '件', qty: 2, unitPriceWithTax: 30, amountWithTax: 60 },
    ],
    __confidence: { 'contract.code': 0.99, 'supplier.legalPerson': 0.7 },
  };

  const draft = normalizeExtraction(raw, SAMPLE);
  const byKey = new Map(draft.fields.map((f) => [f.key, f]));

  it('抽到的字段都要规整成可落库的形状', () => {
    assert.equal(byKey.get('contract.code')!.value, 'CSCEC-WZCG-ZJJXM-G2-2026003');
    assert.equal(byKey.get('contract.amountWithTax')!.value, '36476.97');
    assert.equal(byKey.get('contract.taxRatePct')!.value, '13');
    assert.equal(byKey.get('contract.signDate')!.value, '2026-08-01');
    assert.equal(byKey.get('contract.typeCode')!.value, 'PURCHASE_EXEC');
    assert.equal(byKey.get('supplier.bankAccount')!.value, '0402023709300122764');
  });

  it('错抽能被原文核对抓出来（联系人不是法定代表人）', () => {
    const legal = byKey.get('supplier.legalPerson')!;
    assert.equal(legal.value, '李瑶');
    // 原文里「李瑶」确实出现了（作为联系人），所以文本核对命不中才是问题——
    // 这里锁的是「联系人字段也在、且两者都指向同一人」这一事实，由前端提示人复核。
    assert.equal(byKey.get('supplier.contactName')!.value, '李瑶');
    assert.equal(legal.value === byKey.get('supplier.contactName')!.value, true);
  });

  it('金额三角对不上时必须给告警', () => {
    const bad = normalizeExtraction(
      { contract: { code: 'X1', name: '测试合同', amountWithTax: 100, amountWithoutTax: 90, taxAmount: 9 } },
      '合同编号：X1 合同名称：测试合同 金额 100 元',
    );
    assert.equal(bad.fields.find((f) => f.key === 'contract.amountWithTax')!.warn, 'cross-check');
    assert.ok(bad.warnings.some((w) => w.includes('不含税')));
  });

  it('明细合计与合同金额不一致要提示（可能只抽到部分明细）', () => {
    assert.ok(draft.warnings.some((w) => w.includes('明细合计')));
    assert.equal(draft.itemsTotal, 180);
  });

  it('必填缺失由程序判，不靠模型自觉', () => {
    const empty = normalizeExtraction({}, '随便一段没有合同要素的文本 合同 协议 甲方 乙方');
    assert.deepEqual(empty.missing.sort(), ['contract.amountWithTax', 'contract.code', 'contract.name', 'supplier.name']);
    const requiredWarn = empty.fields.filter((f) => f.required).map((f) => f.warn);
    assert.deepEqual(requiredWarn, ['missing-required', 'missing-required', 'missing-required', 'missing-required']);
  });

  it('非法枚举值不落库，只记 invalid', () => {
    // 正文里不能出现类型关键词：否则程序兜底会把「瞎编类型」换成推断值（那是另一条用例）
    const bad = normalizeExtraction({ contract: { typeCode: '瞎编类型' } }, '合同 协议 甲方 乙方 货款 结算 金额');
    const f = bad.fields.find((x) => x.key === 'contract.typeCode')!;
    assert.equal(f.value, null);
    assert.equal(f.warn, 'invalid');
  });

  it('模型没给类型/付款安排时按条款兜底', () => {
    const g = normalizeExtraction({ contract: { code: 'A', name: 'b' } }, SAMPLE);
    assert.equal(g.fields.find((f) => f.key === 'contract.typeCode')!.value, 'PURCHASE_EXEC');
    assert.equal(g.fields.find((f) => f.key === 'contract.paymentMode')!.value, 'M65_1');
  });

  it('备注是模型组织的文字，不参与原文核对（否则天天报未匹配）', () => {
    const d = normalizeExtraction({ contract: { remark: '本项目为安全劳保采购，按月结算' } }, SAMPLE);
    const f = d.fields.find((x) => x.key === 'contract.remark')!;
    assert.equal(f.verified, true);
    assert.equal(f.warn, undefined);
  });

  it('法人与联系人识别成同一人时要提示（原文法人栏为空时的典型错抽）', () => {
    const d = normalizeExtraction({ supplier: { legalPerson: '李瑶', contactName: '李瑶' } }, SAMPLE);
    assert.ok(d.warnings.some((w) => w.includes('法定代表人')));
    assert.equal(d.fields.find((x) => x.key === 'supplier.legalPerson')!.warn, 'unverified');
  });

  it('字段目录键唯一，且必填项都在目录里', () => {
    const keys = REGISTER_FIELDS.map((f) => f.key);
    assert.equal(new Set(keys).size, keys.length);
    assert.ok(REGISTER_FIELDS.filter((f) => f.required).length >= 3);
  });
});

describe('docx-text：document.xml → 带表格结构的文本', () => {
  const xml = `<w:document><w:body>
    <w:p><w:r><w:t>合同编号：</w:t></w:r><w:r><w:t>ABC-001</w:t></w:r></w:p>
    <w:tbl>
      <w:tr><w:tc><w:p><w:r><w:t>开户行</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>工行高邑支行</w:t></w:r></w:p></w:tc></w:tr>
      <w:tr><w:tc><w:p><w:r><w:t>账号</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>0402023709300122764</w:t></w:r></w:p></w:tc></w:tr>
    </w:tbl>
    <w:p><w:r><w:t>金额&amp;税额</w:t></w:r></w:p>
  </w:body></w:document>`;

  it('表格行按单元格分隔，段落各占一行', () => {
    const text = docxXmlToText(xml);
    assert.ok(text.includes('合同编号：ABC-001'));
    assert.ok(text.includes('开户行 | 工行高邑支行'));
    assert.ok(text.includes('账号 | 0402023709300122764'));
  });

  it('实体解码与空段丢弃', () => {
    const text = docxXmlToText(xml);
    assert.ok(text.includes('金额&税额'));
    assert.equal(/^\s*$/m.test(text), false);
  });

  it('空文档不抛错', () => {
    assert.equal(docxXmlToText(''), '');
    assert.equal(docxXmlToText('<w:document/>'), '');
  });

  it('像不像合同：短文本/无关文本不认', () => {
    assert.equal(looksLikeContract('短文本'), false);
    assert.equal(looksLikeContract('这是一份很长的技术方案说明，'.repeat(10)), false);
    assert.equal(looksLikeContract(SAMPLE), true);
  });
});

/**
 * 税率落库换算（2026-10-20 审计 P1-3）。
 *
 * 原来 `Math.round(pct)/100`：模型按小数给 `0.13` → round 成 0 → **税率变 0%**；
 * `13.5` → `0.14`（13.5% 被篡改）。税率错了会连锁污染不含税单价、税额与台账进项税额，
 * 所以这里既锁「正确换算」也锁「可疑值必须报错而不是静默猜」。
 */
describe('税率百分数 → 存库小数', () => {
  it('整数百分比：13 → 0.13，9 → 0.09', () => {
    assert.equal(taxRateFraction(13).value, 0.13);
    assert.equal(taxRateFraction(9).value, 0.09);
  });

  it('保留小数位：13.5 → 0.135（不再 round 成 0.14）', () => {
    assert.equal(taxRateFraction(13.5).value, 0.135);
    assert.equal(taxRateFraction(9.09).value, 0.0909);
  });

  it('小数形式的百分数按同口径换算：0.13 → 0.13，而不是 0.0013', () => {
    // 与 normalizePercentText 一致：≤1 视为「0.13 表示 13%」
    assert.equal(taxRateFraction(0.13).value, 0.13);
    assert.equal(taxRateFraction(1).value, 1); // 1 = 100%
  });

  it('0 允许（免税/不征税合同）', () => {
    assert.equal(taxRateFraction(0).value, 0);
    assert.equal(taxRateFraction(0).error, undefined);
  });

  it('负数与超过 100% 一律报错，不截断', () => {
    assert.ok(taxRateFraction(-1).error);
    assert.ok(taxRateFraction(1300).error);
    assert.equal(taxRateFraction(1300).value, null);
  });

  it('未填 → null（不写税率，而不是写 0）', () => {
    assert.equal(taxRateFraction(null).value, null);
    assert.equal(taxRateFraction(undefined).value, null);
    assert.equal(taxRateFraction(Number.NaN).value, null);
  });
});

describe('isRealDay：签订日期必须是真实存在的日期（2026-10-20 审计 P2）', () => {
  it('正常日期通过', () => {
    assert.equal(isRealDay('2026-08-01'), true);
    assert.equal(isRealDay('2024-02-29'), true); // 闰年
  });

  it('格式对但日期不存在 → 拒绝（不再被 Date 静默归一）', () => {
    // new Date('2026-02-30') 会变成 3 月 2 日，原实现只校验格式，签订日期被悄悄改掉
    assert.equal(isRealDay('2026-02-30'), false);
    assert.equal(isRealDay('2025-02-29'), false); // 平年没有 2-29
    assert.equal(isRealDay('2026-04-31'), false);
    assert.equal(isRealDay('2026-13-01'), false);
    assert.equal(isRealDay('2026-00-10'), false);
  });

  it('格式不对 / 空值 → 拒绝', () => {
    assert.equal(isRealDay('2026-8-1'), false);
    assert.equal(isRealDay('2026/08/01'), false);
    assert.equal(isRealDay(''), false);
    assert.equal(isRealDay(null as unknown as string), false);
  });
});