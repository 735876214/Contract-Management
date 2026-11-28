/**
 * ⚠️ 自动生成，请勿手改。来源：server/src/plugins/<key>/plugin.json
 * 生成命令：node scripts/gen-plugins.mjs
 * 新鲜度由 server/test/pluginCatalog.spec.mts 锁定（改了清单忘了重新生成 -> CI 红）。
 */

/** 插件菜单节点（生成物自带最小结构，避免生成文件反向依赖手写类型） */
export interface PluginMenuNode {
  key: string;
  label: string;
  icon: string;
  path: string;
  permission?: string;
  parent?: string;
}

/** 菜单树最小结构（server 的 MenuNode / web 的 MenuItem 都满足它） */
export interface MenuTreeLike {
  key: string;
  label: string;
  icon?: unknown;
  path?: string;
  permission?: string;
  children?: MenuTreeLike[];
}

export interface PluginCatalogEntry {
  key: string;
  displayName: string;
  description: string;
  version: string;
  author: string;
  enabledByDefault: boolean;
  dependencies: string[];
  permissions: { code: string; name: string; group: string }[];
  menus: PluginMenuNode[];
  mcpTools: { name: string; description: string }[];
  apiPrefix: string;
  nestModule: string;
  webEntry: string;
}

/**
 * 把插件菜单挂进核心菜单树。
 *
 * - parent 命中已有分组 -> 追加到该分组 children 末尾（顺序 = 清单声明顺序）；
 * - 无 parent -> 作为顶层分组追加在末尾；
 * - 父节点不存在时抛错而不是静默降级（否则插件菜单凭空消失，排障看不出原因）。
 *
 * 两侧（server / web）的这份实现由生成器保证逐字一致，
 * 所以 routePermissionParity.spec.mts 的 deepEqual 不会因合并逻辑差异而误报。
 */
export function applyPluginMenus<T extends MenuTreeLike>(
  tree: readonly T[],
  nodes: readonly PluginMenuNode[],
): T[] {
  const clone = (list: readonly MenuTreeLike[]): MenuTreeLike[] =>
    list.map((n) => (n.children ? { ...n, children: clone(n.children) } : { ...n }));
  const result = clone(tree);
  for (const spec of nodes) {
    const node: MenuTreeLike = { key: spec.key, label: spec.label, icon: spec.icon, path: spec.path };
    if (spec.permission) node.permission = spec.permission;
    if (spec.parent) {
      const parent = result.find((n) => n.key === spec.parent);
      if (!parent) throw new Error("插件菜单挂载点不存在：" + spec.parent);
      parent.children = [...(parent.children ?? []), node];
    } else {
      result.push(node);
    }
  }
  return result as unknown as T[];
}

export const PLUGIN_CATALOG: PluginCatalogEntry[] = [
  {
    key: 'dev-example',
    displayName: '插件开发示例',
    description: '构建期插件（B 档）的最小子集示范：一个后端模块 + 一个前端页面 + 一条菜单 + 一个权限码，全部由 plugin.json 声明后生成装配',
    version: '0.1.0',
    author: 'CMS',
    enabledByDefault: true,
    dependencies: ['core>=1.1.0'],
    permissions: [
      { code: 'dev-example:view', name: '查看插件开发示例', group: '插件' },
    ],
    menus: [
      { key: 'system-dev-example', label: '插件开发示例', icon: 'SolutionOutlined', path: '/plugin/dev-example', permission: 'dev-example:view', parent: 'system' },
    ],
    mcpTools: [
      { name: 'dev_example_summary', description: '读取「插件开发示例」的装配事实：插件是否被挂载、对外接口/权限码/菜单/前端页面从哪里来（只读）。可用 cms_whoami 先确认当前账号权限。' },
      { name: 'dev_example_permissions', description: '列出「插件开发示例」声明的权限码与所属分组，用于确认插件授权是否已同步（只读）。' },
    ],
    apiPrefix: 'plugin/dev-example',
    nestModule: 'DevExampleModule',
    webEntry: 'web/src/plugins/dev-example/index.tsx',
  },
];

export const PLUGIN_MENU_NODES: PluginMenuNode[] = [
  { key: 'system-dev-example', label: '插件开发示例', icon: 'SolutionOutlined', path: '/plugin/dev-example', permission: 'dev-example:view', parent: 'system' },
];

/** 插件菜单路径 -> 允许进入的权限码（与 web/src/constants/routePermissions.ts 合并） */
export const PLUGIN_ROUTE_PERMISSIONS: Record<string, string[]> = {
  '/plugin/dev-example': ['dev-example:view'],
};
