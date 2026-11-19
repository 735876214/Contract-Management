import 'reflect-metadata';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { DashboardController } from '../src/modules/dashboard/dashboard.controller';
import { PERMISSIONS_KEY } from '../src/common/decorators/permissions.decorator';
import { PROJECT_KEY_PREFIX, projectIdOfStorageKey, projectScopedSub } from '../src/common/utils/storage-keys';
import { PROJECT_SCOPED_TABLES } from '../src/modules/project/project-scoped-tables';
import { MENU_TREE, flattenMenu } from '../src/constants/menuTree';

/**
 * **数据流转隔离锁**（2026-11-19 全量数据流转审计 P1/P2 的回归锁）。
 *
 * 三件事此前**只靠人工审查**发现，没有任何机器判定，改回去也不会红：
 *   ① 看板 / 统计报表接口零权限码 —— 菜单挂了 `dashboard:view`，控制器只校验登录；
 *   ② `/api/files/<键>` 只校验登录 —— 键里不带归属，任一登录用户拿到键就能跨项目下载；
 *   ③ 删除项目前只清点 15 张表 —— 其余 `projectId` 级联表由数据库静默连坐清空。
 *
 * 这里把三者钉住：反射读装饰器元数据 + 静态解析 schema + 纯函数断言，无 DB、无网络。
 * ⚠️ 本文件是 `.spec.ts`（CJS / ts-node）而非 `.mts`：需要 import 带参数属性的 Nest 控制器，
 * Node 的 strip-only TS 模式不支持该语法。
 */

const SCHEMA = path.resolve(__dirname, '../prisma/schema.prisma');

/** 解析 schema：返回所有「projectId 外键 + onDelete: Cascade」的模型名（Prisma 委托名口径） */
function projectCascadeModels(): string[] {
  const lines = fs.readFileSync(SCHEMA, 'utf-8').split(/\r?\n/);
  let cur = '';
  const out: string[] = [];
  for (const line of lines) {
    const m = /^\s*model\s+(\w+)\s*\{/.exec(line);
    if (m) {
      cur = m[1];
      continue;
    }
    if (!cur) continue;
    if (/@relation\(fields:\s*\[projectId\]/.test(line) && /onDelete:\s*Cascade/.test(line)) {
      out.push(cur.charAt(0).toLowerCase() + cur.slice(1));
    }
  }
  return out.sort();
}

describe('看板接口权限码（审计 P1）', () => {
  it('控制器类级要求 dashboard:view，且挂上了 PermissionsGuard', () => {
    const codes: string[] = Reflect.getMetadata(PERMISSIONS_KEY, DashboardController);
    assert.deepEqual(codes, ['dashboard:view'], 'DashboardController 类级缺少 dashboard:view —— 汇总金额会向无权限成员敞开');
    const guards = Reflect.getMetadata('__guards__', DashboardController) || [];
    assert.ok(
      guards.length >= 2,
      'DashboardController 必须同时挂 JwtAuthGuard 与 PermissionsGuard（只挂 JWT 时权限码不生效）',
    );
  });

  it('「我的待办」显式放开（空码表），其余端点继承类级口径', () => {
    const todos = (DashboardController.prototype as any).todos;
    const codes: string[] = Reflect.getMetadata(PERMISSIONS_KEY, todos);
    assert.deepEqual(codes, [], 'todos 必须用 @RequirePermissions() 显式覆盖为「登录即可」（方法级覆盖类级）');
    for (const name of ['overview', 'trend', 'contractType', 'invoiceStats', 'reminders']) {
      const meta = Reflect.getMetadata(PERMISSIONS_KEY, (DashboardController.prototype as any)[name]);
      assert.equal(meta, undefined, `${name} 不应单独覆盖类级权限码`);
    }
  });

  it('菜单里看板 / 统计报表确实要求 dashboard:view（与控制器同码）', () => {
    const byPath = new Map(flattenMenu().map((m) => [m.path, m.permission]));
    assert.equal(byPath.get('/dashboard'), 'dashboard:view');
    assert.equal(byPath.get('/statistics'), 'dashboard:view');
    assert.ok(MENU_TREE.length > 0);
  });
});

describe('文件归属（审计 P1）', () => {
  it('上传键带上项目前缀：p/<projectId>/<YYYY-MM>', () => {
    const sub = projectScopedSub('clx0001', undefined, new Date('2026-11-19T00:00:00Z'));
    const segs = sub.split('/');
    assert.equal(segs[0], PROJECT_KEY_PREFIX);
    assert.equal(segs[1], 'clx0001');
    assert.equal(segs[2], '2026-11');
  });

  it('从键里解析项目 id；历史键 / 非法结构返回 null（按「无归属」处理，不阻断）', () => {
    assert.equal(projectIdOfStorageKey('p/clx0001/2026-11/173-sa.pdf'), 'clx0001');
    assert.equal(projectIdOfStorageKey('signed/1730-ab12.pdf'), null);
    assert.equal(projectIdOfStorageKey('2026-10/1730-ab12.pdf'), null);
    assert.equal(projectIdOfStorageKey('p/..%/2026-11/x.pdf'), null);
    assert.equal(projectIdOfStorageKey('p'), null);
  });

  it('缺少项目上下文时不允许生成项目前缀（不写半截归属）', () => {
    assert.throws(() => projectScopedSub('', '2026-11'), /缺少项目上下文/);
  });
});

describe('删除项目的清点范围（审计 P2）', () => {
  const schemaModels = projectCascadeModels();
  const listed = PROJECT_SCOPED_TABLES.map((t) => t.model).sort();

  it('schema 里确有项目级级联表（防空转）', () => {
    assert.ok(schemaModels.length >= 25, `解析到的项目级级联表过少：${schemaModels.length}`);
  });

  it('清单覆盖 schema 中每一张 projectId 级联表（ProjectMember 除外）', () => {
    const expected = schemaModels.filter((m) => m !== 'projectMember');
    const missing = expected.filter((m) => !listed.includes(m));
    assert.deepEqual(
      missing,
      [],
      `以下表的 projectId 是 onDelete: Cascade，删项目时会被静默清空，却没登记进 PROJECT_SCOPED_TABLES：\n  ${missing.join('\n  ')}`,
    );
  });

  it('清单没有多余条目（模型必须是真实存在且为项目级级联表）', () => {
    const extra = listed.filter((m) => !schemaModels.includes(m));
    assert.deepEqual(extra, [], `PROJECT_SCOPED_TABLES 里这些模型不是项目级级联表（加错/已改名）：\n  ${extra.join('\n  ')}`);
  });

  it('模型与中文标签都不重复（400 提示不会打出两行同样的名字）', () => {
    assert.equal(new Set(listed).size, listed.length, 'PROJECT_SCOPED_TABLES 的 model 有重复');
    const labels = PROJECT_SCOPED_TABLES.map((t) => t.label);
    assert.equal(new Set(labels).size, labels.length, 'PROJECT_SCOPED_TABLES 的 label 有重复');
  });
});
