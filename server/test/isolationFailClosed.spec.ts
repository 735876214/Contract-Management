import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { requestContext } from '../src/common/services/request-context';
import { projectWhere, sharedScopeWhere } from '../src/common/utils/project-scope';
import { MISSING_PROJECT_CONTEXT } from '../src/common/utils/project-context-message';
import { API_CODE } from '../src/common/error-codes';

/**
 * **隔离 fail-closed 锁**（2026-11-22 第 24 轮审计 P1）。
 *
 * 改造前是「失败即放行」：`projectWhere()` 拿不到项目上下文就**丢掉 projectId 过滤**，
 * 于是持 `contract:view` 的用户请求 `GET /api/contracts/<别项目 id>` 且**不带 `x-project-id`**
 * 就能读到对方合同详情（含供应商、附件、变更记录）——守卫只保证"登录且有权限码"，
 * 而权限码是全局 RBAC、不带项目维度。采购 `taskOf()` 是同一类口子。
 *
 * 现在的口径：中间件对**每个**请求都会 `run()`（缺项目头时 store 存在、projectId 为空），
 * 所以「请求内 + 没有 projectId」= 客户端异常 → 400 + code 1412；请求之外
 * （seed/脚本/单测/跨项目聚合）才是"按原行为不过滤"。`requestContext.inRequest()` 是唯一判据。
 *
 * ⚠️ 本文件是 `.spec.ts`（ts-node / CJS）：`project-scope.ts` 用的是无扩展名相对 import，
 * Node 原生擦除（`.mts`）解析不了；也不能用 `import.meta`。
 */

const middlewareSrc = readFileSync(path.resolve(__dirname, '../src/main.ts'), 'utf8');

const P1 = 'proj-aaa';

/** 模拟请求内（含"漏带项目头"的情形） */
const inRequest = <T>(projectId: string | undefined, fn: () => T): T => requestContext.run({ projectId }, fn);

const isMissingContext = (e: unknown): boolean => {
  const err = e as { getStatus?: () => number; getResponse?: () => { code?: number; message?: string } };
  const res = err?.getResponse?.();
  return err?.getStatus?.() === 400 && res?.code === API_CODE.PROJECT_CONTEXT_MISSING;
};

describe('requestContext.inRequest：请求内 / 请求外的唯一判据', () => {
  it('中间件对每个请求都 run（缺项目头时 store 存在但 projectId 为空）', () => {
    // 与 main.ts 保持耦合：中间件若改成"没有 projectId 就不 run"，本 spec 全套语义即失效
    assert.match(middlewareSrc, /requestContext\.run\(\{ projectId: projectId \|\| undefined \}/);
    assert.equal(inRequest(undefined, () => requestContext.inRequest()), true);
    assert.equal(inRequest(undefined, () => requestContext.projectId), undefined);
  });

  it('请求之外（seed / 脚本 / 单测）inRequest() 为 false', () => {
    assert.equal(requestContext.inRequest(), false);
    assert.equal(requestContext.projectId, undefined);
  });
});

describe('projectWhere：请求内缺项目上下文一律 400', () => {
  it('漏带项目头 → 400 + code 1412（不是"读全库"）', () => {
    assert.throws(() => inRequest(undefined, () => projectWhere('row-1')), isMissingContext);
  });

  it('带项目头 → 正常追加过滤', () => {
    assert.deepEqual(inRequest(P1, () => projectWhere('row-1')), { id: 'row-1', projectId: P1 });
  });

  it('请求之外 → 保持原行为（不追加过滤）', () => {
    assert.deepEqual(projectWhere('row-1'), { id: 'row-1' });
  });

  it('错误文案走单一来源（与装饰器/服务同一个常量）', () => {
    try {
      inRequest(undefined, () => projectWhere('row-1'));
      assert.fail('应该抛错');
    } catch (e) {
      const res = (e as { getResponse: () => { message: string } }).getResponse();
      assert.equal(res.message, MISSING_PROJECT_CONTEXT);
    }
  });
});

describe('sharedScopeWhere：共享主数据在 PROJECT 模式下同样 fail-closed', () => {
  it('GLOBAL（默认）→ 不加项目过滤（全库共享，本/他项目都可引用）', () => {
    assert.deepEqual(sharedScopeWhere('GLOBAL', P1), {});
    assert.deepEqual(inRequest(undefined, () => sharedScopeWhere('GLOBAL', undefined)), {});
  });

  it('PROJECT + 有上下文 → 按项目过滤', () => {
    assert.deepEqual(sharedScopeWhere('PROJECT', P1), { projectId: P1 });
    assert.deepEqual(inRequest(P1, () => sharedScopeWhere('PROJECT', undefined)), { projectId: P1 });
  });

  it('PROJECT + 请求内缺上下文 → 400（改造前会静默退化成看全库）', () => {
    assert.throws(() => inRequest(undefined, () => sharedScopeWhere('PROJECT', undefined)), isMissingContext);
  });

  it('PROJECT + 请求之外 → 不加过滤（跨项目聚合/单测）', () => {
    assert.deepEqual(sharedScopeWhere('PROJECT', undefined), {});
  });
});
