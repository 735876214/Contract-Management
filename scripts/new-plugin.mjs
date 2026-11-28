#!/usr/bin/env node
/**
 * 插件脚手架：node scripts/new-plugin.mjs <key> "显示名" ["描述"]
 *
 * 为什么要有它：`dev-example` 之前只能**手抄**——照抄一遍要改目录名、文件名的 3 类大小写形态、
 * 权限前缀、菜单 key、路由路径、MCP 工具名前缀，漏一处 `gen-plugins` 就红，红的原因还看不懂。
 * 抄一份踩一遍坑，比写业务代码还慢。（对应 ApeAdmin 的 `python -m src.plugins.scaffold`。）
 *
 * 它只做「改名 + 跑一次生成器」，不发明第二套模板：模板就是 `server/src/plugins/dev-example`，
 * 所以示例插件怎么演进的，脚手架就跟着怎么变，不会出现两套互相漂移的骨架。
 */
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PLUGINS_DIR = path.join(REPO, 'server/src/plugins');
const CORE_MODULES_DIR = path.join(REPO, 'server/src/modules');
const WEB_DIR = path.join(REPO, 'web/src/plugins');
const TEMPLATE_KEY = 'dev-example';

const KEY_RE = /^[a-z][a-z0-9-]{1,30}$/;

function die(msg) {
  console.error('[new-plugin] ' + msg);
  process.exit(1);
}

const [key, displayName, description] = process.argv.slice(2);
if (!key) die('用法：node scripts/new-plugin.mjs <key> "显示名" ["描述"]\n  例：node scripts/new-plugin.mjs cost-report "成本报表"');
if (!KEY_RE.test(key)) die('插件 key 只能是小写字母开头的小写字母/数字/连字符，2~31 字符：' + key);
if (key === 'generated') die('generated 是生成物目录名，不能当插件 key');
if (existsSync(path.join(CORE_MODULES_DIR, key))) die('已有同名核心模块 server/src/modules/' + key + '，换个名字（避免 API/权限前缀混淆）');
const targetDir = path.join(PLUGINS_DIR, key);
if (existsSync(targetDir)) die('目录已存在：' + targetDir + '（脚手架不覆盖，先删或换名字）');

const name = displayName && displayName.trim() ? displayName.trim() : key;
const desc = description && description.trim() ? description.trim() : name + '（构建期插件）';
const pascal = key.split(/[-_]/).map((p) => p.charAt(0).toUpperCase() + p.slice(1)).join('');
const snake = key.replace(/-/g, '_');

/** 三类大小写形态一起换：目录名/路由/权限码、PascalCase 类名、snake_case 的 MCP 工具前缀 */
function rewrite(text) {
  return text
    .split(TEMPLATE_KEY).join(key)
    .split('DevExample').join(pascal)
    .split('dev_example').join(snake)
    .split('插件开发示例').join(name);
}

// 1) 复制后端插件目录并改名
cpSync(path.join(PLUGINS_DIR, TEMPLATE_KEY), targetDir, { recursive: true });
for (const entry of readdirSync(targetDir)) {
  if (entry.includes(TEMPLATE_KEY)) renameSync(path.join(targetDir, entry), path.join(targetDir, entry.split(TEMPLATE_KEY).join(key)));
}
for (const entry of readdirSync(targetDir)) {
  const file = path.join(targetDir, entry);
  if (!entry.endsWith('.ts') && !entry.endsWith('.json')) continue;
  writeFileSync(file, rewrite(readFileSync(file, 'utf8')), 'utf8');
}

// 2) manifest 里的显示名/描述/版本/工具清单要按新插件重写（不是简单改名）
const manifestPath = path.join(targetDir, 'plugin.json');
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
manifest.displayName = name;
manifest.description = desc;
manifest.version = '0.1.0';
if (Array.isArray(manifest.menus)) for (const m of manifest.menus) m.label = name;
// 权限码的人话标签也要跟着换，否则角色配置页里显示别人的名字
if (Array.isArray(manifest.permissions)) {
  for (const perm of manifest.permissions) perm.name = perm.name.split('插件开发示例').join(name);
}
writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n', 'utf8');

// 3) 前端页面同样抄一份（约定：web/src/plugins/<key>/index.tsx + default export）
const webTarget = path.join(WEB_DIR, key);
mkdirSync(webTarget, { recursive: true });
writeFileSync(path.join(webTarget, 'index.tsx'), rewrite(readFileSync(path.join(WEB_DIR, TEMPLATE_KEY, 'index.tsx'), 'utf8')), 'utf8');

// 4) 立刻生成装配（菜单/路由/权限/模块/MCP 清单），省掉「忘了跑生成器」的第一坑
try {
  execFileSync(process.execPath, [path.join(REPO, 'scripts/gen-plugins.mjs')], { stdio: 'inherit' });
} catch {
  die('插件已创建，但生成器报错了——按上面的提示修正 plugin.json 后重跑：node scripts/gen-plugins.mjs');
}

console.log('');
console.log('[new-plugin] 已创建 ' + key + '（' + name + '）');
console.log('  后端  server/src/plugins/' + key + '/');
console.log('  前端  web/src/plugins/' + key + '/index.tsx');
console.log('  清单  server/src/plugins/' + key + '/plugin.json');
console.log('');
console.log('接下来：');
console.log('  1. 先把示例接口/页面改成你的业务（controller/service 里现在还是示例逻辑）；');
console.log('  2. 权限码 <key>:view 已登记，要更多动作就去 plugin.json 加 permissions 并在控制器用 @RequirePermissions；');
console.log('  3. 要让 AI 能调：在 plugin.json 的 mcpTools 里声明（只允许 GET，见 README §3.1）；');
console.log('  4. 改完跑 node scripts/gen-plugins.mjs（或 --check 校验新鲜度）。');
