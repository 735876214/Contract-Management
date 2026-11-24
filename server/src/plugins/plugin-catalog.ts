/**
 * 插件运行期投影（纯函数，零 Nest 依赖）。
 *
 * 为什么单独一层：**启用状态只有一份算法**。菜单可见性、Nest 模块挂载、管理页展示
 * 全都问这里，避免「模块挂上了但菜单没隐藏」这类半启用状态。
 *
 * 启用状态的两个来源（本项目不做运行期热切换，故没有数据库开关）：
 *   1. `plugin.json` 的 `enabledByDefault`（构建期默认值）；
 *   2. 环境变量 `CMS_PLUGINS_DISABLED`（逗号分隔，运维按客户裁剪模块）。
 * 依赖不满足时**fail-closed**：插件视为禁用并在管理页显示原因，不抛异常打断启动。
 */
import {
  CORE_VERSION,
  PLUGIN_CATALOG,
  PLUGIN_PERMISSIONS,
  type PluginCatalogEntry,
} from './generated/plugin-catalog.generated.ts';

export { CORE_VERSION, PLUGIN_PERMISSIONS };
export type { PluginCatalogEntry };

/** 启用状态来源：清单默认值 / 环境变量 / 依赖不满足 / 正常启用 */
export type PluginDisabledBy = 'manifest' | 'env' | 'dependency' | null;

export interface PluginRuntimeRow extends PluginCatalogEntry {
  enabled: boolean;
  disabledBy: PluginDisabledBy;
  /** 依赖不满足时的可读原因（管理页直接展示，不吞错） */
  blockedBy: string | null;
}

const DEP_RE = /^([a-z][a-z0-9-]*)(>=|==|<=|>|<)(\d+\.\d+\.\d+)$/;

export function parseDependency(raw: string): { name: string; range: string } | null {
  const m = DEP_RE.exec(raw);
  if (!m) return null;
  return { name: m[1], range: m[2] + m[3] };
}

function compareVersion(a: string, b: string): number {
  const x = a.split('.').map(Number);
  const y = b.split('.').map(Number);
  for (let i = 0; i < 3; i += 1) {
    if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) - (y[i] || 0);
  }
  return 0;
}

export function satisfiesRange(actual: string, range: string): boolean {
  const m = /^(>=|==|<=|>|<)(\d+\.\d+\.\d+)$/.exec(range);
  if (!m) return false;
  const c = compareVersion(actual, m[2]);
  switch (m[1]) {
    case '>=':
      return c >= 0;
    case '<=':
      return c <= 0;
    case '>':
      return c > 0;
    case '<':
      return c < 0;
    default:
      return c === 0;
  }
}

function disabledFromEnv(): Set<string> {
  const raw = (process.env.CMS_PLUGINS_DISABLED || '').trim();
  if (!raw) return new Set();
  return new Set(raw.split(',').map((s) => s.trim()).filter(Boolean));
}

function computeRows(): PluginRuntimeRow[] {
  const envDisabled = disabledFromEnv();
  const byKey = new Map(PLUGIN_CATALOG.map((c) => [c.key, c]));

  const rows: PluginRuntimeRow[] = PLUGIN_CATALOG.map((c) => {
    if (!c.enabledByDefault) return { ...c, enabled: false, disabledBy: 'manifest', blockedBy: null };
    if (envDisabled.has(c.key)) return { ...c, enabled: false, disabledBy: 'env', blockedBy: null };
    return { ...c, enabled: true, disabledBy: null, blockedBy: null };
  });

  // 依赖校验：只对「本已启用」的插件做，且依赖的插件必须也已启用。
  // 两轮即可：插件之间的依赖在 gen-plugins.mjs 里已校验过可解析性，运行期只判启用状态。
  for (const row of rows) {
    if (!row.enabled) continue;
    for (const dep of row.dependencies) {
      const parsed = parseDependency(dep);
      if (!parsed) {
        row.enabled = false;
        row.disabledBy = 'dependency';
        row.blockedBy = '依赖声明无法解析：' + dep;
        break;
      }
      if (parsed.name === 'core') {
        if (!satisfiesRange(CORE_VERSION, parsed.range)) {
          row.enabled = false;
          row.disabledBy = 'dependency';
          row.blockedBy = '要求 core' + parsed.range + '，当前核心版本 ' + CORE_VERSION;
          break;
        }
        continue;
      }
      const target = byKey.get(parsed.name);
      const targetRow = rows.find((r) => r.key === parsed.name);
      if (!target || !targetRow || !targetRow.enabled) {
        row.enabled = false;
        row.disabledBy = 'dependency';
        row.blockedBy = '依赖的插件未启用：' + parsed.name;
        break;
      }
      if (!satisfiesRange(target.version, parsed.range)) {
        row.enabled = false;
        row.disabledBy = 'dependency';
        row.blockedBy = '要求 ' + parsed.name + parsed.range + '，实际 ' + target.version;
        break;
      }
    }
  }
  return rows;
}

let cached: { env: string; rows: PluginRuntimeRow[] } | null = null;

/** 全量插件运行期投影（按 CMS_PLUGINS_DISABLED 记忆化） */
export function pluginRuntimeRows(): PluginRuntimeRow[] {
  const env = process.env.CMS_PLUGINS_DISABLED || '';
  if (cached && cached.env === env) return cached.rows;
  const rows = computeRows();
  cached = { env, rows };
  return rows;
}

export function pluginRuntimeRow(key: string): PluginRuntimeRow | null {
  return pluginRuntimeRows().find((r) => r.key === key) || null;
}

export function isPluginEnabled(key: string): boolean {
  return pluginRuntimeRow(key)?.enabled === true;
}

export function enabledPluginKeys(): string[] {
  return pluginRuntimeRows().filter((r) => r.enabled).map((r) => r.key);
}

/**
 * 未启用插件的菜单 key 集合。
 *
 * `MENU_TREE` 是**全量静态**菜单（这样漂移锁与路由表恒稳定），运行期由 `MenuService`
 * 用这个集合把未启用插件的节点剔掉——与 ApeAdmin 的 `menu.status` 联动同一语义，
 * 但不需要在数据库里存一份可漂移的菜单副本。
 */
export function hiddenPluginMenuKeys(): Set<string> {
  const hidden = new Set<string>();
  for (const row of pluginRuntimeRows()) {
    if (row.enabled) continue;
    for (const m of row.menus) hidden.add(m.key);
  }
  return hidden;
}
