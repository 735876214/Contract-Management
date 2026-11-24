import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * **插件 → MCP 工具的同源锁**（2026-11-24）。
 *
 * 背景：MCP 工具原来是一份手写清单（`mcp/src/tools.ts`），插件新增的接口对 AI 完全不可见；
 * 想让 AI 用上，只能手工再写一遍工具定义——清单与真实 controller 早晚各说一套。
 * 借鉴 ApeAdmin 的「插件自带 MCP 能力」，但改成**构建期生成**（本项目不做运行时加载插件代码）。
 *
 * 本文件就是这条链路的漂移锁：
 *   ① 生成物新鲜度（改了 plugin.json 忘了生成 → 红）；
 *   ② 清单 ↔ 生成物逐条对应；
 *   ③ 只读：只允许 GET（写操作按 AI 一期口径暂缓）；
 *   ④ path 必须指向插件控制器里真实存在的 @Get（否则 AI 会被导到 404）；
 *   ⑤ 工具级权限非空且都在插件声明的权限码里；
 *   ⑥ 不与核心 MCP 工具撞名；
 *   ⑦ 生成物真的被 mcp 服务注册（防「生成了但没人用」的假装配）。
 *
 * 全部纯静态：无 DB、不启动 Nest、不联网。
 */

const GENERATOR = fileURLToPath(new URL('../../scripts/gen-plugins.mjs', import.meta.url));
const PLUGINS_DIR = fileURLToPath(new URL('../src/plugins/', import.meta.url));
const MCP_ENTRY = fileURLToPath(new URL('../../mcp/src/server.ts', import.meta.url));
const MCP_GENERATED = fileURLToPath(new URL('../../mcp/src/generated/plugin-tools.generated.ts', import.meta.url));

interface ToolParam {
  name: string;
  type: string;
  required?: boolean;
  description: string;
}

interface ToolDecl {
  name: string;
  description: string;
  route: { method: string; path: string };
  permissions: string[];
  params?: ToolParam[];
}

interface Manifest {
  name: string;
  apiPrefix: string;
  permissions: { code: string }[];
  mcpTools?: ToolDecl[];
}

function pluginManifests(): { manifest: Manifest; controller: string }[] {
  const out: { manifest: Manifest; controller: string }[] = [];
  for (const entry of readdirSync(PLUGINS_DIR)) {
    const dir = PLUGINS_DIR + entry;
    if (!statSync(dir).isDirectory() || entry === 'generated') continue;
    const manifestPath = dir + '/plugin.json';
    let manifest: Manifest;
    try {
      manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Manifest;
    } catch {
      continue; // 不是插件目录（例如 README 之外的散文件）
    }
    const controllerPath = dir + '/' + manifest.name + '.controller.ts';
    const controller = statSync(controllerPath).isDirectory() ? '' : readFileSync(controllerPath, 'utf8');
    out.push({ manifest, controller });
  }
  return out;
}

const generated = readFileSync(MCP_GENERATED, 'utf8');
const mcpEntry = readFileSync(MCP_ENTRY, 'utf8');
const plugins = pluginManifests();
const declared = plugins.flatMap((p) => (p.manifest.mcpTools ?? []).map((t) => ({ ...t, plugin: p.manifest })));

describe('插件 MCP 工具同源锁', () => {
  it('① 生成物是新鲜的（改了 plugin.json 的 mcpTools 必须重新生成）', () => {
    execFileSync(process.execPath, [GENERATOR, '--check'], { stdio: 'pipe' });
  });

  it('② 清单里的每个工具都出现在生成物里（且数量一致）', () => {
    for (const t of declared) {
      const prefix = t.plugin.name + '/';
      assert.ok(generated.includes("name: '" + t.name + "'"), '生成物缺少工具 ' + t.name);
      assert.ok(
        generated.includes("path: '/" + t.plugin.apiPrefix + '/' + t.route.path + "'"),
        '工具 ' + t.name + ' 的后端路径没有按 apiPrefix 拼对（期望 /' + t.plugin.apiPrefix + '/' + t.route.path + '）',
      );
      assert.ok(
        generated.includes("permissions: [" + t.permissions.map((c) => "'" + c + "'").join(', ') + ']'),
        '工具 ' + t.name + ' 的权限码没有原样落到生成物里',
      );
      assert.ok(prefix.length > 0);
    }
    const emitted = (generated.match(/^\s{4}name: '[a-z0-9_]+',$/gm) ?? []).length;
    assert.equal(emitted, declared.length, '生成物里的工具条数与 manifest 声明不一致');
  });

  it('③ 只允许 GET：写操作在 AI 一期不暴露（P3-C 暂缓）', () => {
    for (const t of declared) {
      assert.equal(
        String(t.route.method).toUpperCase(),
        'GET',
        '工具 ' + t.name + ' 声明了非 GET 路由。写操作必须先落 TODO.md 里 P3-C 的 5 条前置条件',
      );
    }
  });

  it('④ path 指向插件控制器里真实存在的 @Get（否则 AI 被导到 404）', () => {
    for (const p of plugins) {
      for (const t of p.manifest.mcpTools ?? []) {
        const routePath = t.route.path.replace(/^\/+/, '');
        const declaredInController =
          p.controller.includes("@Get('" + routePath + "')") ||
          (routePath === '' && /@Get\(\s*\)/.test(p.controller));
        assert.ok(
          declaredInController,
          p.manifest.name + '：工具 ' + t.name + ' 指向 @Get(' + routePath + ')，控制器里找不到这条路由',
        );
      }
    }
  });

  it('⑤ 工具级权限必有且 ⊆ 插件声明；工具名带插件前缀且全局唯一', () => {
    const names = new Set<string>();
    for (const t of declared) {
      const own = new Set(t.plugin.permissions.map((p) => p.code));
      assert.ok(t.permissions.length > 0, t.name + ' 没有声明权限码（工具级权限是本项目既定口径）');
      for (const code of t.permissions) {
        assert.ok(own.has(code), t.name + ' 的权限码 ' + code + ' 未在插件 permissions 里声明');
      }
      const expectedPrefix = t.plugin.name.replace(/-/g, '_') + '_';
      assert.ok(t.name.startsWith(expectedPrefix), t.name + ' 必须以 ' + expectedPrefix + ' 开头');
      assert.match(t.name, /^[a-z][a-z0-9_]{2,63}$/);
      assert.ok(!names.has(t.name), '工具名重复：' + t.name);
      names.add(t.name);
    }
  });

  it('⑥ 不与核心 MCP 工具撞名（撞了模型会选错、审计也分不清）', () => {
    const core = new Set<string>();
    for (const m of mcpEntry.matchAll(/\btool\(\s*'([a-z][a-z0-9_]*)'/g)) core.add(m[1]);
    assert.ok(core.size >= 5, '核心工具解析失败（只认出 ' + core.size + ' 个），正则可能已失配');
    for (const t of declared) {
      assert.ok(!core.has(t.name), '插件工具 ' + t.name + ' 与核心 MCP 工具同名');
    }
  });

  it('⑦ 生成物真的被 mcp 服务注册（防「生成了但没人用」）', () => {
    assert.match(mcpEntry, /import \{ PLUGIN_MCP_TOOLS \} from '\.\/generated\/plugin-tools\.generated\.js'/);
    assert.match(mcpEntry, /for \(const t of PLUGIN_MCP_TOOLS\)/);
    // 插件工具也必须过审计包装（否则调用在 OperationLog 里与人工操作无法区分）
    assert.ok(!/server\.registerTool\(\s*t\.name/.test(mcpEntry), '插件工具绕过了 tool() 审计包装');
  });
});
