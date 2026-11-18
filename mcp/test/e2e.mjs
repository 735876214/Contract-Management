/**
 * 真实端到端验证（需要后端在线）：通过 MCP stdio 客户端驱动全部三类能力。
 * 用法：CMS_USERNAME=admin CMS_PASSWORD=admin123 node test/e2e.mjs
 * 不纳入 npm test（依赖后端与种子数据）。
 */
import assert from 'node:assert/strict';
import { existsSync, rmSync } from 'node:fs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const EXPORT_DIR = 'exports-e2e';
rmSync(EXPORT_DIR, { recursive: true, force: true });

const transport = new StdioClientTransport({
  command: process.execPath,
  args: ['dist/index.js'],
  env: {
    ...process.env,
    CMS_BASE_URL: process.env.CMS_BASE_URL ?? 'http://localhost:3000/api',
    CMS_USERNAME: process.env.CMS_USERNAME ?? 'admin',
    CMS_PASSWORD: process.env.CMS_PASSWORD ?? 'admin123',
    CMS_EXPORT_DIR: EXPORT_DIR,
  },
  stderr: 'ignore',
});
const client = new Client({ name: 'e2e', version: '1.0.0' });
await client.connect(transport);

const call = async (name, args) => {
  const res = await client.callTool({ name, arguments: args });
  const text = res.content?.[0]?.text ?? '';
  if (res.isError) throw new Error(`${name} 失败: ${text}`);
  return { text, json: (() => { try { return JSON.parse(text); } catch { return null; } })() };
};

// 1) 身份
const who = await call('cms_whoami', {});
assert.ok(who.json, 'whoami 应返回 JSON');
console.log('whoami OK:', (who.json.user?.username ?? who.json.username ?? 'admin'));

// 2) 项目列表
const projects = await call('cms_query', { resource: 'projects', pageSize: 5 });
const projList = projects.json?.list ?? projects.json?.items ?? projects.json;
const first = Array.isArray(projList) ? projList[0] : projList?.rows?.[0];
assert.ok(first && (first.id || first.projectId), '应有至少一个项目');
const projectId = first.id ?? first.projectId;
console.log('projects OK, projectId=', projectId);

// 3) 合同列表（带项目上下文）
const contracts = await call('cms_query', { resource: 'contracts', projectId, pageSize: 3 });
assert.ok(contracts.json !== null, '合同查询应返回数据');
console.log('contracts OK, raw keys=', Object.keys(contracts.json ?? {}).join(','));

// 4) 导出供应商 Excel 到本地
const exp = await call('cms_export', { resource: 'suppliers', projectId });
assert.ok(exp.json?.filePath && existsSync(exp.json.filePath), '导出文件应存在');
assert.ok(exp.json.bytes > 0, '导出文件应非空');
console.log('export OK:', exp.json.filePath, exp.json.bytes, 'bytes');

// 5) 下载合同导入模板
const tpl = await call('cms_download_template', { resource: 'contracts', projectId });
assert.ok(tpl.json?.filePath && existsSync(tpl.json.filePath), '模板文件应存在');
console.log('template OK:', tpl.json.filePath, tpl.json.bytes, 'bytes');

// 6) 导入预校验（用刚下载的合同模板，validateOnly 不写库）
const imp = await call('cms_import', {
  resource: 'contracts',
  projectId,
  filePath: tpl.json.filePath,
  validateOnly: true,
});
assert.ok(imp.json !== null || imp.text.length > 0, '导入预校验应有返回');
console.log('import(validateOnly) OK');

await client.close();
console.log('E2E OK');
