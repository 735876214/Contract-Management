import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  PROCUREMENT_COMMON_VARS,
  PROCUREMENT_MODULE_VARS,
  PROCUREMENT_MODULES,
  PROCUREMENT_VAR_ALIASES,
  getProcurementVars,
} from '../../web/src/constants/procurementVariables.ts';
import { buildPreMeetingVariableValues } from '../../web/src/utils/preMeetingMinutes.ts';
import { buildNoticeVariableValues } from '../../web/src/utils/procurementNotice.ts';
import { buildDocumentVariableValues } from '../../web/src/utils/procurementDocument.ts';
import { buildResultReportVariableValues } from '../../web/src/utils/procurementResultReport.ts';
import { buildPriceCompareVariableValues } from '../../web/src/utils/procurementPriceCompare.ts';
import { buildExplanationVariableValues } from '../../web/src/utils/frameworkExplanation.ts';

/**
 * 采购模板变量「定义 ↔ 取值」一致性漂移锁。
 *
 * 背景：变量在 `constants/procurementVariables.ts` 声明（供富文本编辑器的「插入变量」面板使用），
 * 值由各模块的 `buildXxxVariableValues()` 产出。**两处会漂移**：
 *   ① 定义了变量却没有任何取值实现 → 模板里插入了占位符，预览永远高亮；
 *   ② 公共变量在某模块取值表里漏了 → 该模块文档出现空值。
 * 本测试把这两类漂移变成 CI 可捕获（无 DB 依赖，纯常量与纯函数）。
 */

/** 相对本文件定位仓库内文件（源码扫描用） */
const here = (rel: string) => fileURLToPath(new URL(rel, import.meta.url));

const PROJECT_CTX = {
  projectName: '滨江商务中心',
  projectCode: 'BJWSZX',
  projectAbbr: '滨江',
  undertaker: '中建八局',
  provinceCity: '浙江省杭州市',
  siteLocation: '滨江区',
  projectAddress: '杭州市滨江区xx路1号',
  materialOrigin: '河北唐山',
  content: '钢筋采购',
};

/** 各模块取值表的构建器（INITIATE 不产出 Word 文档，故无构建器） */
const BUILDERS: Record<string, (data: any, ctx: any) => Record<string, string>> = {
  PRE_MEETING: buildPreMeetingVariableValues as never,
  NOTICE: buildNoticeVariableValues as never,
  DOCUMENT: buildDocumentVariableValues as never,
  RESULT_REPORT: buildResultReportVariableValues as never,
  PRICE_COMPARE: buildPriceCompareVariableValues as never,
  FRAMEWORK: buildExplanationVariableValues as never,
};

/** 各模块最小可用数据（字段与页面表单一致；表格变量给 1 行以验证 HTML 产出） */
const MODULE_DATA: Record<string, Record<string, unknown>> = {
  PRE_MEETING: {
    meetingTime: '2026-10-01',
    content: '钢筋采购',
    host: '张三',
    attendees: '李四、王五',
    writer: '张三',
    reviewer: '李四',
    techQuality: '<p>符合国标</p>',
    acceptance: '<p>现场验收</p>',
    paymentTerms: '<p>月结</p>',
    purchaseItems: [{ materialName: '钢筋', spec: 'HRB400', unit: '吨', qty: 10 }],
    costRows: [{ name: '钢筋', income: 100, cost: 90 }],
  },
  NOTICE: {
    procurementNo: 'PROC-20261001-001',
    procurementTime: '2026-10-01',
    content: '钢筋采购',
    techQuality: '<p>符合国标</p>',
    acceptanceMethod: '<p>现场验收</p>',
    paymentMethod: '<p>月结</p>',
    contacts: ['张三', '李四'],
    contactPhones: ['13800000000', '13900000000'],
    purchaseItems: [{ materialName: '钢筋', spec: 'HRB400', unit: '吨', qty: 10 }],
  },
  DOCUMENT: {
    procurementTime: '2026-10-01',
    responseDeposit: 10000,
    quoteDescription: '<p>按清单报价</p>',
    purchaseItems: [{ materialName: '钢筋', spec: 'HRB400', unit: '吨', qty: 10 }],
  },
  RESULT_REPORT: {
    unitCount: 3,
    openTime: '2026-10-01',
    openPlace: '项目部会议室',
    reviewMembers: '张三、李四',
    approvedCount: 3,
    participantCount: 3,
    abstainCount: 0,
    validFileCount: 3,
    suppliers: [
      {
        name: 'A 单位',
        depositPaid: true,
        sealed: true,
        firstRoundAmount: 100,
        secondRoundAmount: 95,
        throughFirstRound: 'Y',
        recommended: 'Y',
        remark: '',
      },
    ],
    candidates: [{ name: 'A 单位', finalAmount: 95, remark: '' }],
  },
  PRICE_COMPARE: {
    pricingMethod: '固定价',
    benefitAnalysis: '<p>效益分析</p>',
    items: [{ materialName: '钢筋', spec: 'HRB400', unit: '吨', qty: 10, dealPrice: 90 }],
  },
  FRAMEWORK: {
    inquiryRows: [{ name: 'A 单位', amount: 100 }],
    priceCompareRows: [{ name: 'A 单位', amount: 100 }],
    costRows: [{ name: '钢筋', amount: 90 }],
  },
};

/** 模块专属 + 公共 = 面板对外展示的变量集合 */
const definedKeys = (moduleType: string): string[] =>
  getProcurementVars(moduleType).map((v) => v.key);

/**
 * 有意在多个模块共用的同名变量（值取自同一来源，属设计而非疏漏）。
 * 新增条目必须确认「各模块取值来源一致」，否则就会造出「同名异义」那类事故。
 */
const SHARED_ACROSS_MODULES: string[] = [
  // 均取自采购任务自身字段（task.content / task.techQuality / task.acceptanceMethod / task.paymentMethod）
  '采购内容',
  '技术质量标准',
  '验收方式',
  '付款方式',
  // 采购编号：公告侧可编辑（默认取任务编号），采购文件继承公告值（produceTaskDocs 侧已统一口径）
  '采购编号',
  // 采购时间：**业务已确认（2026-10-16）**——公告与采购文件的时间是「编辑各自文件时的时间」，
  // 不是同一个"采购时间"，故两处独立可编辑、各自落库是**有意为之**（变量同名但分属不同模块的面板，不会插错）
  '采购时间',
];

const valueKeys = (moduleType: string): string[] => {
  const build = BUILDERS[moduleType];
  const data = MODULE_DATA[moduleType];
  const ctx = { ...PROJECT_CTX, estimatedAmountWan: 123.45, estimatedAmount: 1234500 };
  return Object.keys(build(data, ctx));
};

const sorted = (xs: string[]): string[] => [...new Set(xs)].sort();

describe('采购变量「定义 ↔ 取值」一致性漂移锁', () => {
  for (const { value: moduleType, label } of PROCUREMENT_MODULES) {
    if (!BUILDERS[moduleType]) {
      it(`${label}（${moduleType}）：无 Word 文档产出，不应定义模块专属变量`, () => {
        assert.deepEqual(
          PROCUREMENT_MODULE_VARS[moduleType],
          [],
          `${moduleType} 的变量定义了却永不替换，应清空`,
        );
      });
      continue;
    }
    it(`${label}（${moduleType}）：面板定义集合 = 取值表 key 集合`, () => {
      assert.deepEqual(
        sorted(valueKeys(moduleType)),
        sorted(definedKeys(moduleType)),
        `${moduleType} 的变量定义与取值表不一致（「定义了没实现」或「实现了没定义」）`,
      );
    });
  }

  it('公共变量在每个模块的取值表中都实际有值（防漏取值）', () => {
    const missing: string[] = [];
    for (const [moduleType] of Object.entries(BUILDERS)) {
      const keys = new Set(valueKeys(moduleType));
      for (const v of PROCUREMENT_COMMON_VARS) if (!keys.has(v.key)) missing.push(`${moduleType}.${v.key}`);
    }
    assert.deepEqual(missing, [], `以下公共变量在某模块取值表中缺失：\n  ${missing.join('\n  ')}`);
  });

  it('公共变量在示例项目上下文中能取到非空值（防「定义了但取数为空」）', () => {
    const empty: string[] = [];
    for (const [moduleType] of Object.entries(BUILDERS)) {
      const build = BUILDERS[moduleType];
      const values = build(MODULE_DATA[moduleType], PROJECT_CTX);
      for (const v of PROCUREMENT_COMMON_VARS) {
        if (!String(values[v.key] ?? '').trim()) empty.push(`${moduleType}.${v.key}`);
      }
    }
    assert.deepEqual(
      empty,
      [],
      `以下公共变量取到了空值（通常意味着上下文字段名与项目记录字段名不一致）：\n  ${empty.join('\n  ')}`,
    );
  });

  it('跨模块同名变量必须是已登记的同源共享（防新增「同名异义」）', () => {
    // 同名本身不是问题——问题在于「同名却取自不同源/不同口径」（如单位不同）。
    // 故此处维护一份**显式**的同源共享白名单：新增跨模块同名而未登记时测试失败，强制复核来源。
    const owner = new Map<string, string[]>();
    for (const moduleType of Object.keys(BUILDERS)) {
      for (const key of PROCUREMENT_MODULE_VARS[moduleType as never]?.map((v) => v.key) ?? []) {
        owner.set(key, [...(owner.get(key) ?? []), moduleType]);
      }
    }
    const newlyShared = [...owner.entries()]
      .filter(([, mods]) => mods.length > 1)
      .map(([key]) => key)
      .filter((key) => !SHARED_ACROSS_MODULES.includes(key));
    assert.deepEqual(
      newlyShared,
      [],
      '以下变量名在多个模块被定义，但未登记为「同源共享」——请确认各模块取值来源一致后登记进 ' +
        `SHARED_ACROSS_MODULES：\n  ${newlyShared.join('\n  ')}`,
    );
  });

  it('同名变量不得出现「带单位」与「不带单位」两种形态并存（单位事故的另一种形态）', () => {
    const all = Object.keys(BUILDERS).flatMap((m) => PROCUREMENT_MODULE_VARS[m as never]?.map((v) => v.key) ?? []);
    const withUnit = new Set(all.filter((k) => /\(.+\)$/.test(k)).map((k) => k.replace(/\(.+\)$/, '')));
    const conflicts = [...new Set(all.filter((k) => !/\(.+\)$/.test(k) && withUnit.has(k)))];
    assert.deepEqual(
      conflicts,
      [],
      `以下变量名同时以「带单位」和「不带单位」两种形态存在，易混用：\n  ${conflicts.join('\n  ')}`,
    );
  });

  it('「预计采购金额」必须带单位后缀，且两模块单位不同（不再回退）', () => {
    const pre = PROCUREMENT_MODULE_VARS.PRE_MEETING.map((v) => v.key);
    const res = PROCUREMENT_MODULE_VARS.RESULT_REPORT.map((v) => v.key);
    assert.ok(pre.includes('预计采购金额(万元)'), '采前会的预计采购金额应带「(万元)」单位后缀');
    assert.ok(res.includes('预计采购金额(元)'), '成交报告的预计采购金额应带「(元)」单位后缀');
    assert.ok(
      !pre.includes('预计采购金额') && !res.includes('预计采购金额'),
      '不允许再出现不带单位的裸变量名「预计采购金额」（会导致万元/元混用，差 10000 倍）',
    );
  });

  it('表格变量在取值表中产出的是 HTML 表格', () => {
    const bad: string[] = [];
    for (const [moduleType, build] of Object.entries(BUILDERS)) {
      const values = build(MODULE_DATA[moduleType], PROJECT_CTX);
      for (const v of PROCUREMENT_MODULE_VARS[moduleType as never] ?? []) {
        if (!v.table) continue;
        if (!String(values[v.key] ?? '').trimStart().toLowerCase().startsWith('<table')) {
          bad.push(`${moduleType}.${v.key}`);
        }
      }
    }
    assert.deepEqual(bad, [], `以下表格变量未产出 <table> HTML：\n  ${bad.join('\n  ')}`);
  });

  it('废弃别名必须指向真实存在的规范变量名，且不与规范名同名', () => {
    const allKeys = new Set(Object.keys(BUILDERS).flatMap((m) => definedKeys(m)));
    const bad: string[] = [];
    for (const [alias, canonical] of Object.entries(PROCUREMENT_VAR_ALIASES)) {
      if (alias === canonical) bad.push(`${alias} → 自身`);
      if (!allKeys.has(canonical)) bad.push(`${alias} → ${canonical}（规范名不存在）`);
      if (allKeys.has(alias)) bad.push(`${alias} 既是别名又是已定义的变量`);
    }
    assert.deepEqual(bad, [], `别名映射不合法：\n  ${bad.join('\n  ')}`);
  });

  /**
   * 「插入变量」面板必须标明**所属体系**——不标时作者会插错体系的变量，且**静默不替换**（正文留着占位符，只有预览才高亮）。
   *
   * 采购模板变量与合同模板变量是两套互不相通的实现：同名 `{{项目名称}}` 由不同代码替换。
   * 面板不标体系时，作者在合同正文里插了采购变量会**静默不替换**（正文留着占位符，只有预览才高亮）。
   * 这里用源码扫描锁住「凡是传了变量列表的编辑器，都要声明体系」。
   */
  it('每个「插入变量」面板都声明了所属体系（variableScope）', () => {
    const webRoot = here('../../web/src');
    /** 收集 .tsx 文件，同时记录**相对 web/src 的 POSIX 路径**（报错要能定位；
        不能用 `file.indexOf('web/src')`——Windows 下根路径是反斜杠，会算成 -1 打出 `x:211` 这种废话）*/
    const files: Array<{ full: string; rel: string }> = [];
    const walk = (dir: string, prefix: string) => {
      for (const name of readdirSync(dir)) {
        const full = `${dir}/${name}`;
        const rel = prefix ? `${prefix}/${name}` : name;
        if (statSync(full).isDirectory()) walk(full, rel);
        else if (name.endsWith('.tsx')) files.push({ full, rel });
      }
    };
    walk(webRoot, '');

    const bad: string[] = [];
    let scanned = 0;
    for (const { full: file, rel } of files) {
      const src = readFileSync(file, 'utf8');
      for (const m of src.matchAll(/<RichTextEditor\b/g)) {
        const start = m.index ?? 0;
        // 扫描到该标签的结束 '>'（跳过花括号/引号内的内容）
        let depth = 0;
        let end = -1;
        for (let i = start; i < src.length; i++) {
          const ch = src[i];
          if (ch === '{' || ch === '[' || ch === '(') depth++;
          else if (ch === '}' || ch === ']' || ch === ')') depth--;
          else if (ch === '>' && depth === 0) {
            end = i;
            break;
          }
        }
        if (end < 0) continue;
        const tag = src.slice(start, end + 1);
        if (!/variables=|variableGroups=/.test(tag)) continue; // 没有变量面板，无需声明体系
        scanned += 1;
        if (!/variableScope=/.test(tag)) {
          const line = src.slice(0, start).split('\n').length;
          bad.push(`web/src/${rel}:${line}`);
        }
      }
    }

    assert.ok(scanned >= 5, `只扫到 ${scanned} 个带变量面板的编辑器，正则或组件改名了（勿让本锁空转）`);
    assert.deepEqual(
      bad,
      [],
      `以下「插入变量」面板未声明 variableScope（作者无法判断该用哪套变量）：\n  ${bad.join('\n  ')}`,
    );
  });
});
