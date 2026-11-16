import type { LlmMessage } from './llm-client';
import { registerFieldListText, type RegisterFieldDef } from './register-fields';

/**
 * 「文件登记」的 prompt（零依赖，可被 `.mts` 单测直接加载）。
 *
 * 与填报表的 prompt 有个本质区别：**这里必须把文件正文整段发给模型**
 * （账号、金额都在正文里），所以调用方要在文档里写清数据边界；
 * 填报表那条「绝不出现字段值」的约定在这里不适用，但反过来——
 * 模型输出不得追加原文没有的内容——由 `register-fields.ts` 的原文核对兜底。
 */

export const REGISTER_JSON_SHAPE = {
  supplier: {
    name: '供应商全称',
    legalPerson: '法定代表人',
    bankName: '开户银行',
    bankAccount: '银行账号',
    address: '注册地址',
    contactName: '联系人',
    contactPhone: '联系电话',
    contactEmail: '联系人邮箱',
  },
  contract: {
    code: '合同编号',
    name: '合同名称',
    typeCode: 'PURCHASE_EXEC',
    signDate: '2026-08-01',
    amountWithTax: 0,
    amountWithoutTax: 0,
    taxAmount: 0,
    taxRatePct: 13,
    materialDescription: '物资或服务内容',
    paymentMode: 'M65_1',
    remark: '一句话摘要',
  },
  items: [{ name: '物资名称', spec: '规格型号', unit: '单位', qty: 0, unitPriceWithTax: 0, amountWithTax: 0 }],
  __confidence: { 'contract.code': 0.95 },
};

export const REGISTER_SYSTEM_PROMPT = [
  '你是企业合同管理系统的合同录入助手。请从给定的合同正文中抽取结构化字段。',
  '',
  '硬性规则：',
  '1. 只输出一个 JSON 对象，不要解释、不要 markdown 代码块。',
  '2. 抽不到或原文没写的字段：**省略该键**，不要填 null、不要猜、不要用常识补。',
  '3. 金额输出数字（单位：元），保留两位小数；不要带千分位和货币符号。',
  '4. 税率输出**百分数**（13 表示 13%），不是小数。',
  '5. 日期输出 YYYY-MM-DD；只写到月的按当月 1 日。',
  '6. 「法定代表人」只从明确标注「法定代表人 / 法人代表」的位置取；联系人、经办人、委托代理人**都不是**法定代表人。',
  '7. 合同类型、付款安排只能从给定可选值里挑一个，判不出来就省略（程序会按条款兜底）。',
  '8. 明细逐行抽取；合计金额以合同正文写明的总价为准，不要用明细求和覆盖它。',
  '9. 另给 `__confidence`：每个已抽字段的把握程度（0~1，只统计你实际输出的键）。',
].join('\n');

export function buildRegisterMessages(input: {
  text: string;
  fields?: readonly RegisterFieldDef[];
  /** 正文截断长度（模型上下文保护），默认 40000 字符 */
  maxChars?: number;
}): LlmMessage[] {
  const maxChars = input.maxChars ?? 40000;
  const body = input.text.length > maxChars ? `${input.text.slice(0, maxChars)}\n……（正文过长，已截断）` : input.text;
  const user = [
    '【可抽取字段】',
    registerFieldListText(input.fields),
    '',
    '【输出示例（仅示意结构，值必须来自正文）】',
    JSON.stringify(REGISTER_JSON_SHAPE, null, 0),
    '',
    '【合同正文】',
    body,
  ].join('\n');
  return [
    { role: 'system', content: REGISTER_SYSTEM_PROMPT },
    { role: 'user', content: user },
  ];
}
