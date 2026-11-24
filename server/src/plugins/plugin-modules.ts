/**
 * 插件 Nest 模块的启用过滤。
 *
 * 全仓**只有这里**把插件模块交给 `AppModule`——其余代码看不见插件模块类，
 * 这样「插件是否挂载」永远只有一个判断入口（`isPluginEnabled`）。
 */
import type { Type } from '@nestjs/common';
import { PLUGIN_MODULES } from './generated/plugin-modules.generated.ts';
import { isPluginEnabled } from './plugin-catalog.ts';

/** 当前启用状态下的插件模块（未启用的不挂载，其路由自然 404） */
export function enabledNestModules(): Type<unknown>[] {
  return PLUGIN_MODULES.filter((p) => isPluginEnabled(p.key)).map((p) => p.module);
}

/** 全部已声明的插件模块（管理页展示用，与启用状态无关） */
export function declaredPluginKeys(): string[] {
  return PLUGIN_MODULES.map((p) => p.key);
}
