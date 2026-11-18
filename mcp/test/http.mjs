/**
 * HTTP 传输冒烟测试：以 --http 启动，POST /mcp 完成 initialize，断言返回 serverInfo.name===cms-mcp。
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';

const PORT = 8799;
const child = spawn(process.execPath, ['dist/index.js', '--http', String(PORT)], {
  env: { ...process.env, CMS_BASE_URL: 'http://localhost:3000/api' },
  stdio: ['ignore', 'ignore', 'ignore'],
});

async function waitReady(tries = 50) {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(`http://localhost:${PORT}/mcp`, { method: 'GET' });
      if (r.status < 500) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('HTTP 服务未就绪');
}

try {
  await waitReady();
  const res = await fetch(`http://localhost:${PORT}/mcp`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'smoke', version: '1.0.0' },
      },
    }),
  });
  assert.equal(res.status, 200, `initialize 应返回 200，实际 ${res.status}`);
  const text = await res.text();
  assert.ok(text.includes('cms-mcp'), `响应应包含 serverInfo.name=cms-mcp，实际：${text.slice(0, 200)}`);
  console.log('HTTP SMOKE OK');
} finally {
  child.kill();
}
