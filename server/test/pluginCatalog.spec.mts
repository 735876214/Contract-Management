import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { PLUGIN_CATALOG, PLUGIN_PERMISSIONS } from '../src/plugins/generated/plugin-catalog.generated.ts';
import { PERMISSIONS } from '../src/constants/permissions.ts';
import { flattenMenu, MENU_TREE } from '../src/constants/menuTree.ts';
import { hiddenPluginMenuKeys, isPluginEnabled, pluginRuntimeRows } from '../src/plugins/plugin-catalog.ts';
import { ROUTE_PERMISSIONS } from '../../web/src/constants/routePermissions.ts';

/**
 * **构建期插件（B 档）装配漂移锁。**
 *
 * B 档的核心承诺是「插件与手写代码受同样的保护」，本文件就是这句话的证据：
 *   ① 生成物新鲜度：改了 `plugin.json` 忘了跑 `node scripts/gen-plugins.mjs` → 这里红；
 *   ② 权限码：必须是 `<插件名>:` 前缀，且全部进了单一事实源 `PERMISSIONS`；
 *   ③ 菜单/路由：每条插件菜单都必须有路由守卫，且守卫**不得比菜单更严**（与 parity 锁同口径）；
 *   ④ 菜单落地：插件声明的每条菜单都真的出现在权威 `MENU_TREE` 里（挂载点写错会抛错，这里再兜一层）；
 *   ⑤ 启用语义：`CMS_PLUGINS_DISABLED` 能把插件关掉，且关掉后它的菜单会被运行期过滤。
 *
 * 全部纯静态 / 纯函数：无 DB、无网络、不启动 Nest。
 */

const GENERATOR = fileURLToPath(new URL('../../scripts/gen-plugins.mjs', import.meta.url));

describe('构建期插件装配漂移锁', () => {
  it('① 生成物是新鲜的（plugin.json 改过就必须重新生成）', () => {
    // 防恒真：先确认确实扫到了插件，否则「0 个插件」也会让下面的断言全绿
    assert.ok(PLUGIN_CATALOG.length >= 1, `没有发现任何插件，生成器扫描面可能已变`);
    execFileSync(process.execPath, [GENERATOR, '--check'], { stdio: 'pipe' });
  });

  it('② 插件权限码必须是 <插件名>:action 且已并入单一事实源目录', () => {
    const byCode = new Map(PERMISSIONS.map((p) => [p.code, p]));
    const problems: string[] = [];
    for (const plugin of PLUGIN_CATALOG) {
      for (const perm of plugin.permissions) {
        if (!perm.code.startsWith(`${plugin.key}:`)) {
          problems.push(`${plugin.key}：权限码 ${perm.code} 没有 ${plugin.key}: 前缀（角色配置页就分不出它是插件权限）`);
        }
        const canonical = byCode.get(perm.code);
        if (!canonical) {
          problems.push(`${plugin.key}：权限码 ${perm.code} 不在 PERMISSIONS 里（角色永远拿不到这条权限）`);
          continue;
        }
        if (canonical.name !== perm.name || canonical.module !== perm.group) {
          problems.push(
            `${plugin.key}：${perm.code} 的标签与目录不一致（清单 ${perm.name}/${perm.group}，目录 ${canonical.name}/${canonical.module}）`,
          );
        }
      }
    }
    assert.deepEqual(problems, [], `插件权限码有问题：\n  ${problems.join('\n  ')}`);
  });

  it('③ 每条插件菜单都必须有路由守卫，且守卫条件不得比菜单更严', () => {
    const problems: string[] = [];
    for (const plugin of PLUGIN_CATALOG) {
      for (const menu of plugin.menus) {
        const codes = ROUTE_PERMISSIONS[menu.path];
        if (!codes) {
          problems.push(`${plugin.key}：菜单 ${menu.path} 没有登记路由守卫（点进去会绕过前端拦截）`);
          continue;
        }
        if (menu.permission && !codes.includes(menu.permission)) {
          problems.push(`${plugin.key}：菜单 ${menu.path} 要求 ${menu.permission}，守卫却只允许 [${codes.join(', ')}]`);
        }
      }
    }
    assert.deepEqual(problems, [], `插件菜单与路由守卫不一致：\n  ${problems.join('\n  ')}`);
  });

  it('④ 插件菜单确实挂进了权威 MENU_TREE（挂载点/路径/权限码一致）', () => {
    const flat = new Map(flattenMenu().map((m) => [m.path, m]));
    const problems: string[] = [];
    for (const plugin of PLUGIN_CATALOG) {
      for (const menu of plugin.menus) {
        const landed = flat.get(menu.path);
        if (!landed) {
          problems.push(`${plugin.key}：菜单 ${menu.path} 没出现在 MENU_TREE（parent=${menu.parent ?? '顶层'} 可能写错）`);
        } else if (menu.permission && landed.permission !== menu.permission) {
          problems.push(`${plugin.key}：菜单 ${menu.path} 的权限码是 ${landed.permission}，清单声明 ${menu.permission}`);
        }
      }
    }
    assert.deepEqual(problems, [], `插件菜单没有正确落地：\n  ${problems.join('\n  ')}`);
  });

  it('⑤ 插件自带的权限码/菜单没有被写死进核心目录（核心只吃生成物合并）', () => {
    // 反向保护：核心权限目录里除了生成物合并的部分，不应出现任何插件名前缀的码
    const pluginKeys = PLUGIN_CATALOG.map((p) => p.key);
    const coreOnly = PERMISSIONS.filter((p) => !PLUGIN_PERMISSIONS.some((x) => x.code === p.code));
    const leaked = coreOnly.filter((p) => pluginKeys.some((k) => p.code.startsWith(`${k}:`)));
    assert.deepEqual(
      leaked.map((p) => p.code),
      [],
      `以下插件权限码被直接写进了核心目录（应只写在 plugin.json 里，由生成器合并）：${leaked.map((p) => p.code).join(', ')}`,
    );
  });

  it('⑥ CMS_PLUGINS_DISABLED 能关掉插件，且关掉后菜单会在运行期被过滤', () => {
    const target = PLUGIN_CATALOG[0];
    const previous = process.env.CMS_PLUGINS_DISABLED;
    try {
      process.env.CMS_PLUGINS_DISABLED = target.key;
      assert.equal(isPluginEnabled(target.key), false, `${target.key} 应在 CMS_PLUGINS_DISABLED 中被关闭`);
      const row = pluginRuntimeRows().find((r) => r.key === target.key);
      assert.equal(row?.disabledBy, 'env', '禁用原因应标记为 env，而不是静默禁用');
      const hidden = hiddenPluginMenuKeys();
      for (const menu of target.menus) {
        assert.ok(hidden.has(menu.key), `插件被禁用后菜单 ${menu.key} 应进入隐藏集合`);
      }

      process.env.CMS_PLUGINS_DISABLED = '';
      assert.equal(isPluginEnabled(target.key), target.enabledByDefault);
      assert.equal(hiddenPluginMenuKeys().has(target.menus[0].key), !target.enabledByDefault);
    } finally {
      if (previous === undefined) delete process.env.CMS_PLUGINS_DISABLED;
      else process.env.CMS_PLUGINS_DISABLED = previous;
    }
  });

  it('⑦ 已装配插件菜单的 key 在 MENU_TREE 中唯一（不会与核心菜单撞）', () => {
    const keys = MENU_TREE.flatMap(function walk(node): string[] {
      return [node.key, ...(node.children ?? []).flatMap(walk)];
    });
    const dup = keys.filter((k, i) => keys.indexOf(k) !== i);
    assert.deepEqual(dup, [], `菜单 key 重复（React key 冲突、按 key 隐藏插件菜单会误伤）：${dup.join(', ')}`);
  });
});
