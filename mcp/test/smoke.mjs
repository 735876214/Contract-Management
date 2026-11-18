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
  env: { ...process.env, CMS_BASE_URL: 'http://localhost:3000/api' },
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

await client.close();
console.log('SMOKE OK');
