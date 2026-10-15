import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  BIDDER_STATUS,
  CONTRACT_EXECUTION_STATUS,
  CONTRACT_STATUS,
  DICT_TYPES,
  EVALUATION_CONCLUSION,
  INVOICE_REVIEW_STATUS,
  INVOICE_STATUS,
  PAYMENT_STATUS,
  SETTLEMENT_STATUS,
  SITE_CONFIRM_STATUS,
  SUBCONTRACTOR_STATUS,
} from '../src/constants/statuses.ts';
import {
  BIDDER_WON,
  CONTRACT_TYPES,
  CONTRACT_STATUS_TO_TASK_STATUS,
  TASK_STATUS,
  TASK_STATUS_LABELS,
  isFiveStateContractType,
} from '../src/constants/procurementFlow.ts';

/**
 * 核心业务状态 **code 的漂移锁**（评审意见「核心业务枚举不用裸字符串」的配套）。
 *
 * 设计取舍（为什么不改 DB enum / 独立表）：见 `CLAUDE.md` 铁律 4 —— 会与"字典驱动"
 * 「字典驱动、不加数据库枚举」冲突，并牺牲可配置的下拉/颜色/排序。故采取
 * **「code 收敛到 `src/constants/statuses.ts` + 本测试双向锁」**：
 * 字典继续提供 label/color/排序，code 只此一份，两边任何一侧新增/改名都会在这里红。
 *
 * ⚠️ 本文件**不能 import 含相对路径运行时依赖的模块**（Node 原生擦除类型加载 `.mts`，ESM 不做扩展名推断）——
 * 这也是 `constants/procurementFlow.ts` 选择「不 import statuses、用字面量 + 本锁兜」的原因。
 */

const here = (rel: string) => fileURLToPath(new URL(rel, import.meta.url));
const seedDataSrc = readFileSync(here('../src/seed-data.ts'), 'utf8');
const seedSrc = readFileSync(here('../src/seed.ts'), 'utf8');
const schemaSrc = readFileSync(here('../prisma/schema.prisma'), 'utf8');

/** 取 `seed-data.ts`（自动生成物）里某字典类型的 itemCode 列表 */
const dictItems = (typeCode: string): string[] => {
  const out: string[] = [];
  for (const m of seedDataSrc.matchAll(/\{ typeCode: "([a-z_]+)", itemCode: "([A-Z_0-9]+)", itemName: "/g)) {
    if (m[1] === typeCode) out.push(m[2]);
  }
  return out;
};

/** 取 `seed.ts` 里 `fixLegacyData()` 增补的字典项（目前只有 site_confirm_status 走这条路径） */
const legacyDictItems = (typeCode: string): string[] => {
  const start = seedSrc.indexOf(`const typeCode = '${typeCode}'`);
  if (start < 0) return [];
  const end = seedSrc.indexOf('for (const it of items)', start);
  const block = seedSrc.slice(start, end < 0 ? start + 2000 : end);
  return [...block.matchAll(/itemCode: '([A-Z_0-9]+)'/g)].map((m) => m[1]);
};

/** 取 `seed-data.ts` 声明的字典类型 code 全集 */
const declaredDictTypes = (): string[] => [
  ...[...seedDataSrc.matchAll(/\{ code: "([a-z_]+)", name: "/g)].map((m) => m[1]),
  ...[...seedSrc.matchAll(/const typeCode = '([a-z_]+)';/g)].map((m) => m[1]),
];

/** 取 `schema.prisma` 里某个 enum 的取值 */
const schemaEnumValues = (name: string): string[] => {
  const m = new RegExp(`enum ${name}\\s*\\{([^}]*)\\}`).exec(schemaSrc);
  if (!m) return [];
  return m[1]
    .split('\n')
    .map((l) => l.replace(/\/\/.*$/, '').trim())
    .filter((l) => l && !l.startsWith('@@'));
};

const sameSet = (a: string[], b: string[]) =>
  [...new Set(a)].sort().join(',') === [...new Set(b)].sort().join(',');

describe('核心状态 code 漂移锁（常量 ↔ 字典 ↔ schema）', () => {
  it('扫描面非空（防解析失效导致测试恒真）', () => {
    assert.ok(declaredDictTypes().length >= 8, '未解析到字典类型，seed-data 格式可能变了');
    assert.ok(dictItems('settlement_status').length >= 6, '未解析到 settlement_status 字典项');
    assert.deepEqual(schemaEnumValues('ContractType').length, 5, '未解析到 ContractType 五态');
  });

  it('有字典背书的常量组 **集合完全相等** 于对应字典项', () => {
    const cases: Array<[string, Record<string, string>, string[]]> = [
      ['SETTLEMENT_STATUS', SETTLEMENT_STATUS, dictItems(DICT_TYPES.SETTLEMENT_STATUS)],
      ['PAYMENT_STATUS', PAYMENT_STATUS, dictItems(DICT_TYPES.PAYMENT_STATUS)],
      ['INVOICE_STATUS', INVOICE_STATUS, dictItems(DICT_TYPES.INVOICE_STATUS)],
      ['INVOICE_REVIEW_STATUS', INVOICE_REVIEW_STATUS, dictItems(DICT_TYPES.INVOICE_REVIEW_STATUS)],
      ['CONTRACT_EXECUTION_STATUS', CONTRACT_EXECUTION_STATUS, dictItems(DICT_TYPES.CONTRACT_EXECUTION_STATUS)],
      ['SITE_CONFIRM_STATUS', SITE_CONFIRM_STATUS, legacyDictItems(DICT_TYPES.SITE_CONFIRM_STATUS)],
      ['BIDDER_STATUS', BIDDER_STATUS, legacyDictItems(DICT_TYPES.BIDDER_STATUS)],
      ['EVALUATION_CONCLUSION', EVALUATION_CONCLUSION, legacyDictItems(DICT_TYPES.EVALUATION_CONCLUSION)],
    ];
    for (const [name, group, items] of cases) {
      assert.ok(items.length > 0, `${name} 对应字典项为空，检查字典类型是否改名`);
      assert.ok(
        sameSet(Object.values(group), items),
        `${name} 与字典项不一致：\n  常量 = ${Object.values(group).sort().join(', ')}\n  字典 = ${items.sort().join(', ')}`,
      );
    }
  });

  it('五态合同类型 == `schema.prisma` 的 `enum ContractType`，且是字典 `contract_type` 的子集', () => {
    assert.ok(sameSet([...CONTRACT_TYPES], schemaEnumValues('ContractType')), 'CONTRACT_TYPES 与 schema enum ContractType 不一致');
    const dict = dictItems(DICT_TYPES.CONTRACT_TYPE);
    assert.ok(dict.length >= 6, '未解析到 contract_type 字典项');
    for (const code of CONTRACT_TYPES) assert.ok(dict.includes(code), `五态 ${code} 不在字典 contract_type 中`);
    // 字典多出的 FRAMEWORK（框架协议）不属于五态——这是**有意**的，不是漏洞
    assert.deepEqual(dict.filter((c) => !(CONTRACT_TYPES as readonly string[]).includes(c)), ['FRAMEWORK']);
    assert.equal(isFiveStateContractType('FRAMEWORK'), false);
    assert.equal(isFiveStateContractType('PURCHASE_EXEC'), true);
    assert.equal(isFiveStateContractType(null), false);
  });

  it('采购任务状态 == `TASK_STATUS_LABELS` 的键集合（标签表不许漏/多）', () => {
    assert.ok(sameSet(Object.values(TASK_STATUS), Object.keys(TASK_STATUS_LABELS)), 'TASK_STATUS 与 TASK_STATUS_LABELS 键不一致');
  });

  it('合同状态 ↔ 任务状态映射：键 == CONTRACT_STATUS 的取值，值 ∈ TASK_STATUS', () => {
    assert.ok(
      sameSet(Object.keys(CONTRACT_STATUS_TO_TASK_STATUS), Object.values(CONTRACT_STATUS)),
      'CONTRACT_STATUS_TO_TASK_STATUS 的键与 CONTRACT_STATUS 取值不一致（procurementFlow 里是字面量，靠这条锁兜住）',
    );
    for (const v of Object.values(CONTRACT_STATUS_TO_TASK_STATUS)) {
      assert.ok((Object.values(TASK_STATUS) as string[]).includes(v), `映射出的任务状态 ${v} 不在 TASK_STATUS 中`);
    }
  });

  it('招标域：「中标」字面量 == `BIDDER_STATUS.WON`（procurementFlow 里是字面量，靠这条锁兜住）', () => {
    assert.equal(BIDDER_WON, BIDDER_STATUS.WON);
    const src = readFileSync(here('../src/constants/procurementFlow.ts'), 'utf8');
    // 防恒真：确认本文件确实声明了该常量（而不是导入了别处的东西）
    assert.match(src, /export const BIDDER_WON = 'WON'/);
  });

  it('`DICT_TYPES` 里的每个 typeCode 都真实存在（防拼错，validate 才拦得住）', () => {
    const declared = declaredDictTypes();
    for (const [name, code] of Object.entries(DICT_TYPES)) {
      assert.ok(declared.includes(code), `DICT_TYPES.${name} = '${code}' 在种子数据里不存在`);
    }
  });

  it('各组内 code 唯一、命名规范统一（全大写 + 下划线）', () => {
    const groups: Array<[string, Record<string, string>]> = [
      ['CONTRACT_STATUS', CONTRACT_STATUS],
      ['SETTLEMENT_STATUS', SETTLEMENT_STATUS],
      ['PAYMENT_STATUS', PAYMENT_STATUS],
      ['INVOICE_STATUS', INVOICE_STATUS],
      ['INVOICE_REVIEW_STATUS', INVOICE_REVIEW_STATUS],
      ['CONTRACT_EXECUTION_STATUS', CONTRACT_EXECUTION_STATUS],
      ['SITE_CONFIRM_STATUS', SITE_CONFIRM_STATUS],
      ['SUBCONTRACTOR_STATUS', SUBCONTRACTOR_STATUS],
      ['BIDDER_STATUS', BIDDER_STATUS],
      ['EVALUATION_CONCLUSION', EVALUATION_CONCLUSION],
      ['TASK_STATUS', TASK_STATUS],
    ];
    for (const [name, group] of groups) {
      const values = Object.values(group);
      assert.equal(new Set(values).size, values.length, `${name} 组内 code 有重复`);
      for (const v of values) assert.match(v, /^[A-Z][A-Z0-9_]*$/, `${name} 的 '${v}' 命名不规范`);
    }
  });
});
