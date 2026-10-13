import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { flattenMenu } from '../src/constants/menuTree.ts';
import {
  ROUTE_PERMISSIONS,
  ROUTE_PERMISSION_EXCEPTIONS,
} from '../../web/src/constants/routePermissions.ts';

/**
 * 路由级权限守卫 ↔ 后端菜单「漂移锁」。
 *
 * 背景：权限原只作用于侧边菜单过滤，直接输入 URL 可进入无权页面。前端新增
 * `RequirePermission` + `ROUTE_PERMISSIONS` 做路由拦截；本测试保证：
 *   ① 路由权限表不出现菜单里没有的路径（防陈旧条目）；
 *   ② 菜单里带权限码的路径**必须**被守卫，且守卫条件**不得比菜单更严**
 *      —— 否则会出现「菜单可见、点进去 403」；
 *   ③ 菜单路径都能在前端路由表里找到（防菜单指向不存在的路由）。
 *
 * 三者均为纯静态检查，无 DB / 无网络依赖。
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROUTER_FILE = path.resolve(HERE, '../../web/src/router.tsx');

const menu = flattenMenu();
const menuPaths = new Set(menu.map((m) => m.path));
const gatedPaths = menu.filter((m) => m.permission);

/** 从 router.tsx 提取 children 里的相对路径（`{ path: 'a/b', ... }`） */
function readRouterPaths(): Set<string> {
  const src = fs.readFileSync(ROUTER_FILE, 'utf-8');
  const out = new Set<string>();
  for (const m of src.matchAll(/\{\s*path:\s*'([^']*)'/g)) {
    out.add(m[1].replace(/^\//, ''));
  }
  return out;
}

describe('路由权限守卫 ↔ 菜单一致性（漂移锁）', () => {
  it('路由权限表引用的路径都真实存在于后端菜单（防陈旧条目）', () => {
    const stale = Object.keys(ROUTE_PERMISSIONS).filter((p) => !menuPaths.has(p));
    assert.deepEqual(stale, [], `以下路径不在 MENU_TREE 中，请从 ROUTE_PERMISSIONS 移除：\n  ${stale.join('\n  ')}`);
  });

  it('菜单中带权限码的路径必须被守卫，且守卫条件不得比菜单更严', () => {
    const problems: string[] = [];
    for (const { path: p, permission } of gatedPaths) {
      const codes = ROUTE_PERMISSIONS[p];
      if (!codes) {
        if (!ROUTE_PERMISSION_EXCEPTIONS.includes(p)) {
          problems.push(`${p}：菜单要求 ${permission}，但未登记路由守卫（如确认不拦截请登记进例外清单）`);
        }
        continue;
      }
      if (!codes.includes(permission!)) {
        // 菜单给 code A 的用户可见，路由却只允许 code B → 点进去 403
        problems.push(`${p}：菜单要求 ${permission}，路由守卫却只允许 [${codes.join(', ')}]`);
      }
    }
    assert.deepEqual(problems, [], `发现「菜单可见但路由拦截」或漏守卫：\n  ${problems.join('\n  ')}`);
  });

  it('例外清单不得腐烂：列出的路径必须仍是菜单中带权限的路径', () => {
    const gatedSet = new Set(gatedPaths.map((g) => g.path));
    const stale = ROUTE_PERMISSION_EXCEPTIONS.filter((p) => !gatedSet.has(p));
    assert.deepEqual(
      stale,
      [],
      `以下例外条目已不再是「菜单带权限但有意不守卫」的路径，请移除：\n  ${stale.join('\n  ')}`,
    );
  });

  it('例外清单必须写明理由（在源码中以注释说明，此处校验条目确实存在且有权限）', () => {
    for (const p of ROUTE_PERMISSION_EXCEPTIONS) {
      const node = gatedPaths.find((g) => g.path === p);
      assert.ok(node, `${p} 不在菜单带权限路径中`);
      assert.ok(!ROUTE_PERMISSIONS[p], `${p} 已在 ROUTE_PERMISSIONS 中，不应同时出现在例外清单`);
    }
  });

  it('菜单里的每个路径都能在前端路由表中找到（防菜单指向不存在的路由）', () => {
    const routerPaths = readRouterPaths();
    const missing = [...menuPaths].filter((p) => !routerPaths.has(p.replace(/^\//, '')));
    assert.deepEqual(
      missing,
      [],
      `以下菜单路径在前端 router.tsx 中没有对应路由，点击后会落到兜底重定向：\n  ${missing.join('\n  ')}`,
    );
  });

  it('守卫覆盖面：带权限的菜单路径基本都已纳入（未纳入的只应是显式例外）', () => {
    const unguarded = gatedPaths
      .map((g) => g.path)
      .filter((p) => !ROUTE_PERMISSIONS[p] && !ROUTE_PERMISSION_EXCEPTIONS.includes(p));
    assert.deepEqual(unguarded, []);
    assert.ok(
      Object.keys(ROUTE_PERMISSIONS).length >= 20,
      `ROUTE_PERMISSIONS 条目过少（${Object.keys(ROUTE_PERMISSIONS).length}），可能被误删`,
    );
  });
});
