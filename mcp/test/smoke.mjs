/**
 * 冒烟测试：用官方 SDK 客户端以 stdio 启动服务端，完成 MCP 握手并列出工具。
 * 不依赖后端在线（只验证协议与工具注册），断言工具数量与关键工具存在。
 */
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

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
for (const n of expected) assert.ok(names.includes(n), `缺少工具 ${n}`);
assert.equal(names.length, expected.length, `工具数量应为 ${expected.length}，实际 ${names.length}`);

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

await client.close();
console.log('SMOKE OK');
