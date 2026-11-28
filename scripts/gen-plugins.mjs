#!/usr/bin/env node
/**
 * 构建期插件（B 档）装配生成器。
 *
 * 输入：server/src/plugins/<key>/plugin.json（唯一事实源）
 * 输出：
 *   - server/src/plugins/generated/plugin-catalog.generated.ts   纯数据，可被 .mts 单测直接加载
 *   - server/src/plugins/generated/plugin-modules.generated.ts   唯一 import 插件 Nest 模块的文件
 *   - web/src/plugins/generated/plugin-catalog.generated.ts      同数据的 web 投影
 *   - web/src/router.tsx 的 <plugin-lazy> / <plugin-routes> 两个标记块内部
 *
 * 为什么生成而不是运行时扫描：本仓有 5 个静态门禁检查器 + 4 个漂移锁 spec，
 * 运行时加载的代码拿不到任何一项保护。生成物入库、CI 查新鲜度（--check），
 * 于是插件装配结果与手写代码一样是静态可检查的。详见 server/src/plugins/README.md
 *
 * 用法：
 *   node scripts/gen-plugins.mjs           生成 / 刷新
 *   node scripts/gen-plugins.mjs --check   只校验新鲜度（CI 与单测用）
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PLUGINS_DIR = path.join(REPO, 'server/src/plugins');
const CORE_MODULES_DIR = path.join(REPO, 'server/src/modules');
const MENU_TREE_FILE = path.join(REPO, 'server/src/constants/menuTree.ts');
const ICON_HELPER_FILE = path.join(REPO, 'web/src/components/Sider/utils/iconHelper.tsx');
const ROUTER_FILE = path.join(REPO, 'web/src/router.tsx');
const CHECK = process.argv.includes('--check');

const errors = [];
const fail = (msg) => errors.push(msg);
const readText = (p) => readFileSync(p, 'utf8');
const VERSION_RE = /^\d+\.\d+\.\d+$/;
const KEY_RE = /^[a-z][a-z0-9-]{1,30}$/;
const DEP_RE = /^([a-z][a-z0-9-]*)(>=|==|<=|>|<)(\d+\.\d+\.\d+)$/;
const PERM_RE = /^[a-z][a-z-]*:[a-z][a-z-]*$/;
const CORE_VERSION = JSON.parse(readText(path.join(REPO, 'server/package.json'))).version;

// ---------- 插件 MCP 工具（2026-11-24）----------
// 借 ApeAdmin 的「插件自带 MCP 能力」，但**不抄它的运行时注册**：这里把 plugin.json 的
// mcpTools 校验后生成为 mcp/ 侧的静态清单，MCP 包照旧是编译期装配，不加载任何插件代码。
const MCP_TOOL_NAME_RE = /^[a-z][a-z0-9_]{2,63}$/;
const MCP_PARAM_NAME_RE = /^[a-zA-Z][a-zA-Z0-9]{0,30}$/;
const MCP_PARAM_TYPES = new Set(['string', 'number', 'boolean']);
const ROUTE_DECORATORS = ['Get', 'Post', 'Put', 'Patch', 'Delete'];
const allMcpToolNames = new Map();

/** 扫控制器里真实存在的路由，形如 Get summary / Post（无参） */
function routesOf(src) {
  const out = new Set();
  for (const name of ROUTE_DECORATORS) {
    const bare = new RegExp('@' + name + '\\(\\s*\\)');
    if (bare.test(src)) out.add(name.toUpperCase() + ' ');
    const withArg = new RegExp('@' + name + '\\(\\s*[\'`\"]([^\'`\"]*)[\'`\"]\\s*\\)', 'g');
    let hit;
    while ((hit = withArg.exec(src))) out.add(name.toUpperCase() + ' ' + hit[1]);
  }
  return out;
}

/** dev-example -> DevExample */
const pascal = (s) => s.split(/[-_]/).map((p) => p.charAt(0).toUpperCase() + p.slice(1)).join('');
/** 清单字符串一律禁止单引号与换行，生成物因此可以安全地做单引号字面量 */
const q = (s) => "'" + String(s) + "'";
const FORBIDDEN_IN_STRING = /['\r\n]/;

// ---------- 核心菜单顶层分组（插件只能挂到分组下，或自己开分组） ----------
const menuTreeSrc = readText(MENU_TREE_FILE);
const coreGroupKeys = new Set([
  ...[...menuTreeSrc.matchAll(/^ {2}\{ key: '([a-z-]+)'/gm)].map((m) => m[1]),
  ...[...menuTreeSrc.matchAll(/^ {4}key: '([a-z-]+)'/gm)].map((m) => m[1]),
]);
if (coreGroupKeys.size < 5) {
  console.error('[gen-plugins] 解析 menuTree.ts 顶层分组失败（只认到 ' + coreGroupKeys.size + ' 个），生成器格式假设已变');
  process.exit(2);
}

// ---------- ICON_MAP（菜单图标必须已注册，否则前端静默降级成 FileOutlined） ----------
const iconSrc = readText(ICON_HELPER_FILE);
const iconBlock = iconSrc.match(/const ICON_MAP: Record<string,[^=]*=\s*\{([\s\S]*?)\n\};/);
const iconNames = new Set();
if (iconBlock) {
  for (const m of iconBlock[1].matchAll(/^\s*([A-Z][A-Za-z0-9_]+),?\s*$/gm)) iconNames.add(m[1]);
  for (const m of iconSrc.matchAll(/ICON_MAP\.([A-Za-z0-9_]+)\s*=/g)) iconNames.add(m[1]);
}
if (iconNames.size < 20) {
  console.error('[gen-plugins] 解析 ICON_MAP 失败（只认到 ' + iconNames.size + ' 个图标），生成器格式假设已变');
  process.exit(2);
}

const coreModuleNames = new Set(
  readdirSync(CORE_MODULES_DIR, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name),
);

const pluginDirs = readdirSync(PLUGINS_DIR, { withFileTypes: true })
  .filter((d) => d.isDirectory() && d.name !== 'generated' && !d.name.startsWith('_'))
  .map((d) => d.name)
  .sort();

const catalog = [];

for (const dirName of pluginDirs) {
  const dir = path.join(PLUGINS_DIR, dirName);
  const manifestPath = path.join(dir, 'plugin.json');
  if (!existsSync(manifestPath)) {
    fail(dirName + '：缺少 plugin.json');
    continue;
  }
  let manifest;
  try {
    manifest = JSON.parse(readText(manifestPath));
  } catch (e) {
    fail(dirName + '：plugin.json 不是合法 JSON（' + e.message + '）');
    continue;
  }
  const at = (field) => dirName + '.plugin.json > ' + field;

  if (!KEY_RE.test(String(manifest.name || ''))) fail(at('name') + '：必须是 ' + KEY_RE.source);
  if (manifest.name !== dirName) fail(at('name') + '：必须与目录名一致（目录=' + dirName + '，清单=' + manifest.name + '）');
  if (coreModuleNames.has(manifest.name)) fail(at('name') + '：与 server/src/modules/' + manifest.name + ' 撞名');
  if (!VERSION_RE.test(String(manifest.version || ''))) fail(at('version') + '：必须是 x.y.z');
  for (const f of ['displayName', 'description', 'author']) {
    if (typeof manifest[f] !== 'string' || !manifest[f].trim()) fail(at(f) + '：不能为空');
    else if (FORBIDDEN_IN_STRING.test(manifest[f])) fail(at(f) + '：不能含单引号或换行（会破坏生成物字面量）');
  }
  if (typeof manifest.enabledByDefault !== 'boolean') fail(at('enabledByDefault') + '：必须是布尔值');

  // ---------- 依赖 ----------
  const dependencies = Array.isArray(manifest.dependencies) ? manifest.dependencies : [];
  if (!Array.isArray(manifest.dependencies)) fail(at('dependencies') + '：必须是字符串数组');
  for (const dep of dependencies) {
    if (typeof dep !== 'string' || !DEP_RE.test(dep)) fail(at('dependencies') + '：' + dep + ' 必须形如 core>=1.1.0');
  }

  // ---------- 权限 ----------
  const permissions = Array.isArray(manifest.permissions) ? manifest.permissions : [];
  if (!Array.isArray(manifest.permissions)) fail(at('permissions') + '：必须是数组');
  for (const p of permissions) {
    const code = String(p && p.code);
    if (!PERM_RE.test(code) || !code.startsWith(manifest.name + ':')) {
      fail(at('permissions') + '：' + code + ' 必须是 ' + manifest.name + ':action（小写字母与连字符）');
    }
    if (!p || !p.name || !p.group) fail(at('permissions') + '：' + code + ' 缺少 name 或 group');
    else if (FORBIDDEN_IN_STRING.test(String(p.name) + String(p.group))) fail(at('permissions') + '：' + code + ' 的 name/group 不能含单引号或换行');
  }
  const permCodes = new Set(permissions.map((p) => p && p.code));

  // ---------- 菜单 ----------
  const menus = Array.isArray(manifest.menus) ? manifest.menus : [];
  if (!Array.isArray(manifest.menus)) fail(at('menus') + '：必须是数组');
  if (menus.length === 0) fail(at('menus') + '：至少声明一条菜单（否则插件页面没有入口）');
  for (const m of menus) {
    for (const f of ['key', 'label', 'icon', 'path']) {
      if (!m || typeof m[f] !== 'string' || !m[f].trim()) fail(at('menus') + '：条目缺少 ' + f);
    }
    if (!m) continue;
    if (m.label && FORBIDDEN_IN_STRING.test(m.label)) fail(at('menus') + '：' + m.key + ' 的 label 不能含单引号或换行');
    if (typeof m.path === 'string' && !m.path.startsWith('/')) fail(at('menus') + '：path 必须以 / 开头（' + m.path + '）');
    if (!m.permission) {
      fail(at('menus') + '：' + m.key + ' 没有 permission（无权限码的插件菜单对所有登录用户可见，必须显式声明）');
    } else if (!permCodes.has(m.permission)) {
      fail(at('menus') + '：' + m.key + ' 引用了未声明的权限码 ' + m.permission + '（先在 permissions 里声明）');
    }
    if (m.parent && !coreGroupKeys.has(m.parent)) {
      fail(at('menus') + '：' + m.key + ' 的 parent=' + m.parent + ' 不在核心菜单分组里（可用：' + [...coreGroupKeys].join(' / ') + '）');
    }
    if (m.icon && !iconNames.has(m.icon)) {
      fail(at('menus') + '：' + m.key + ' 的图标 ' + m.icon + ' 未在 web/src/components/Sider/utils/iconHelper.tsx 的 ICON_MAP 注册');
    }
  }
  if (new Set(menus.map((m) => m && m.key)).size !== menus.length) fail(at('menus') + '：key 重复');

  // ---------- API 前缀 ----------
  const apiPrefix = String(manifest.apiPrefix || '');
  if (apiPrefix !== 'plugin/' + manifest.name) fail(at('apiPrefix') + '：必须等于 plugin/' + manifest.name);

  // ---------- 后端入口 ----------
  const nestModule = pascal(manifest.name) + 'Module';
  const entryFile = path.join(dir, 'index.ts');
  if (!existsSync(entryFile)) {
    fail(dirName + '：缺少 index.ts 门面（其他模块只允许从门面引用插件）');
  } else if (!new RegExp('export\\s*\\{[^}]*\\b' + nestModule + '\\b[^}]*\\}').test(readText(entryFile))) {
    fail(dirName + '：index.ts 必须导出 ' + nestModule + '（插件名按 - 分词的 PascalCase + Module）');
  }
  const controllerFile = path.join(dir, manifest.name + '.controller.ts');
  if (!existsSync(controllerFile)) {
    fail(dirName + '：缺少 ' + manifest.name + '.controller.ts');
  } else {
    const controllerSrc = readText(controllerFile);
    const expected = '@Controller(' + q(apiPrefix) + ')';
    if (!controllerSrc.includes(expected)) {
      fail(dirName + '：' + manifest.name + '.controller.ts 必须写 ' + expected + '（与 plugin.json 的 apiPrefix 一致）');
    }
    for (const p of permCodes) {
      if (!controllerSrc.includes(q(p))) fail(dirName + '：权限码 ' + p + ' 已声明但控制器从未使用（权限码只增不减会长成噪音）');
    }
  }
  const controllerText = existsSync(controllerFile) ? readText(controllerFile) : '';

  // ---------- 前端入口 ----------
  const webEntry = 'web/src/plugins/' + manifest.name + '/index.tsx';
  if (!existsSync(path.join(REPO, webEntry))) {
    fail(dirName + '：缺少 ' + webEntry);
  } else if (!/export default/.test(readText(path.join(REPO, webEntry)))) {
    fail(dirName + '：' + webEntry + ' 必须以 export default 导出页面组件');
  }

  // ---------- MCP 工具（只读，映射到本插件的 GET 接口）----------
  const mcpToolPrefix = manifest.name.replace(/-/g, '_') + '_';
  const permSet = new Set(permCodes);
  const pluginRoutes = routesOf(controllerText);
  const rawTools = Array.isArray(manifest.mcpTools) ? manifest.mcpTools : [];
  const mcpTools = [];
  rawTools.forEach((t, i) => {
    const where = at('mcpTools[' + i + ']');
    if (!t || typeof t !== 'object') return fail(where + '：必须是对象');
    const name = String(t.name || '');
    if (!MCP_TOOL_NAME_RE.test(name)) return fail(where + '：工具名只能是 a-z0-9_，3~64 字符（MCP 侧要求）');
    if (!name.startsWith(mcpToolPrefix)) {
      return fail(where + '：工具名必须以 ' + mcpToolPrefix + ' 开头（插件名前缀，避免与核心工具撞名）');
    }
    if (allMcpToolNames.has(name)) {
      return fail(where + '：工具名 ' + name + ' 与插件 ' + allMcpToolNames.get(name) + ' 重复');
    }
    allMcpToolNames.set(name, manifest.name);
    const description = String(t.description || '').trim();
    if (!description) return fail(where + '：缺 description（模型靠它选工具，必填）');
    if (description.length > 200) return fail(where + '：description 超过 200 字（模型提示预算有限）');
    if (FORBIDDEN_IN_STRING.test(description)) return fail(where + '：description 不能含单引号或换行');

    const route = t.route && typeof t.route === 'object' ? t.route : null;
    if (!route) return fail(where + '：缺 route（形如 { "method": "GET", "path": "summary" }）');
    const method = String(route.method || '').toUpperCase();
    if (method !== 'GET') {
      return fail(
        where + '：method 只允许 GET。写操作（POST/PUT/PATCH/DELETE）按 AI 一期口径暂缓（见 TODO.md P3-C），' +
          '插件要暴露写能力必须等那 5 条前置条件落地',
      );
    }
    const routePath = String(route.path || '').replace(/^\/+/, '');
    if (!routePath) return fail(where + '：route.path 不能为空');
    if (routePath.includes(':')) {
      return fail(where + '：route.path 暂不支持路径参数（:id），请改成 query 参数（params）——路径参数要额外处理编码与注入');
    }
    if (!pluginRoutes.has('GET ' + routePath)) {
      return fail(
        where + '：控制器里找不到 @Get(' + q(routePath) + ')。MCP 工具必须指向真实存在的接口，' +
          '否则 AI 会被导到一个 404（本插件实际路由：' + ([...pluginRoutes].join(' / ') || '无') + '）',
      );
    }

    const perms = Array.isArray(t.permissions) ? t.permissions.map(String) : [];
    if (perms.length === 0) return fail(where + '：必须声明 permissions（工具级权限是本项目 MCP 的既定口径）');
    for (const code of perms) {
      if (!permSet.has(code)) return fail(where + '：权限码 ' + code + ' 未在 plugin.json 的 permissions 里声明');
    }

    const params = [];
    const seenParam = new Set();
    const rawParams = Array.isArray(t.params) ? t.params : [];
    rawParams.forEach((p, j) => {
      const pw = where + '.params[' + j + ']';
      if (!p || typeof p !== 'object') return fail(pw + '：必须是对象');
      const pname = String(p.name || '');
      if (!MCP_PARAM_NAME_RE.test(pname)) return fail(pw + '：参数名只能是字母开头的字母数字，1~31 字符');
      if (seenParam.has(pname)) return fail(pw + '：参数名 ' + pname + ' 重复');
      seenParam.add(pname);
      const ptype = String(p.type || 'string');
      if (!MCP_PARAM_TYPES.has(ptype)) return fail(pw + '：type 只允许 string / number / boolean');
      const pdesc = String(p.description || '').trim();
      if (!pdesc) return fail(pw + '：缺 description');
      if (FORBIDDEN_IN_STRING.test(pdesc)) return fail(pw + '：description 不能含单引号或换行');
      params.push({ name: pname, type: ptype, required: p.required === true, description: pdesc });
    });

    mcpTools.push({ name, description, plugin: manifest.name, path: routePath, permissions: perms, params });
  });

  catalog.push({
    key: manifest.name,
    displayName: manifest.displayName,
    description: manifest.description,
    version: manifest.version,
    author: manifest.author,
    enabledByDefault: manifest.enabledByDefault === true,
    dependencies,
    permissions: permissions.map((p) => ({ code: p.code, name: p.name, group: p.group })),
    menus: menus.map((m) => {
      const node = { key: m.key, label: m.label, icon: m.icon, path: m.path, permission: m.permission };
      if (m.parent) node.parent = m.parent;
      return node;
    }),
    mcpTools,
    apiPrefix,
    nestModule,
    webEntry,
  });
}

// ---------- 依赖可解析性 ----------
const byKey = new Map(catalog.map((c) => [c.key, c]));
const cmp = (a, b) => {
  const x = a.split('.').map(Number);
  const y = b.split('.').map(Number);
  for (let i = 0; i < 3; i += 1) if (x[i] !== y[i]) return x[i] - y[i];
  return 0;
};
const satisfies = (actual, op, want) => {
  const c = cmp(actual, want);
  if (op === '>=') return c >= 0;
  if (op === '<=') return c <= 0;
  if (op === '>') return c > 0;
  if (op === '<') return c < 0;
  return c === 0;
};
for (const c of catalog) {
  for (const dep of c.dependencies) {
    const m = DEP_RE.exec(dep);
    if (!m) continue;
    const depName = m[1];
    const op = m[2];
    const want = m[3];
    if (depName === 'core') {
      if (!satisfies(CORE_VERSION, op, want)) fail(c.key + '：要求 core' + op + want + '，当前核心版本 ' + CORE_VERSION);
      continue;
    }
    const target = byKey.get(depName);
    if (!target) {
      fail(c.key + '：依赖的插件 ' + depName + ' 不存在');
      continue;
    }
    if (!satisfies(target.version, op, want)) fail(c.key + '：要求 ' + depName + op + want + '，实际 ' + target.version);
  }
}

if (errors.length) {
  console.error('[gen-plugins] 清单校验失败（' + errors.length + ' 项）：');
  for (const e of errors) console.error('  - ' + e);
  process.exit(1);
}

// ---------- 渲染 ----------
const HEADER = [
  '/**',
  ' * ⚠️ 自动生成，请勿手改。来源：server/src/plugins/<key>/plugin.json',
  ' * 生成命令：node scripts/gen-plugins.mjs',
  ' * 新鲜度由 server/test/pluginCatalog.spec.mts 锁定（改了清单忘了重新生成 -> CI 红）。',
  ' */',
];

const COMMON_TYPES = [
  '/** 插件菜单节点（生成物自带最小结构，避免生成文件反向依赖手写类型） */',
  'export interface PluginMenuNode {',
  '  key: string;',
  '  label: string;',
  '  icon: string;',
  '  path: string;',
  '  permission?: string;',
  '  parent?: string;',
  '}',
  '',
  '/** 菜单树最小结构（server 的 MenuNode / web 的 MenuItem 都满足它） */',
  'export interface MenuTreeLike {',
  '  key: string;',
  '  label: string;',
  '  icon?: unknown;',
  '  path?: string;',
  '  permission?: string;',
  '  children?: MenuTreeLike[];',
  '}',
  '',
  'export interface PluginCatalogEntry {',
  '  key: string;',
  '  displayName: string;',
  '  description: string;',
  '  version: string;',
  '  author: string;',
  '  enabledByDefault: boolean;',
  '  dependencies: string[];',
  '  permissions: { code: string; name: string; group: string }[];',
  '  menus: PluginMenuNode[];',
  '  mcpTools: { name: string; description: string }[];',
  '  apiPrefix: string;',
  '  nestModule: string;',
  '  webEntry: string;',
  '}',
  '',
  '/**',
  ' * 把插件菜单挂进核心菜单树。',
  ' *',
  ' * - parent 命中已有分组 -> 追加到该分组 children 末尾（顺序 = 清单声明顺序）；',
  ' * - 无 parent -> 作为顶层分组追加在末尾；',
  ' * - 父节点不存在时抛错而不是静默降级（否则插件菜单凭空消失，排障看不出原因）。',
  ' *',
  ' * 两侧（server / web）的这份实现由生成器保证逐字一致，',
  ' * 所以 routePermissionParity.spec.mts 的 deepEqual 不会因合并逻辑差异而误报。',
  ' */',
  'export function applyPluginMenus<T extends MenuTreeLike>(',
  '  tree: readonly T[],',
  '  nodes: readonly PluginMenuNode[],',
  '): T[] {',
  '  const clone = (list: readonly MenuTreeLike[]): MenuTreeLike[] =>',
  '    list.map((n) => (n.children ? { ...n, children: clone(n.children) } : { ...n }));',
  '  const result = clone(tree);',
  '  for (const spec of nodes) {',
  '    const node: MenuTreeLike = { key: spec.key, label: spec.label, icon: spec.icon, path: spec.path };',
  '    if (spec.permission) node.permission = spec.permission;',
  '    if (spec.parent) {',
  '      const parent = result.find((n) => n.key === spec.parent);',
  '      if (!parent) throw new Error("插件菜单挂载点不存在：" + spec.parent);',
  '      parent.children = [...(parent.children ?? []), node];',
  '    } else {',
  '      result.push(node);',
  '    }',
  '  }',
  '  return result as unknown as T[];',
  '}',
];

const menuNodeLine = (m) => {
  const parts = ['key: ' + q(m.key), 'label: ' + q(m.label), 'icon: ' + q(m.icon), 'path: ' + q(m.path)];
  if (m.permission) parts.push('permission: ' + q(m.permission));
  if (m.parent) parts.push('parent: ' + q(m.parent));
  return '  { ' + parts.join(', ') + ' },';
};

const entryLines = [];
for (const c of catalog) {
  entryLines.push('  {');
  entryLines.push('    key: ' + q(c.key) + ',');
  entryLines.push('    displayName: ' + q(c.displayName) + ',');
  entryLines.push('    description: ' + q(c.description) + ',');
  entryLines.push('    version: ' + q(c.version) + ',');
  entryLines.push('    author: ' + q(c.author) + ',');
  entryLines.push('    enabledByDefault: ' + c.enabledByDefault + ',');
  entryLines.push('    dependencies: [' + c.dependencies.map(q).join(', ') + '],');
  entryLines.push('    permissions: [');
  for (const p of c.permissions) {
    entryLines.push('      { code: ' + q(p.code) + ', name: ' + q(p.name) + ', group: ' + q(p.group) + ' },');
  }
  entryLines.push('    ],');
  entryLines.push('    menus: [');
  for (const m of c.menus) entryLines.push('    ' + menuNodeLine(m));
  entryLines.push('    ],');
  if (c.mcpTools.length === 0) {
    entryLines.push('    mcpTools: [],');
  } else {
    entryLines.push('    mcpTools: [');
    for (const t of c.mcpTools) {
      entryLines.push('      { name: ' + q(t.name) + ', description: ' + q(t.description) + ' },');
    }
    entryLines.push('    ],');
  }
  entryLines.push('    apiPrefix: ' + q(c.apiPrefix) + ',');
  entryLines.push('    nestModule: ' + q(c.nestModule) + ',');
  entryLines.push('    webEntry: ' + q(c.webEntry) + ',');
  entryLines.push('  },');
}

const menuLines = [];
const permLines = [];
const routePermLines = [];
for (const c of catalog) {
  for (const m of c.menus) menuLines.push(menuNodeLine(m));
  for (const p of c.permissions) {
    permLines.push('  { code: ' + q(p.code) + ', name: ' + q(p.name) + ', module: ' + q(p.group) + ' },');
  }
  for (const m of c.menus) routePermLines.push('  ' + q(m.path) + ': [' + q(m.permission) + '],');
}

const serverCatalog = [
  ...HEADER,
  '',
  'export const CORE_VERSION = ' + q(CORE_VERSION) + ';',
  '',
  ...COMMON_TYPES,
  '',
  'export const PLUGIN_CATALOG: PluginCatalogEntry[] = [',
  ...entryLines,
  '];',
  '',
  '/** 全量插件菜单节点（未按启用状态过滤；运行期过滤见 plugins/plugin-catalog.ts） */',
  'export const PLUGIN_MENU_NODES: PluginMenuNode[] = [',
  ...menuLines,
  '];',
  '',
  '/** 全量插件权限码（与核心权限目录合并，由 permissionCatalog.spec.mts 锁定） */',
  'export const PLUGIN_PERMISSIONS: { code: string; name: string; module: string }[] = [',
  ...permLines,
  '];',
  '',
];

const webCatalog = [
  ...HEADER,
  '',
  ...COMMON_TYPES,
  '',
  'export const PLUGIN_CATALOG: PluginCatalogEntry[] = [',
  ...entryLines,
  '];',
  '',
  'export const PLUGIN_MENU_NODES: PluginMenuNode[] = [',
  ...menuLines,
  '];',
  '',
  '/** 插件菜单路径 -> 允许进入的权限码（与 web/src/constants/routePermissions.ts 合并） */',
  'export const PLUGIN_ROUTE_PERMISSIONS: Record<string, string[]> = {',
  ...routePermLines,
  '};',
  '',
];

const modulesLines = [
  ...HEADER,
  '',
  "import type { Type } from '@nestjs/common';",
  ...catalog.map((c) => 'import { ' + c.nestModule + " } from '../" + c.key + "/index.ts';"),
  '',
  '/**',
  ' * 插件 Nest 模块表。',
  ' *',
  ' * 全仓唯一 import 插件模块的文件——装配方 plugins/plugin-modules.ts 按启用状态过滤后',
  ' * 再交给 AppModule，其余代码一律看不见插件模块类。',
  ' */',
  'export const PLUGIN_MODULES: { key: string; module: Type<unknown> }[] = [',
  ...catalog.map((c) => '  { key: ' + q(c.key) + ', module: ' + c.nestModule + ' },'),
  '];',
  '',
];

// ---------- mcp/ 侧：插件工具清单 ----------
const mcpLines = [
  '/**',
  ' * ⚠️ 自动生成，**不要手改**：改 plugin.json 的 mcpTools 后跑 node scripts/gen-plugins.mjs。',
  ' *',
  ' * 为什么生成而不是运行时注册（对比 ApeAdmin 的 register_mcp_tools）：本项目的插件是**构建期**的，',
  ' * 运行时不加载任何插件代码；把清单生成为静态常量，MCP 包照旧编译期装配，静态门禁也照旧看得见。',
  ' *',
  ' * 约束（gen-plugins 校验，改坏了门禁会红）：只允许 GET（写操作按 AI 一期口径暂缓）；',
  ' * 每个工具必须声明 permissions；path 必须能在插件控制器里找到对应的 @Get。',
  ' */',
  '',
  "export type PluginToolParamType = 'string' | 'number' | 'boolean';",
  '',
  'export interface PluginToolParam {',
  '  name: string;',
  '  type: PluginToolParamType;',
  '  required: boolean;',
  '  description: string;',
  '}',
  '',
  'export interface PluginTool {',
  '  /** MCP 工具名（已含插件名前缀，全局唯一） */',
  '  name: string;',
  '  description: string;',
  '  /** 所属插件 key */',
  '  plugin: string;',
  '  /** 后端完整路径（已拼上 /api 之后的部分），如 /plugin/dev-example/summary */',
  '  path: string;',
  '  /** 调用所需权限码（OR 语义，与后端 @RequirePermissions 一致） */',
  '  permissions: string[];',
  '  params: PluginToolParam[];',
  '}',
  '',
  'export const PLUGIN_MCP_TOOLS: PluginTool[] = [',
];
for (const c of catalog) {
  for (const t of c.mcpTools) {
    mcpLines.push('  {');
    mcpLines.push('    name: ' + q(t.name) + ',');
    mcpLines.push('    description: ' + q(t.description) + ',');
    mcpLines.push('    plugin: ' + q(t.plugin) + ',');
    mcpLines.push('    path: ' + q('/' + c.apiPrefix + '/' + t.path) + ',');
    mcpLines.push('    permissions: [' + t.permissions.map(q).join(', ') + '],');
    if (t.params.length === 0) {
      mcpLines.push('    params: [],');
    } else {
      mcpLines.push('    params: [');
      for (const pr of t.params) {
        mcpLines.push(
          '      { name: ' +
            q(pr.name) +
            ', type: ' +
            q(pr.type) +
            ', required: ' +
            pr.required +
            ', description: ' +
            q(pr.description) +
            ' },',
        );
      }
      mcpLines.push('    ],');
    }
    mcpLines.push('  },');
  }
}
mcpLines.push('];');
mcpLines.push('');

const outputs = [
  { rel: 'server/src/plugins/generated/plugin-catalog.generated.ts', content: serverCatalog.join('\n') },
  { rel: 'server/src/plugins/generated/plugin-modules.generated.ts', content: modulesLines.join('\n') },
  { rel: 'web/src/plugins/generated/plugin-catalog.generated.ts', content: webCatalog.join('\n') },
  { rel: 'mcp/src/generated/plugin-tools.generated.ts', content: mcpLines.join('\n') },
];

const changed = [];
for (const out of outputs) {
  const abs = path.join(REPO, out.rel);
  const prev = existsSync(abs) ? readText(abs) : null;
  if (prev === out.content) continue;
  changed.push(out.rel);
  if (!CHECK) {
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, out.content, 'utf8');
  }
}

// ---------- router.tsx：只替换标记块内部，标记缺失即报错 ----------
const LAZY_OPEN = '// <plugin-lazy>';
const LAZY_CLOSE = '// </plugin-lazy>';
const ROUTES_OPEN = '// <plugin-routes>';
const ROUTES_CLOSE = '// </plugin-routes>';

function replaceBlock(src, open, close, body) {
  const o = src.indexOf(open);
  const c = src.indexOf(close);
  if (o < 0 || c < 0 || c < o) return null;
  const lineStart = src.lastIndexOf('\n', o) + 1;
  const indent = src.slice(lineStart, o);
  const lines = body
    .split('\n')
    .map((l) => (l ? indent + l : l))
    .join('\n');
  return src.slice(0, o) + open + ' 由 scripts/gen-plugins.mjs 生成，勿手改\n' + lines + indent + src.slice(c);
}

const routerSrc = readText(ROUTER_FILE);
const lazyBody = catalog
  .map((c) => 'const ' + pascal(c.key) + "PluginPage = lazy(() => import('@/plugins/" + c.key + "'));")
  .join('\n');
const routeBody = catalog
  .flatMap((c) =>
    c.menus.map((m) => {
      const rel = m.path.replace(/^\//, '');
      return "{ path: " + q(rel) + ', element: perm(' + q(m.path) + ', <' + pascal(c.key) + 'PluginPage />) },';
    }),
  )
  .join('\n');

const afterLazy = replaceBlock(routerSrc, LAZY_OPEN, LAZY_CLOSE, lazyBody ? lazyBody + '\n' : '');
if (afterLazy === null) {
  console.error('[gen-plugins] web/src/router.tsx 缺少 ' + LAZY_OPEN + ' 标记块');
  process.exit(2);
}
const afterRoutes = replaceBlock(afterLazy, ROUTES_OPEN, ROUTES_CLOSE, routeBody ? routeBody + '\n' : '');
if (afterRoutes === null) {
  console.error('[gen-plugins] web/src/router.tsx 缺少 ' + ROUTES_OPEN + ' 标记块');
  process.exit(2);
}
if (afterRoutes !== routerSrc) {
  changed.push('web/src/router.tsx');
  if (!CHECK) writeFileSync(ROUTER_FILE, afterRoutes, 'utf8');
}

if (CHECK) {
  if (changed.length) {
    console.error('[gen-plugins] 生成物已过期，请运行 node scripts/gen-plugins.mjs：');
    for (const f of changed) console.error('  - ' + f);
    process.exit(1);
  }
  console.log('[gen-plugins] 生成物新鲜（' + catalog.length + ' 个插件：' + catalog.map((c) => c.key).join(', ') + '）');
} else {
  console.log('[gen-plugins] 已装配 ' + catalog.length + ' 个插件：' + catalog.map((c) => c.key + '@' + c.version).join(', '));
  console.log(changed.length ? '  写入：\n    ' + changed.join('\n    ') : '  无变化');
}
