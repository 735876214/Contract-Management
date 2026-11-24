import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { PERMISSIONS } from '../src/constants/permissions.ts';

/**
 * **MCP 工具级权限的漂移锁**（2026-11-24 P1）。
 *
 * `mcp/src/resources.ts` 给每个资源声明了 `permissions: { read, write }`，值照抄后端 controller 的
 * `@RequirePermissions`。它是**独立 Node 包**，不能 import `server/src`，于是这些权限码只能靠手抄。
 *
 * 抄错的后果是**静默的**：
 * - 抄成不存在的码（`contract:veiw`）→ 本地永远判定「无权」，有权限的人被挡在门外；
 * - 抄漏 OR 语义（台账只写 `ledger:view`）→ 只有 `contract:view` 的人查不了台账。
 * 两种都不会报错，只会表现为「某个资源在 AI 里消失了」。所以用目录做一次闭环校验。
 *
 * 注意本文件的定位：本地过滤只是 UX，**安全边界在后端**。这条锁保证的是「不漏挡人」，
 * 不是「防越权」——越权由后端各接口自己负责。
 */

const resourcesSrc = readFileSync(
  fileURLToPath(new URL('../../mcp/src/resources.ts', import.meta.url)),
  'utf8',
);

/** 从 `permissions: { read: [...], write: [...] },` 里抽两端权限码 */
function declaredPermissions(): Array<{ read: string[]; write: string[] }> {
  const out: Array<{ read: string[]; write: string[] }> = [];
  const re = /permissions: \{ read: \[([^\]]*)\], write: \[([^\]]*)\] \}/g;
  for (const m of resourcesSrc.matchAll(re)) {
    const parse = (s: string) => [...s.matchAll(/'([^']+)'/g)].map((x) => x[1]);
    out.push({ read: parse(m[1]), write: parse(m[2]) });
  }
  return out;
}

describe('MCP 工具级权限 ↔ 后端权限码目录（漂移锁）', () => {
  it('每个资源都声明了 permissions，且 read 非空（写权限允许为空＝该资源不提供导入）', () => {
    const keys = [...resourcesSrc.matchAll(/^    key: '([a-z-]+)',$/gm)].map((m) => m[1]);
    assert.ok(keys.length >= 14, `只解析到 ${keys.length} 个资源 key，解析面可能已变`);
    const declared = declaredPermissions();
    assert.equal(
      declared.length,
      keys.length,
      `有 ${keys.length} 个资源但只解析到 ${declared.length} 组 permissions——漏声明的资源会既不过滤也不报错`,
    );
    const emptyRead = declared.filter((p) => p.read.length === 0);
    assert.equal(emptyRead.length, 0, `有 ${emptyRead.length} 个资源的 read 为空数组（＝不判断，等于没有工具级权限）`);
  });

  it('声明的每个权限码都真实存在于后端权限码目录（防抄错成不存在的码）', () => {
    const known = new Set(PERMISSIONS.map((p) => p.code));
    const declared = declaredPermissions();
    const unknown: string[] = [];
    for (const p of declared) {
      for (const code of [...p.read, ...p.write]) {
        if (!known.has(code)) unknown.push(code);
      }
    }
    assert.deepEqual(
      [...new Set(unknown)],
      [],
      `mcp/src/resources.ts 里出现了后端不存在的权限码（抄错会让该资源永远被判无权）：${[...new Set(unknown)].join(', ')}`,
    );
  });

  it('权限判断入口是 permissionCodesFor（read 覆盖 query/export/template，import 走 write）', () => {
    // 防恒真：确认这个导出确实存在且服务端仍在用它
    assert.ok(
      /export function permissionCodesFor\(resource: CmsResource, capability: Capability\)/.test(resourcesSrc),
      'permissionCodesFor 的签名变了，server.ts 的调用点与语义注释需同步复查',
    );
    assert.match(
      resourcesSrc,
      /capability === 'import' \? resource\.permissions\.write : resource\.permissions\.read/,
      'permissionCodesFor 必须保持「import 走 write、其余走 read」的映射（与后端 @RequirePermissions 对齐）',
    );
  });

  it('服务端每个工具都调用了 assertAllowed（漏调＝该工具不受工具级权限约束）', () => {
    const serverSrc = readFileSync(fileURLToPath(new URL('../../mcp/src/server.ts', import.meta.url)), 'utf8');
    const gates = serverSrc.match(/await assertAllowed\(/g)?.length ?? 0;
    assert.ok(gates >= 6, `只找到 ${gates} 处 assertAllowed 调用，应为 6 处（5 个资源工具 + export-word）`);
    // cms_list_resources 用 can() 直接判定，不调 assertAllowed；cms_whoami 本身是自省工具，不设闸
    assert.ok(
      /hiddenByPermission/.test(serverSrc),
      'cms_list_resources 必须把「被权限挡掉的资源」显式告诉调用方，否则 AI 会以为系统里没有这些数据',
    );
  });
});
