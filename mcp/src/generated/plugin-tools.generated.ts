/**
 * ⚠️ 自动生成，**不要手改**：改 plugin.json 的 mcpTools 后跑 node scripts/gen-plugins.mjs。
 *
 * 为什么生成而不是运行时注册（对比 ApeAdmin 的 register_mcp_tools）：本项目的插件是**构建期**的，
 * 运行时不加载任何插件代码；把清单生成为静态常量，MCP 包照旧编译期装配，静态门禁也照旧看得见。
 *
 * 约束（gen-plugins 校验，改坏了门禁会红）：只允许 GET（写操作按 AI 一期口径暂缓）；
 * 每个工具必须声明 permissions；path 必须能在插件控制器里找到对应的 @Get。
 */

export type PluginToolParamType = 'string' | 'number' | 'boolean';

export interface PluginToolParam {
  name: string;
  type: PluginToolParamType;
  required: boolean;
  description: string;
}

export interface PluginTool {
  /** MCP 工具名（已含插件名前缀，全局唯一） */
  name: string;
  description: string;
  /** 所属插件 key */
  plugin: string;
  /** 后端完整路径（已拼上 /api 之后的部分），如 /plugin/dev-example/summary */
  path: string;
  /** 调用所需权限码（OR 语义，与后端 @RequirePermissions 一致） */
  permissions: string[];
  params: PluginToolParam[];
}

export const PLUGIN_MCP_TOOLS: PluginTool[] = [
  {
    name: 'dev_example_summary',
    description: '读取「插件开发示例」的装配事实：插件是否被挂载、对外接口/权限码/菜单/前端页面从哪里来（只读）。可用 cms_whoami 先确认当前账号权限。',
    plugin: 'dev-example',
    path: '/plugin/dev-example/summary',
    permissions: ['dev-example:view'],
    params: [],
  },
  {
    name: 'dev_example_permissions',
    description: '列出「插件开发示例」声明的权限码与所属分组，用于确认插件授权是否已同步（只读）。',
    plugin: 'dev-example',
    path: '/plugin/dev-example/permissions',
    permissions: ['dev-example:view'],
    params: [
      { name: 'group', type: 'string', required: false, description: '按分组名精确过滤（如 插件）；省略则返回全部' },
    ],
  },
];
