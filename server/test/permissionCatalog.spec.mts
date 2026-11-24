import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { PERMISSIONS } from '../src/constants/permissions.ts';
import { flattenMenu } from '../src/constants/menuTree.ts';

/**
 * **权限码目录单一事实源锁**（2026-11-24 审计 P3）。
 *
 * 真事：迁移 `20261120120000_subcontractor_other_project_libs` 用随机 ID 插入了
 * `subcontractor:*` / `other-project:*` 四条权限，`module` 写成「分包商库 / 其他项目库」，
 * 而 `prisma/seed.ts` 里同一个 code 写的是「基础信息管理」。两边都是
 * `ON CONFLICT ("code") DO NOTHING`——不报错，**谁先跑谁定义标签**，
 * 于是「跑过 seed 的库」和「只跑过迁移的库」在角色配置页（按 `module` 分组）看到两套组名。
 * 同一处迁移还按 `r."name" = '管理员'` 授权：角色改名，新权限就对谁都不显示。
 *
 * 所以标签集中到 `server/src/constants/permissions.ts`，本文件负责证明它确实被遵守：
 *   ① 目录自身体检（code 唯一、形如 `module:action`、三列非空）；
 *   ② 迁移里 `INSERT INTO "Permission"` 的码都在目录里；
 *   ③ 按迁移顺序回放 INSERT + UPDATE 得到的**最终标签**必须等于目录值（治「谁先跑谁定」）；
 *   ④ 新增迁移不得按角色**名称**授权（只认 `Role.code` / `roleId`）；
 *   ⑤ 控制器 `@RequirePermissions(...)` 用到的码都在目录里，且目录里没有无人使用的孤儿码；
 *   ⑥ 前端菜单与路由守卫引用的码都在目录里。
 *
 * 全部静态文本/纯数据检查：无 DB、无网络、无 Nest 启动。
 */

const abs = (rel: string) => fileURLToPath(new URL(`../../${rel}`, import.meta.url));
const read = (rel: string) => readFileSync(abs(rel), 'utf8');

const MIGRATIONS_DIR = 'server/prisma/migrations';

/** 迁移目录按时间戳升序 = `prisma migrate deploy` 的实际执行顺序 */
const migrations = readdirSync(abs(MIGRATIONS_DIR), { withFileTypes: true })
  .filter((d) => d.isDirectory())
  .map((d) => d.name)
  .sort();

/**
 * 历史例外：`20261120120000` 是已上线的历史迁移，**不追改**（改它对已应用的库没有意义）。
 * 它按角色名授权的后果已由 `20261124080000_lib_permission_canonical_labels` 用 Role.code 补齐。
 * **本清单只减不增**：新迁移一律按 `Role.code` 授权。
 */
const NAME_BASED_GRANT_HISTORY = ['20261120120000_subcontractor_other_project_libs'];

const byCode = new Map(PERMISSIONS.map((p) => [p.code, p]));

/** 权限码形态：`module:action`（module 可含连字符，如 other-project） */
const CODE_RE = /'([a-z][a-z-]*:[a-z][a-z-]*)'/g;

interface PermRow {
  code: string;
  name: string;
  module: string;
}

/** 从一段 SQL 里抽 `INSERT INTO "Permission" ... ;` 的行（code/name/module 三个连续字面量） */
function insertedRows(sql: string): PermRow[] {
  const out: PermRow[] = [];
  for (const stmt of sql.matchAll(/INSERT INTO "Permission"[\s\S]*?;/g)) {
    for (const row of stmt[0].matchAll(/'([a-z][a-z-]*:[a-z][a-z-]*)'\s*,\s*'([^']*)'\s*,\s*'([^']*)'/g)) {
      out.push({ code: row[1], name: row[2], module: row[3] });
    }
  }
  return out;
}

/**
 * 回放 `UPDATE "Permission" SET ... [WHERE "code" = 'x' | WHERE "module" = 'y']`。
 * 两种形态都在用：新迁移按 code 定点改标签，`20261031` 按 module 整组改名（劳务 → 分包）。
 */
function applyUpdates(sql: string, state: Map<string, PermRow>): void {
  for (const stmt of sql.matchAll(/UPDATE "Permission"\s+SET([\s\S]*?);/g)) {
    const body = stmt[1];
    const [setPart, wherePart = ''] = body.split(/\bWHERE\b/i);
    const assign: Record<string, string> = {};
    for (const a of setPart.matchAll(/"([A-Za-z]+)"\s*=\s*'([^']*)'/g)) assign[a[1]] = a[2];
    if (!('name' in assign) && !('module' in assign)) continue;

    const byCodeWhere = wherePart.match(/"code"\s*=\s*'([^']+)'/);
    const byModuleWhere = wherePart.match(/"module"\s*=\s*'([^']+)'/);
    const targets = byCodeWhere
      ? [...state.values()].filter((r) => r.code === byCodeWhere[1])
      : byModuleWhere
        ? [...state.values()].filter((r) => r.module === byModuleWhere[1])
        : [];
    for (const t of targets) {
      if (assign.name !== undefined) t.name = assign.name;
      if (assign.module !== undefined) t.module = assign.module;
    }
  }
}

describe('权限码目录（单一事实源）漂移锁', () => {
  it('① 目录自身体检：code 唯一、形如 module:action、name/module 非空', () => {
    assert.ok(PERMISSIONS.length >= 30, `权限目录条目过少（${PERMISSIONS.length}），可能被误删`);
    const seen = new Set<string>();
    for (const p of PERMISSIONS) {
      assert.match(p.code, /^[a-z][a-z-]*:[a-z][a-z-]*$/, `权限码形态不对：${p.code}`);
      assert.ok(!seen.has(p.code), `权限码重复：${p.code}`);
      seen.add(p.code);
      assert.ok(p.name.trim().length > 0, `${p.code} 缺中文名`);
      assert.ok(p.module.trim().length > 0, `${p.code} 缺分组名（角色配置页按它分组）`);
    }
  });

  it('② 迁移里插入的权限码都在目录里（没有「只在 SQL 里存在」的孤儿权限）', () => {
    const missing: string[] = [];
    for (const name of migrations) {
      const file = `${MIGRATIONS_DIR}/${name}/migration.sql`;
      if (!existsSync(abs(file))) continue;
      for (const row of insertedRows(read(file))) {
        if (!byCode.has(row.code)) missing.push(`${name} → ${row.code}`);
      }
    }
    assert.deepEqual(
      missing,
      [],
      `以下迁移插入的权限码不在 server/src/constants/permissions.ts 里，请补进目录：\n  ${missing.join('\n  ')}`,
    );
  });

  it('③ 按迁移顺序回放后，每个权限的最终 name/module == 目录值（治「谁先跑谁定标签」）', () => {
    const state = new Map<string, PermRow>();
    for (const name of migrations) {
      const file = `${MIGRATIONS_DIR}/${name}/migration.sql`;
      if (!existsSync(abs(file))) continue;
      const sql = read(file);
      for (const row of insertedRows(sql)) state.set(row.code, { ...row });
      applyUpdates(sql, state);
    }

    const drift: string[] = [];
    for (const [code, row] of state) {
      const canonical = byCode.get(code);
      if (!canonical) continue; // 已由 ② 负责报错
      for (const col of ['name', 'module'] as const) {
        if (row[col] !== canonical[col]) {
          drift.push(`${code}.${col}：迁移后是「${row[col]}」，目录是「${canonical[col]}」`);
        }
      }
    }
    assert.deepEqual(
      drift,
      [],
      `迁移与目录的权限标签不一致（角色配置页会按 module 分组成两套）：\n  ${drift.join('\n  ')}\n` +
        '  → 新增一个归一迁移（UPDATE "Permission" SET ... WHERE "code" = ...），别改历史迁移。',
    );
  });

  it('④ 新增迁移不得按角色名称授权（只认 Role.code / roleId），历史例外只减不增', () => {
    // 防恒真：历史例外自身必须还在，否则清单腐烂后这条规则会静默失效
    for (const name of NAME_BASED_GRANT_HISTORY) {
      assert.ok(migrations.includes(name), `例外清单里的迁移 ${name} 已不存在，请删除该条目`);
    }

    const offenders: string[] = [];
    for (const name of migrations) {
      if (NAME_BASED_GRANT_HISTORY.includes(name)) continue;
      const file = `${MIGRATIONS_DIR}/${name}/migration.sql`;
      if (!existsSync(abs(file))) continue;
      const sql = read(file);
      for (const stmt of sql.matchAll(/INSERT INTO "RolePermission"[\s\S]*?;/g)) {
        if (/r\."name"\s*=/.test(stmt[0])) offenders.push(name);
      }
    }
    assert.deepEqual(
      offenders,
      [],
      `以下迁移按角色名称授权（角色改名后权限就悬空），请改成 Role.code：\n  ${offenders.join('\n  ')}`,
    );
  });

  it('⑤ 控制器 @RequirePermissions 的码都在目录里，且目录里没有无人使用的孤儿码', () => {
    const used = new Map<string, string[]>();
    const walk = (dir: string): string[] =>
      readdirSync(abs(dir), { withFileTypes: true }).flatMap((d) =>
        d.isDirectory() ? walk(`${dir}/${d.name}`) : d.name.endsWith('.ts') ? [`${dir}/${d.name}`] : [],
      );

    /**
     * 扫描面 = 业务模块 + 构建期插件。插件控制器同样声明 `@RequirePermissions`，
     * 不扫它的话插件权限码会被判成「目录里的孤儿码」（2026-11-24 引入 B 档插件时踩到）。
     */
    const controllerFiles = [
      ...walk('server/src/modules'),
      ...walk('server/src/plugins').filter((f) => f.endsWith('.controller.ts')),
    ];
    for (const file of controllerFiles) {
      const src = read(file);
      for (const deco of src.matchAll(/@RequirePermissions\(([^)]*)\)/g)) {
        for (const m of deco[1].matchAll(CODE_RE)) used.set(m[1], [...(used.get(m[1]) ?? []), file]);
      }
    }
    assert.ok(used.size >= 20, `只扫到 ${used.size} 个 @RequirePermissions 权限码，扫描面可能已变`);

    const unknown = [...used.keys()].filter((c) => !byCode.has(c));
    assert.deepEqual(
      unknown,
      [],
      `以下权限码被控制器使用但不在目录里（角色里不会有这条权限 = 谁都进不去）：\n  ${unknown
        .map((c) => `${c} ← ${(used.get(c) ?? []).join(', ')}`)
        .join('\n  ')}`,
    );

    const orphans = PERMISSIONS.filter((p) => !used.has(p.code)).map((p) => p.code);
    assert.deepEqual(
      orphans,
      [],
      `以下权限码在目录里但没有任何控制器使用（权限码只增不减会长成噪音）：\n  ${orphans.join('\n  ')}`,
    );
  });

  it('⑥ 前端菜单与路由守卫引用的权限码都在目录里', () => {
    const menuCodes = new Set(flattenMenu().map((m) => m.permission).filter(Boolean) as string[]);
    const routeSrc = read('web/src/constants/routePermissions.ts');
    const routeCodes = new Set([...routeSrc.matchAll(CODE_RE)].map((m) => m[1]));

    const unknown = [...new Set([...menuCodes, ...routeCodes])].filter((c) => !byCode.has(c));
    assert.deepEqual(
      unknown,
      [],
      `以下权限码出现在前端菜单/路由守卫里但不在目录里（后端永远不会返回它）：\n  ${unknown.join('\n  ')}`,
    );
    assert.ok(menuCodes.size >= 20, `只扫到 ${menuCodes.size} 个菜单权限码，扫描面可能已变`);
  });
});
