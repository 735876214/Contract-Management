/**
 * 「文件登记」的字段目录与结果规整（**零依赖纯函数**，供 `.mts` 单测直接加载）。
 *
 * 设计取舍：
 * 1. **不信任模型的置信度**。模型自评 0.95 常常是硬凑，所以每个值都回到原文里
 *    再核一遍（金额去千分位、日期按中文/短横线多格式、文本按去空白子串），
 *    核不到就标 `unverified` —— 前端据此高亮，人必须看一眼。
 * 2. **必填项与交叉校验放在这里**，不交给 prompt：模型漏字段是常态，
 *    金额三角（含税 = 不含税 + 税额）和明细合计必须由程序判。
 * 3. 输出的 `value` 一律是**字符串或 null**，数值转换由 service 层做，
 *    这样本文件可以对同一份输入反复断言而不涉及浮点格式差异。
 */

export type RegisterGroup = 'supplier' | 'contract';
export type RegisterFieldType = 'text' | 'code' | 'date' | 'money' | 'percent' | 'enum';

export interface RegisterFieldDef {
  /** 键名形如 `supplier.bankAccount`，与模型输出、前端回传一一对应 */
  key: string;
  label: string;
  group: RegisterGroup;
  type: RegisterFieldType;
  required?: boolean;
  /** enum 字段的可选值：写入值 → 中文说明 */
  options?: Record<string, string>;
  /** 敏感字段（前端提示，值仍原样回填到表单里由人确认） */
  sensitive?: boolean;
  /**
   * 允许模型「写」的字段（摘要/备注）：原文里不可能逐字出现，
   * 强行做子串核对只会天天报「未匹配」，把真正的告警淹掉。
   */
  composed?: boolean;
}

/**
 * 合同类型：只在文本里出现「执行合同」时才算采购执行合同——
 * 执行合同与普通合同在系统里是两种 typeCode，判错会影响后续流程分支。
 */
export const CONTRACT_TYPE_OPTIONS: Record<string, string> = {
  PURCHASE_EXEC: '采购执行合同',
  PURCHASE: '采购合同',
  FRAMEWORK: '框架协议',
  LEASE: '租赁合同',
  LEASE_EXEC: '租赁执行合同',
  EMERGENCY: '紧急采购合同',
};

/** 付款安排：与 `common/utils/pay-ratio.ts` 的 PAYMENT_MODES 键保持一致 */
export const PAYMENT_MODE_OPTIONS: Record<string, string> = {
  '100': '次月 25 日前支付 100%',
  '3382': '第 3 个月 80% + 第 6 个月 20%',
  M65_1: '月度结算：次月 30 日前支付 65%',
  M65_3: '月度结算：次月 20% + 次次月 20% + 次次次月 25%',
  CUSTOM: '自定义（需另填月度结算办理比例）',
};

export const REGISTER_FIELDS: readonly RegisterFieldDef[] = [
  // ── 供货方 ────────────────────────────────────────────────
  { key: 'supplier.name', label: '供应商名称', group: 'supplier', type: 'text', required: true },
  { key: 'supplier.legalPerson', label: '法定代表人', group: 'supplier', type: 'text' },
  { key: 'supplier.bankName', label: '开户银行', group: 'supplier', type: 'text' },
  { key: 'supplier.bankAccount', label: '银行账号', group: 'supplier', type: 'text', sensitive: true },
  { key: 'supplier.address', label: '注册地址', group: 'supplier', type: 'text' },
  { key: 'supplier.contactName', label: '联系人', group: 'supplier', type: 'text' },
  { key: 'supplier.contactPhone', label: '联系电话', group: 'supplier', type: 'text' },
  { key: 'supplier.contactEmail', label: '联系人邮箱', group: 'supplier', type: 'text' },
  // ── 合同 ─────────────────────────────────────────────────
  { key: 'contract.code', label: '合同编号', group: 'contract', type: 'code', required: true },
  { key: 'contract.name', label: '合同名称', group: 'contract', type: 'text', required: true },
  {
    key: 'contract.typeCode',
    label: '合同类型',
    group: 'contract',
    type: 'enum',
    options: CONTRACT_TYPE_OPTIONS,
  },
  { key: 'contract.signDate', label: '签订日期', group: 'contract', type: 'date' },
  { key: 'contract.amountWithTax', label: '合同金额（含税）', group: 'contract', type: 'money', required: true },
  { key: 'contract.amountWithoutTax', label: '不含税金额', group: 'contract', type: 'money' },
  { key: 'contract.taxAmount', label: '税额', group: 'contract', type: 'money' },
  { key: 'contract.taxRatePct', label: '税率', group: 'contract', type: 'percent' },
  { key: 'contract.materialDescription', label: '物资名称', group: 'contract', type: 'text', composed: true },
  {
    key: 'contract.paymentMode',
    label: '付款安排',
    group: 'contract',
    type: 'enum',
    options: PAYMENT_MODE_OPTIONS,
  },
  { key: 'contract.remark', label: '备注', group: 'contract', type: 'text', composed: true },
];

export const registerFieldByKey = (key: string): RegisterFieldDef | undefined =>
  REGISTER_FIELDS.find((f) => f.key === key);

/** 发给模型的字段清单：只给键名与中文标签，让模型照着输出 */
export function registerFieldListText(fields: readonly RegisterFieldDef[] = REGISTER_FIELDS): string {
  const line = (f: RegisterFieldDef) =>
    `- ${f.key}（${f.label}${f.type === 'money' ? '，数字，元' : ''}${f.type === 'percent' ? '，百分数，如 13' : ''}${
      f.type === 'date' ? '，YYYY-MM-DD' : ''
    }${f.options ? `，可选值：${Object.keys(f.options).join('/')}` : ''}）`;
  return ['【供货方】', ...fields.filter((f) => f.group === 'supplier').map(line), '【合同】', ...fields.filter((f) => f.group === 'contract').map(line)].join('\n');
}

export type RegisterWarn = 'unverified' | 'invalid' | 'missing-required' | 'cross-check' | 'duplicate';

export interface ExtractedField {
  key: string;
  label: string;
  group: RegisterGroup;
  type: RegisterFieldType;
  required: boolean;
  sensitive: boolean;
  /** 规整后的值；null = 模型没抽到或判定非法 */
  value: string | null;
  /** 该值能否在原文里找到（程序核对，不信模型自评） */
  verified: boolean;
  /** 模型自评置信度（仅供参考，前端不据此排序） */
  confidence: number | null;
  warn?: RegisterWarn;
  note?: string;
}

export interface RegisterItem {
  name: string | null;
  spec: string | null;
  unit: string | null;
  qty: number | null;
  unitPriceWithTax: number | null;
  amountWithTax: number | null;
}

export interface RegisterDraft {
  fields: ExtractedField[];
  /** 必填项缺失的键名 */
  missing: string[];
  /** 人能读懂的提示（交叉校验失败、未核对等） */
  warnings: string[];
  items: RegisterItem[];
  /** 明细合计（用于和合同总价对账） */
  itemsTotal: number | null;
}

const numOrNull = (v: unknown): number | null => {
  if (v === null || v === undefined || v === '') return null;
  const n = typeof v === 'number' ? v : Number(String(v).replace(/[,，\s￥¥元]/g, ''));
  return Number.isFinite(n) ? n : null;
};

/** 金额文本归一：去掉千分位/货币符号/元，保留负号与小数点 */
export function normalizeMoneyText(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  const s = String(v).replace(/[,，\s￥¥元人民币]/g, '');
  if (!/^-?\d+(\.\d+)?$/.test(s)) return null;
  return s;
}

/** 日期归一：接受 2026-08-01 / 2026/8/1 / 2026.8.1 / 2026年8月1日 / 2026年8月（日缺省为 1） */
export function normalizeDateText(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  // 原文常见「2026年 8 月   日」这种带空格的写法，先去掉空白再匹配
  const s = String(v).replace(/[\s\u3000]+/g, '');
  let m = /^(\d{4})[-/.年](\d{1,2})[-/.月](\d{1,2})日?$/.exec(s);
  if (m) return `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
  m = /^(\d{4})[-/.年](\d{1,2})月?$/.exec(s);
  if (m) return `${m[1]}-${m[2].padStart(2, '0')}-01`;
  return null;
}

/** 百分数归一：13 / 13% / 0.13 → '13'（存百分数，落库时再 /100） */
export function normalizePercentText(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  const s = String(v).replace(/[%％\s]/g, '');
  const n = Number(s);
  if (!Number.isFinite(n)) return null;
  const pct = n > 0 && n <= 1 ? n * 100 : n;
  if (pct <= 0 || pct > 100) return null;
  return String(Math.round(pct * 100) / 100);
}

/** 文本归一：全角括号/空格/换行统一，便于在原文里做子串核对 */
export function normalizeText(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  const s = String(v)
    .replace(/[\s\u3000]+/g, '')
    .replace(/（/g, '(')
    .replace(/）/g, ')')
    .replace(/：/g, ':')
    .trim();
  return s ? s : null;
}

/** 原文也做同样的归一，保证「原文含该值」的判断不会因排版差异失效 */
export function foldText(text: string): string {
  return String(text || '')
    .replace(/[\s\u3000]+/g, '')
    .replace(/（/g, '(')
    .replace(/）/g, ')')
    .replace(/：/g, ':');
}

/** 金额核对：原文里出现 `36476.97` 或 `36,476.97` 或 `36476.97元` 都算命中 */
export function textHasMoney(foldedText: string, value: string): boolean {
  const v = value.replace(/^-/, '');
  if (!v) return false;
  const [int, dec = ''] = v.split('.');
  const intComma = int.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const decShort = dec.replace(/0+$/, '');
  const candidates = new Set<string>([v, intComma + (dec ? '.' + dec : '')]);
  if (decShort) candidates.add(`${int}.${decShort}`), candidates.add(`${intComma}.${decShort}`);
  if (!dec) candidates.add(int), candidates.add(intComma);
  return [...candidates].some((c) => c && foldedText.includes(c));
}

/** 日期核对：原文常写成「2026年8月」「2026年8月1日」，与归一后的 YYYY-MM-DD 对不上，要反推 */
export function textHasDate(foldedText: string, isoDate: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(isoDate);
  if (!m) return false;
  const [, y, mo, d] = m;
  const mm = String(Number(mo));
  const dd = String(Number(d));
  const forms = [
    `${y}年${mm}月${dd}日`,
    `${y}年${mo}月${dd}日`,
    `${y}年${mm}月${dd}`,
    `${y}-${mo}-${d}`,
    `${y}/${mm}/${dd}`,
    `${y}.${mm}.${dd}`,
  ];
  // 「2026年8月 日」这种留空的写法：只认到月，日按 1 号兜底
  if (d === '01') forms.push(`${y}年${mm}月`, `${y}年${mo}月`);
  return forms.some((f) => foldedText.includes(f));
}

/** 从「次月30日前支付当月结算价款的65%」这类条款里认付款安排（认不出返回 null，不猜） */
export function guessPaymentMode(foldedText: string): string | null {
  if (/无预付款|次月30日前.{0,12}65%|支付.{0,8}65%/.test(foldedText)) return 'M65_1';
  if (/次月25日前.{0,10}100%|一次性付款|货到付款/.test(foldedText)) return '100';
  if (/65%.{0,40}85%.{0,40}97%/.test(foldedText)) return 'M65_1';
  return null;
}

/** 从标题/正文判合同类型（执行合同优先，避免「采购合同」把「采购执行合同」吃掉） */
export function guessContractType(foldedText: string): string | null {
  if (/租赁执行合同/.test(foldedText)) return 'LEASE_EXEC';
  if (/租赁合同/.test(foldedText)) return 'LEASE';
  if (/采购执行合同|执行合同/.test(foldedText)) return 'PURCHASE_EXEC';
  if (/框架协议|框架合同/.test(foldedText)) return 'FRAMEWORK';
  if (/紧急采购/.test(foldedText)) return 'EMERGENCY';
  if (/采购合同|供货合同|买卖合同/.test(foldedText)) return 'PURCHASE';
  return null;
}

const MONEY_TOLERANCE = 0.02;

/**
 * 模型原始输出 → 可直接给前端审阅的草案。
 * `text` 必须是**同一份文件抽出来的正文**，核对基于它做。
 */
export function normalizeExtraction(raw: unknown, text: string): RegisterDraft {
  const folded = foldText(text);
  const src = (raw && typeof raw === 'object' ? raw : {}) as Record<string, any>;
  const flat: Record<string, unknown> = {};
  for (const group of ['supplier', 'contract'] as const) {
    const g = src[group];
    if (g && typeof g === 'object' && !Array.isArray(g)) {
      for (const [k, v] of Object.entries(g)) flat[`${group}.${k}`] = v;
    }
  }

  const fields: ExtractedField[] = REGISTER_FIELDS.map((def) => base(def));
  const byKey = new Map(fields.map((f) => [f.key, f]));
  const note = (key: string, warn: RegisterWarn, text: string) => {
    const f = byKey.get(key);
    if (!f) return;
    f.warn = f.warn || warn;
    f.note = f.note ? `${f.note}；${text}` : text;
  };

  // 1) 逐个字段规整 + 原文核对
  for (const f of fields) {
    const def = registerFieldByKey(f.key);
    const rawValue = flat[f.key];
    const confidence = numOrNull((src.__confidence as any)?.[f.key]);
    f.confidence = confidence === null ? null : Math.max(0, Math.min(1, confidence));
    if (rawValue === null || rawValue === undefined || rawValue === '') continue;

    if (f.type === 'money') {
      f.value = normalizeMoneyText(rawValue);
      if (!f.value) note(f.key, 'invalid', '金额格式无法识别');
      else f.verified = textHasMoney(folded, f.value);
    } else if (f.type === 'date') {
      f.value = normalizeDateText(rawValue);
      if (!f.value) note(f.key, 'invalid', '日期格式无法识别');
      else f.verified = textHasDate(folded, f.value);
    } else if (f.type === 'percent') {
      f.value = normalizePercentText(rawValue);
      if (!f.value) note(f.key, 'invalid', '税率无法识别');
      else f.verified = folded.includes(`${f.value}%`) || folded.includes(`${f.value}％`);
    } else if (f.type === 'enum') {
      const v = String(rawValue).trim();
      f.value = def?.options?.[v] !== undefined ? v : null;
      if (!f.value) note(f.key, 'invalid', `取值「${v}」不在可选范围`);
      else f.verified = true; // 枚举由程序按条款推断，不做原文子串核对
    } else {
      f.value = normalizeText(rawValue);
      // 备注/摘要是模型组织过的文字，不参与原文核对
      if (f.value) f.verified = def?.composed ? true : folded.includes(f.value);
    }

    // 只有「给了值但规整失败」才算 invalid；模型本来就没给的可选字段不该报错
    if (!f.value && rawValue !== null && rawValue !== undefined && rawValue !== '') f.warn = f.warn || 'invalid';
    else if (f.value && !f.verified) note(f.key, 'unverified', '原文未匹配到该值（可能是推断）');
  }

  // 2) 程序兜底：类型 / 付款安排 / 物资名称——模型经常整项漏掉
  const numberKeys = ['contract.amountWithTax', 'contract.amountWithoutTax', 'contract.taxAmount'];
  if (!byKey.get('contract.typeCode')?.value) {
    const guess = guessContractType(folded);
    if (guess) {
      Object.assign(byKey.get('contract.typeCode')!, { value: guess, verified: true, warn: undefined, note: '按标题推断' });
    }
  }
  if (!byKey.get('contract.paymentMode')?.value) {
    const guess = guessPaymentMode(folded);
    if (guess) {
      Object.assign(byKey.get('contract.paymentMode')!, {
        value: guess,
        verified: true,
        warn: undefined,
        note: '按付款条款推断',
      });
    }
  }
  // 税率缺失时用 税额 / 不含税 补
  const taxRate = byKey.get('contract.taxRatePct')!;
  if (!taxRate.value) {
    const tax = numOrNull(byKey.get('contract.taxAmount')?.value);
    const noTax = numOrNull(byKey.get('contract.amountWithoutTax')?.value);
    if (tax !== null && noTax && noTax > 0) {
      taxRate.value = String(Math.round((tax / noTax) * 10000) / 100);
      taxRate.verified = false;
      taxRate.note = '按「税额 ÷ 不含税金额」推算';
      taxRate.warn = 'unverified';
    }
  }

  // 3) 交叉校验：法人/联系人同人 + 金额三角 + 明细合计
  const warnings: string[] = [];
  const legalPerson = byKey.get('supplier.legalPerson')?.value;
  const contactName = byKey.get('supplier.contactName')?.value;
  if (legalPerson && contactName && legalPerson === contactName) {
    warnings.push(`法定代表人与联系人都识别为「${legalPerson}」：原文法定代表人栏可能为空，请确认后再提交`);
    note('supplier.legalPerson', 'unverified', '与联系人同名，可能是错抽');
  }
  const withTax = numOrNull(byKey.get('contract.amountWithTax')?.value);
  const noTax = numOrNull(byKey.get('contract.amountWithoutTax')?.value);
  const tax = numOrNull(byKey.get('contract.taxAmount')?.value);
  if (withTax !== null && noTax !== null && tax !== null && Math.abs(noTax + tax - withTax) > MONEY_TOLERANCE) {
    warnings.push(`金额对不上：不含税 ${noTax} + 税额 ${tax} ≠ 含税 ${withTax}`);
    note('contract.amountWithTax', 'cross-check', '与「不含税 + 税额」不符');
  }
  if (withTax !== null && noTax !== null && noTax > withTax) {
    warnings.push('不含税金额大于含税金额');
  }

  const items = toItems(src.items);
  const itemsTotal = items.reduce<number | null>((sum, it) => (it.amountWithTax === null ? sum : (sum ?? 0) + it.amountWithTax), null);
  if (itemsTotal !== null && withTax !== null && Math.abs(itemsTotal - withTax) > MONEY_TOLERANCE) {
    warnings.push(`明细合计 ${round2(itemsTotal)} 与合同金额 ${withTax} 不一致（可能只抽到部分明细）`);
  }

  // 4) 必填缺失
  const missing = fields.filter((f) => f.required && !f.value).map((f) => f.key);
  for (const key of missing) note(key, 'missing-required', '必填项缺失');

  const unverified = fields.filter((f) => f.value && !f.verified).map((f) => f.label);
  if (unverified.length) warnings.push(`以下字段原文未匹配到，请人工核对：${unverified.join('、')}`);

  void numberKeys;
  return { fields, missing, warnings, items, itemsTotal: itemsTotal === null ? null : round2(itemsTotal) };
}

function base(def: RegisterFieldDef): ExtractedField {
  return {
    key: def.key,
    label: def.label,
    group: def.group,
    type: def.type,
    required: !!def.required,
    sensitive: !!def.sensitive,
    value: null,
    verified: false,
    confidence: null,
  };
}

const round2 = (n: number) => Math.round(n * 100) / 100;

function toItems(raw: unknown): RegisterItem[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((r) => {
      const o = (r || {}) as Record<string, unknown>;
      return {
        name: normalizeText(o.name ?? o['物资名称']),
        spec: normalizeText(o.spec ?? o['规格型号']),
        unit: normalizeText(o.unit ?? o['计量单位']),
        qty: numOrNull(o.qty ?? o['数量']),
        unitPriceWithTax: numOrNull(o.unitPriceWithTax ?? o['含税单价']),
        amountWithTax: numOrNull(o.amountWithTax ?? o['含税合价']),
      } satisfies RegisterItem;
    })
    .filter((it) => it.name || it.amountWithTax !== null)
    .slice(0, 500);
}
