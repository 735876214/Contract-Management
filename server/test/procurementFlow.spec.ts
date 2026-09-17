import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  TASK_TYPES,
  STAGE_KEYS,
  stageChain,
  stageView,
  contractStageState,
  moduleStageBranches,
  deriveContractType,
  resolveContractUnits,
  CONTRACT_TYPE_LABELS,
  type TaskType,
  type ContractCategory,
} from '../src/constants/procurementFlow';

/**
 * 采购工作流单一事实源（优化点 2）核心纯函数单测。
 * 这些函数无 Prisma 依赖，可在无数据库环境下运行，专门挡「前后端阶段链漂移 / 合同类型推导错误」类回归。
 * 运行：pnpm test（等价于 node --require ts-node/register --test test/*.spec.ts）
 */
describe('procurementFlow 单一事实源', () => {
  it('采购类型仅三种且与枚举一致', () => {
    assert.deepEqual([...TASK_TYPES], ['FRAMEWORK', 'SINGLE', 'EMERGENCY']);
    assert.ok(TASK_TYPES.includes('EMERGENCY'));
  });

  describe('deriveContractType（合同类型五态推导：采购类型 + 采购品类）', () => {
    it('紧急采购恒为 EMERGENCY（无品类之分）', () => {
      assert.equal(deriveContractType('EMERGENCY', null), 'EMERGENCY');
      assert.equal(deriveContractType('EMERGENCY', '物资'), 'EMERGENCY');
      assert.equal(deriveContractType('EMERGENCY', '租赁'), 'EMERGENCY');
    });

    it('引用框架协议：物资→PURCHASE_EXEC，租赁→LEASE_EXEC', () => {
      assert.equal(deriveContractType('FRAMEWORK', '物资'), 'PURCHASE_EXEC');
      assert.equal(deriveContractType('FRAMEWORK', '租赁'), 'LEASE_EXEC');
      // 缺品类默认按物资（采购合同）处理
      assert.equal(deriveContractType('FRAMEWORK', null), 'PURCHASE_EXEC');
    });

    it('单项采购：物资→PURCHASE，租赁→LEASE', () => {
      assert.equal(deriveContractType('SINGLE', '物资'), 'PURCHASE');
      assert.equal(deriveContractType('SINGLE', '租赁'), 'LEASE');
      assert.equal(deriveContractType('SINGLE', null), 'PURCHASE');
    });

    it('表驱动：五种组合全部落到五态枚举内', () => {
      const cases: Array<[TaskType, ContractCategory, string]> = [
        ['SINGLE', '物资', 'PURCHASE'],
        ['SINGLE', '租赁', 'LEASE'],
        ['FRAMEWORK', '物资', 'PURCHASE_EXEC'],
        ['FRAMEWORK', '租赁', 'LEASE_EXEC'],
        ['EMERGENCY', null, 'EMERGENCY'],
      ];
      for (const [type, category, expected] of cases) {
        assert.equal(deriveContractType(type, category), expected, `${type}/${category}`);
      }
    });
  });

  describe('stageChain（阶段链：单一事实源）', () => {
    it('紧急采购：仅总清单 → 生成合同', () => {
      assert.deepEqual(stageChain('EMERGENCY', false).map((s) => s.key), [STAGE_KEYS.TOTAL_LIST]);
      assert.deepEqual(stageChain('EMERGENCY', true).map((s) => s.key), [STAGE_KEYS.TOTAL_LIST]);
    });

    it('引用框架协议：总清单 → 价格对比表 → 框架协议事前说明', () => {
      assert.deepEqual(stageChain('FRAMEWORK', false).map((s) => s.key), [
        STAGE_KEYS.TOTAL_LIST,
        STAGE_KEYS.PRICE_COMPARE,
        STAGE_KEYS.FRAMEWORK_EXPLAIN,
      ]);
    });

    it('单项采购 ≥100万：含采前会；<100万 不含采前会但保留采购公告+采购文件', () => {
      const big = stageChain('SINGLE', true).map((s) => s.key);
      const small = stageChain('SINGLE', false).map((s) => s.key);

      // <100万 必须保留 采购公告(NOTICE) 与 采购文件(DOCUMENT)
      for (const key of [STAGE_KEYS.NOTICE, STAGE_KEYS.DOCUMENT]) {
        assert.ok(small.includes(key), `<100万 阶段链应包含 ${key}`);
      }
      // ≥100万 额外含采前会(PRE_MEETING)，且其余阶段一致
      assert.ok(big.includes(STAGE_KEYS.PRE_MEETING));
      assert.ok(!small.includes(STAGE_KEYS.PRE_MEETING));
      assert.deepEqual(
        big.filter((k) => k !== STAGE_KEYS.PRE_MEETING),
        small,
      );
      // 两者都包含 成交报告 与 价格对比表，且成交报告在价格对比表之前
      assert.ok(big.includes(STAGE_KEYS.RESULT_REPORT));
      assert.ok(big.indexOf(STAGE_KEYS.RESULT_REPORT) < big.indexOf(STAGE_KEYS.PRICE_COMPARE));
    });

    it('单项采购完整顺序：总清单→(采前会)→公告→文件→成交报告→价格对比表', () => {
      assert.deepEqual(stageChain('SINGLE', false).map((s) => s.key), [
        STAGE_KEYS.TOTAL_LIST,
        STAGE_KEYS.NOTICE,
        STAGE_KEYS.DOCUMENT,
        STAGE_KEYS.RESULT_REPORT,
        STAGE_KEYS.PRICE_COMPARE,
      ]);
    });

    it('无效采购类型抛错（门禁不接受第四种采购方式）', () => {
      assert.throws(() => stageChain('UNKNOWN', false), /无效的采购类型/);
    });
  });

  describe('stageView / contractStageState（顺序门禁）', () => {
    const chain = stageChain('SINGLE', false); // 5 个阶段

    it('stage=0：首个阶段可编辑，其余全部锁定', () => {
      assert.deepEqual(stageView(chain, 0), ['editing', 'locked', 'locked', 'locked', 'locked']);
    });

    it('stage=2：前两个已完成，第三个编辑中，其后锁定', () => {
      assert.deepEqual(stageView(chain, 2), ['done', 'done', 'editing', 'locked', 'locked']);
    });

    it('stage=链长：全部已完成（此时才轮到合同阶段）', () => {
      assert.deepEqual(stageView(chain, chain.length), ['done', 'done', 'done', 'done', 'done']);
    });

    it('合同阶段：子阶段未发布完 → locked；发布完 → editing；任务完成 → done', () => {
      assert.equal(contractStageState(chain.length - 1, chain.length, 'PRICE_COMPARE_EDITING'), 'locked');
      assert.equal(contractStageState(chain.length, chain.length, 'CONTRACT_EDITING'), 'editing');
      assert.equal(contractStageState(chain.length, chain.length, 'COMPLETED'), 'done');
    });
  });

  describe('resolveContractUnits（多合同生成）', () => {
    it('单项采购：成交报告多单位 → 一单位一合同', () => {
      const units = resolveContractUnits('SINGLE', [
        { name: '中建三局', finalPreTaxPrice: 1200000 },
        { name: '中建八局', finalPreTaxPrice: '980000.5' },
      ]);
      assert.deepEqual(units, [
        { name: '中建三局', amount: 1200000 },
        { name: '中建八局', amount: 980000.5 },
      ]);
    });

    it('引用框架协议：取事前说明引用供应商及金额', () => {
      const units = resolveContractUnits('FRAMEWORK', [], [
        { supplier: '供应商A', amount: 50000 },
        { supplier: ' 供应商B ', amount: null },
      ]);
      assert.deepEqual(units, [
        { name: '供应商A', amount: 50000 },
        { name: '供应商B', amount: null },
      ]);
    });

    it('空单位/空名称被过滤，不生成无主体合同', () => {
      const units = resolveContractUnits('SINGLE', [
        { name: '  ', finalPreTaxPrice: 100 },
        { name: '', finalPreTaxPrice: 200 },
        { name: '有效单位', finalPreTaxPrice: 300 },
      ]);
      assert.deepEqual(units, [{ name: '有效单位', amount: 300 }]);
    });

    it('上游无单位时回退为单份合同（紧急采购等场景）', () => {
      assert.deepEqual(resolveContractUnits('EMERGENCY'), [{ name: null, amount: null }]);
      assert.deepEqual(resolveContractUnits('SINGLE', [{ name: '' }]), [{ name: null, amount: null }]);
      assert.deepEqual(resolveContractUnits('FRAMEWORK', [], []), [{ name: null, amount: null }]);
    });

    it('非数字金额归一为 null，避免 NaN 落库', () => {
      const units = resolveContractUnits('SINGLE', [
        { name: '甲', finalPreTaxPrice: 'abc' },
        { name: '乙', finalPreTaxPrice: '' },
        { name: '丙', finalPreTaxPrice: '1,000' },
      ]);
      assert.deepEqual(units, [
        { name: '甲', amount: null },
        { name: '乙', amount: null },
        { name: '丙', amount: null },
      ]);
    });
  });

  describe('moduleStageBranches（模块列表阶段门槛：类型 × 条件链 × 最小 stage）', () => {
    /** 模块 key → 阶段 key（与 service 内 MODULE_DELETE_MODELS 保持同一配对） */
    const MODULES: Array<[string, string]> = [
      ['PRE_MEETING', STAGE_KEYS.PRE_MEETING],
      ['NOTICE', STAGE_KEYS.NOTICE],
      ['DOCUMENT', STAGE_KEYS.DOCUMENT],
      ['RESULT_REPORT', STAGE_KEYS.RESULT_REPORT],
      ['PRICE_COMPARE', STAGE_KEYS.PRICE_COMPARE],
      ['FRAMEWORK_EXPLANATION', STAGE_KEYS.FRAMEWORK_EXPLAIN],
    ];

    it('价格对比表同时归属「单项采购」与「引用框架协议」（任务 3.6）', () => {
      const branches = moduleStageBranches('PRICE_COMPARE', STAGE_KEYS.PRICE_COMPARE);
      assert.deepEqual(branches, [
        { type: 'SINGLE', preMeetingRequired: false, stageGte: 4 },
        { type: 'SINGLE', preMeetingRequired: true, stageGte: 5 },
        { type: 'FRAMEWORK', preMeetingRequired: null, stageGte: 1 },
      ]);
    });

    it('框架协议事前说明仅归属「引用框架协议」', () => {
      assert.deepEqual(moduleStageBranches('FRAMEWORK_EXPLANATION', STAGE_KEYS.FRAMEWORK_EXPLAIN), [
        { type: 'FRAMEWORK', preMeetingRequired: null, stageGte: 2 },
      ]);
    });

    it('采前会仅出现在「有采前会」的单项采购链上', () => {
      assert.deepEqual(moduleStageBranches('PRE_MEETING', STAGE_KEYS.PRE_MEETING), [
        { type: 'SINGLE', preMeetingRequired: true, stageGte: 1 },
      ]);
    });

    it('紧急采购不属于任何子模块（其链只有总清单）', () => {
      for (const [moduleKey, stageKey] of MODULES) {
        const branches = moduleStageBranches(moduleKey, stageKey);
        assert.ok(
          branches.every((b) => b.type !== 'EMERGENCY'),
          `${moduleKey} 不应归属紧急采购`,
        );
      }
    });

    it('每个分支的 stageGte 必须等于该模块在对应链中的真实下标（防硬编码漂移）', () => {
      for (const [moduleKey, stageKey] of MODULES) {
        for (const b of moduleStageBranches(moduleKey, stageKey)) {
          const chain =
            b.type === 'SINGLE' ? stageChain('SINGLE', b.preMeetingRequired === true) : stageChain(b.type, false);
          assert.equal(chain[b.stageGte]?.key, stageKey, `${moduleKey}/${b.type} 下标漂移`);
        }
      }
    });

    it('未登记的模块返回空分支（列表查询据此返回空集，避免误放开）', () => {
      assert.deepEqual(moduleStageBranches('UNKNOWN_MODULE', STAGE_KEYS.NOTICE), []);
    });
  });

  it('合同类型标签覆盖五态', () => {
    assert.deepEqual(Object.keys(CONTRACT_TYPE_LABELS), [
      'PURCHASE',
      'LEASE',
      'PURCHASE_EXEC',
      'LEASE_EXEC',
      'EMERGENCY',
    ]);
  });
});
