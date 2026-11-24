/**
 * ⚠️ 自动生成，请勿手改。来源：server/src/plugins/<key>/plugin.json
 * 生成命令：node scripts/gen-plugins.mjs
 * 新鲜度由 server/test/pluginCatalog.spec.mts 锁定（改了清单忘了重新生成 -> CI 红）。
 */

import type { Type } from '@nestjs/common';
import { DevExampleModule } from '../dev-example/index.ts';

/**
 * 插件 Nest 模块表。
 *
 * 全仓唯一 import 插件模块的文件——装配方 plugins/plugin-modules.ts 按启用状态过滤后
 * 再交给 AppModule，其余代码一律看不见插件模块类。
 */
export const PLUGIN_MODULES: { key: string; module: Type<unknown> }[] = [
  { key: 'dev-example', module: DevExampleModule },
];
