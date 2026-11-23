import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { API_CODE, PROJECT_STALE_CODES, isProjectStaleCode } from '../src/common/error-codes.ts';
import {
  API_CODE as WEB_API_CODE,
  PROJECT_STALE_CODES as WEB_PROJECT_STALE_CODES,
  isProjectStaleCode as webIsProjectStaleCode,
} from '../../web/src/constants/apiCodes.ts';

/**
 * 错误码契约锁（2026-11-22 第 24 轮审计）。
 *
 * 为什么要有稳定 code：前端 `api/http.ts` 原来用 `msg.includes('项目不存在')` 判断
 * 「当前项目已失效 → 刷新项目列表并重放请求」。那是**用中文文案做控制流**：后端改一个字，
 * 自动恢复就静默失效（用户只能手动退出重登），复制到别处也极易漏改。
 *
 * 现在的分工：后端在异常里带 `{ code: 1410/1411/1412, message }`（`common/error-codes.ts`），
 * 前端只认 code（`web/src/constants/apiCodes.ts`），文案仅用于展示。本文件把两份常量、
 * 以及"前端不许再按文案分支"这件事一起钉住。
 */

const here = (rel: string) => fileURLToPath(new URL(rel, import.meta.url));
const httpSrc = readFileSync(here('../../web/src/api/http.ts'), 'utf8');
const filterSrc = readFileSync(here('../src/common/filters/all-exceptions.filter.ts'), 'utf8');
const accessSrc = readFileSync(here('../src/common/services/project-access.service.ts'), 'utf8');
const scopeSrc = readFileSync(here('../src/common/utils/project-scope.ts'), 'utf8');

describe('前后端错误码镜像逐条相等', () => {
  it('API_CODE 完全一致', () => {
    assert.deepEqual(WEB_API_CODE, API_CODE);
  });

  it('「项目已失效」码集合一致（前端据此刷新项目列表）', () => {
    assert.deepEqual([...WEB_PROJECT_STALE_CODES].sort(), [...PROJECT_STALE_CODES].sort());
  });

  it('判定函数行为一致', () => {
    for (const code of [0, 1001, 1401, 1404, 1410, 1411, 1412, 1500, '1411', null, undefined]) {
      assert.equal(webIsProjectStaleCode(code), isProjectStaleCode(code), String(code));
    }
  });

  it('码值不重复，且都在约定段内', () => {
    const values = Object.values(API_CODE);
    assert.equal(new Set(values).size, values.length, 'API_CODE 有重复值');
    for (const v of values) assert.ok(v === 0 || (v >= 1000 && v < 2000), `${v} 不在约定段内`);
  });
});

describe('控制流只认 code，不认文案', () => {
  it('前端 http.ts 不再用中文文案判断项目失效', () => {
    for (const text of ['项目不存在', '无权访问该项目', '缺少项目上下文']) {
      assert.ok(!httpSrc.includes(text), `http.ts 里仍在匹配文案「${text}」——改用 code`);
    }
    assert.match(httpSrc, /isProjectStaleCode\(/, 'http.ts 必须用 isProjectStaleCode() 判定');
  });

  it('后端项目上下文异常带稳定 code（1410/1411/1412）', () => {
    assert.match(accessSrc, /code:\s*API_CODE\.PROJECT_NOT_FOUND/);
    assert.match(accessSrc, /code:\s*API_CODE\.PROJECT_NOT_MEMBER/);
    assert.match(accessSrc, /code:\s*API_CODE\.PROJECT_CONTEXT_MISSING/);
    // 取行原语（服务层最广的入口）同样带码
    assert.match(scopeSrc, /API_CODE\.PROJECT_CONTEXT_MISSING/);
  });

  it('异常过滤器优先采信业务异常自带的 code', () => {
    assert.match(filterSrc, /explicit/, '过滤器未读取异常响应里的 code');
  });
});
