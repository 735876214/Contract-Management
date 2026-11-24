/**
 * 插件体系对外门面。
 *
 * 目录约定与装配规则见 `./README.md`；清单格式见 `./<key>/plugin.json`。
 * 生成物在 `./generated/`（由 `node scripts/gen-plugins.mjs` 产出，勿手改）。
 */
export {
  CORE_VERSION,
  enabledPluginKeys,
  hiddenPluginMenuKeys,
  isPluginEnabled,
  parseDependency,
  pluginRuntimeRow,
  pluginRuntimeRows,
  satisfiesRange,
} from './plugin-catalog.ts';
export type { PluginCatalogEntry, PluginDisabledBy, PluginRuntimeRow } from './plugin-catalog.ts';
export { declaredPluginKeys, enabledNestModules } from './plugin-modules.ts';
