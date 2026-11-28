/**
 * 冒烟测试：用官方 SDK 客户端以 stdio 启动服务端，完成 MCP 握手并列出工具。
 * 不依赖后端在线（只验证协议与工具注册），断言工具数量与关键工具存在
 * （核心工具 + 插件工具 = 注册面全集）。
 */
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
// 插件工具清单由 plugin.json 的 mcpTools 构建期生成，这里跟着生成物走，不手抄清单：
// 每加一个插件工具就改一次断言，等于把「两份清单各说一套」的问题搬进测试里。
// 代价：期望值取自生成物本身，所以「插件把 mcpTools 删了」这类由 gen-plugins --check 与
// server/test/pluginMcp.spec.mts 兜（本测试管的是「注册面上真的有」）；单独跑本文件前要先 npm run build
// （npm test 的 pretest 已做，否则这里会是 Cannot find module）。
import { PLUGIN_MCP_TOOLS } from '../dist/generated/plugin-tools.generated.js';

const transport = new StdioClientTransport({
  command: process.execPath,
  args: ['dist/index.js'],
  env: {
    ...process.env,
    CMS_BASE_URL: 'http://localhost:3000/api',
    // 冒烟只验协议与注册面，不验权限；关掉工具级过滤，保持「不依赖后端在线」这个前提
    CMS_MCP_PERMISSION_FILTER: 'off',
  },
  stderr: 'ignore',
});
const client = new Client({ name: 'smoke', version: '1.0.0' });

await client.connect(transport);
const { tools } = await client.listTools();
const names = tools.map((t) => t.name).sort();
console.log('tools:', names.join(', '));

const expected = [
  'cms_list_resources',
  'cms_whoami',
  'cms_query',
  'cms_get',
  'cms_export',
  'cms_download_template',
  'cms_export_contract_word',
  'cms_import',
];
for (const n of expected) assert.ok(names.includes(n), `缺少核心工具 ${n}`);

// 插件工具（dev-example 等）与核心工具一视同仁：必须在注册面上，且数量不能多也不能少
const expectedPlugin = PLUGIN_MCP_TOOLS.map((t) => t.name);
for (const n of expectedPlugin) assert.ok(names.includes(n), `缺少插件工具 ${n}`);
const totalExpected = expected.length + expectedPlugin.length;
assert.equal(
  names.length,
  totalExpected,
  `工具数量应为 ${totalExpected}（核心 ${expected.length} + 插件 ${expectedPlugin.length}），实际 ${names.length}`,
);

// cms_list_resources 不依赖后端，返回资源目录
const res = await client.callTool({ name: 'cms_list_resources', arguments: {} });
const text = res.content?.[0]?.text ?? '';
const parsed = JSON.parse(text);
assert.ok(Array.isArray(parsed.resources) && parsed.resources.length >= 10, '资源目录应包含至少 10 个资源');
// 被权限挡掉的资源必须显式交代（关掉过滤时应为空数组，但不能没有这个字段）
assert.ok(Array.isArray(parsed.hiddenByPermission), 'cms_list_resources 必须回 hiddenByPermission');

// 口径提示词：注册面（正文要后端在线，故此处只验 list）
const { prompts } = await client.listPrompts();
const promptNames = prompts.map((p) => p.name).sort();
console.log('prompts:', promptNames.join(', '));
assert.deepEqual(
  promptNames,
  ['cms_payment_anomaly', 'cms_report', 'cms_supply_chain'],
  `提示词清单不对：${promptNames.join(', ')}`,
);
const report = prompts.find((p) => p.name === 'cms_report');
assert.deepEqual(
  (report.arguments || []).map((a) => a.name).sort(),
  ['extra', 'kind'],
  'cms_report 的参数应为 kind / extra',
);

// 口径上下文：resources 的注册面（正文要后端在线，故此处只验 list）
const { resources } = await client.listResources();
const uris = resources.map((r) => r.uri).sort();
console.log('resources:', uris.join(', '));
assert.deepEqual(
  uris,
  ['cms://context/metrics', 'cms://context/procurement-flow', 'cms://context/statuses'],
  `口径资源清单不对：${uris.join(', ')}`,
);
const { resourceTemplates } = await client.listResourceTemplates();
const tpls = resourceTemplates.map((r) => r.uriTemplate);
console.log('resourceTemplates:', tpls.join(', '));
assert.ok(tpls.includes('cms://dict/{typeCode}'), '缺少字典资源模板 cms://dict/{typeCode}');

await client.close();
console.log('SMOKE OK');
