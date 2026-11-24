import { Injectable } from '@nestjs/common';
import { CORE_VERSION, pluginRuntimeRows } from '../../plugins';

/**
 * 插件管理（只读）。
 *
 * 为什么**没有** enable/disable 接口：构建期插件（B 档）的启停是 `plugin.json` 的
 * `enabledByDefault` 与环境变量 `CMS_PLUGINS_DISABLED`，改完必须重启后端——没有
 * 「运行期回滚」语义就不该给 UI 一个看起来能热切的按钮。想裁剪模块的客户：
 * 在部署环境里设 `CMS_PLUGINS_DISABLED=a,b` 后重启（见 server/src/plugins/README.md）。
 *
 * 若将来要做热切换，前提是实现「卸载插件模块的运行时资源」与失败回滚
 * （ApeAdmin 的做法是追踪 route/tool/event 三件套差集），不是加一个 PUT 就完事。
 */
@Injectable()
export class PluginService {
  /** 已声明插件 + 当前启用状态（依赖不满足的会带 blockedBy 原因，不静默禁用） */
  list() {
    const rows = pluginRuntimeRows();
    const declared = new Set(rows.map((r) => r.key));
    const envRaw = (process.env.CMS_PLUGINS_DISABLED || '').trim();
    const envKeys = envRaw ? envRaw.split(',').map((s) => s.trim()).filter(Boolean) : [];
    return {
      coreVersion: CORE_VERSION,
      /** 环境变量里写了但没有任何插件使用 → 拼错的可能性极高，直接摆到页面上 */
      unknownEnvKeys: envKeys.filter((k) => !declared.has(k)),
      envDisabled: envKeys,
      plugins: rows.map((r) => ({
        key: r.key,
        displayName: r.displayName,
        description: r.description,
        version: r.version,
        author: r.author,
        enabled: r.enabled,
        enabledByDefault: r.enabledByDefault,
        disabledBy: r.disabledBy,
        blockedBy: r.blockedBy,
        dependencies: r.dependencies,
        permissions: r.permissions,
        menus: r.menus,
        mcpTools: r.mcpTools,
        apiPrefix: r.apiPrefix,
        nestModule: r.nestModule,
        webEntry: r.webEntry,
      })),
    };
  }
}
