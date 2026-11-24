// @domains: ledger, contract
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { bootIntApp, makeContract, makeProject, type IntContext } from './helpers';
import { LedgerService } from '../src/modules/ledger';

/**
 * 集成测试 · **台账接口契约**（响应字段集 + 请求参数名），锁住 `web/src/api/types/ledger.ts`。
 *
 * ## 为什么需要它（2026-11-24 起）
 *
 * 1. 前端长期 `http.get<any, any>`，后端加/删/改字段没有任何门禁会红——类型写了等于没写；
 * 2. 更贵的一次在**请求侧**：台账页 `extraFilters` 的 key 写成 `code / type / executionStatus / category`，
 *    而 `findAll()` 认的是 `contractCode / typeCode / execStatus / supplierCategory`，
 *    **四个筛选器全部静默失效**（实测：发 `code=DEMO` 仍返回全部 2 条，发 `contractCode=DEMO` 才收窄成 1 条）。
 *    接口不报错、页面不提示，只有用户发现"筛了跟没筛一样"。
 *
 * ## 两侧都锁
 *
 * - **响应**：`findAll()` 返回的键必须都在 `LEDGER_ROW_KEYS` 里；声明的非 optional 键必须真实出现
 *   （后端偷偷加字段、前端凭空造字段、后端删字段，任一都会红）。
 * - **请求**：`LEDGER_LIST_PARAM_KEYS` 必须与 `findAll()` 真正读取的 `query.*` 键逐字一致。
 *
 * ⚠️ 类型文件是 **按文本解析**的，不是 import：`web/package.json` 是 `"type": "module"`，
 * CJS 的 int spec 不能 `require` 它（`ERR_REQUIRE_ESM`）。所以下面用正则抽 `as const` 数组，
 * 并**先钉死抽到的条数**——格式被改写时本用例会明确报错，而不是静默空转。
 */
const repoRoot = join(__dirname, '..', '..');
const typeSource = readFileSync(join(repoRoot, 'web', 'src', 'api', 'types', 'ledger.ts'), 'utf8');

/** 从 `export const NAME = [ ... ] as const;` 里抽出键名 */
const readKeyArray = (name: string): string[] => {
  const m = typeSource.match(new RegExp(`export const ${name} = \\[([\\s\\S]*?)\\] as const;`));
  assert.ok(m, `没在 web/src/api/types/ledger.ts 里找到 ${name}，本用例的解析锚点已失效`);
  return [...m![1].matchAll(/'([^']+)'/g)].map((x) => x[1]);
};

describe('集成 · 台账接口契约（响应字段集 / 请求参数名）', () => {
  let ctx: IntContext;
  let ledger: LedgerService;

  before(async () => {
    ctx = await bootIntApp();
    ledger = ctx.get<LedgerService>(LedgerService);
  });
  after(async () => {
    await ctx.app.close();
  });

  it('前置：能从前端类型文件抽出三份契约清单（防空转）', () => {
    assert.equal(readKeyArray('LEDGER_ROW_KEYS').length, 48, 'LEDGER_ROW_KEYS 条数变了：确认是真实增删，然后同步这里');
    assert.equal(readKeyArray('LEDGER_ROW_OPTIONAL_KEYS').length, 3, '可选键清单条数变了');
    assert.equal(readKeyArray('LEDGER_LIST_PARAM_KEYS').length, 9, '查询参数清单条数变了');
  });

  it('响应键集与 web 类型声明一致：多一个未声明 / 少一个必填 都红', async () => {
    const project = await makeProject(ctx.prisma, 'shape-ledger');
    await makeContract(ctx.prisma, { projectId: project.id, amount: 1000 });

    const res: any = await ledger.findAll({ page: 1, pageSize: 10 }, project.id);
    assert.equal(res.list.length, 1, '夹具合同应能被台账取到');

    const actual = Object.keys(res.list[0]).sort();
    const declared = readKeyArray('LEDGER_ROW_KEYS').sort();
    const optional = new Set(readKeyArray('LEDGER_ROW_OPTIONAL_KEYS'));

    const undeclared = actual.filter((k) => !declared.includes(k));
    assert.deepEqual(
      undeclared,
      [],
      `后端返回了类型里没声明的字段（请同步 web/src/api/types/ledger.ts 的 LedgerRow + LEDGER_ROW_KEYS）：\n  ${undeclared.join('\n  ')}`,
    );

    const missing = declared.filter((k) => !optional.has(k) && !actual.includes(k));
    assert.deepEqual(
      missing,
      [],
      `类型声明为必填但后端没返回（字段被删 或 该标进 LEDGER_ROW_OPTIONAL_KEYS）：\n  ${missing.join('\n  ')}`,
    );
  });

  it('请求参数名与 findAll() 实际读取的 query.* 键逐字一致', () => {
    const src = readFileSync(join(__dirname, '..', 'src', 'modules', 'ledger', 'ledger.service.ts'), 'utf8');
    const start = src.indexOf('async findAll(');
    assert.ok(start > 0, '没找到 findAll()，本用例的切片锚点已失效');
    const body = src.slice(start, src.indexOf('async summary(', start));
    const used = new Set([...body.matchAll(/query\.([a-zA-Z_][\w]*)/g)].map((m) => m[1]));
    // 分页键由 paginate() 消费，不会以 query.page 的形式出现
    used.add('page');
    used.add('pageSize');

    assert.deepEqual(
      [...used].sort(),
      readKeyArray('LEDGER_LIST_PARAM_KEYS').sort(),
      '台账查询参数名与前端声明不一致——改任一侧都要同步另一侧（页面 extraFilters 的 key 必须来自 LEDGER_LIST_PARAM_KEYS）',
    );
  });
});
