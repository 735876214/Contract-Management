import { Injectable } from '@nestjs/common';
import { PLUGIN_PERMISSIONS, pluginRuntimeRow } from '../plugin-catalog';

/**
 * 插件的业务实现。
 *
 * 这里的全部数据都来自**同一份清单投影**（`plugin-catalog`），不在插件里再写一遍
 * 版本号/菜单路径/权限码——否则清单与实现立刻会各说一套。
 */
@Injectable()
export class DevExampleService {
  summary() {
    const row = pluginRuntimeRow('dev-example');
    return {
      ok: row !== null,
      runtime: row,
      /** 服务端实际启动时间：证明这条响应确实来自已挂载的插件模块，而不是静态文件 */
      servedAt: new Date().toISOString(),
      nodeVersion: process.version,
    };
  }

  /** 本插件声明的权限码（可按 group 过滤）；给 MCP 工具参数示例用 */
  permissions(group?: string) {
    const wanted = String(group ?? '').trim();
    const rows = PLUGIN_PERMISSIONS.filter((p) => !wanted || p.module === wanted);
    return { total: rows.length, rows };
  }
}
