/**
 * 入口：
 *  - 默认 stdio（供 Claude Desktop / 各类 MCP 客户端以子进程方式启动）
 *  - `--http [port]` 启动 Streamable HTTP 服务（无状态，多客户端可连），默认 8787
 *
 * 用法：
 *   CMS_BASE_URL=http://localhost:3000/api CMS_USERNAME=admin CMS_PASSWORD=*** node dist/index.js
 *   node dist/index.js --http 8787
 */
import http from 'node:http';
import { loadConfig } from './config.js';
import { createServer } from './server.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';

async function runStdio(): Promise<void> {
  const config = loadConfig();
  const server = createServer(config);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // 注意：stdout 是 JSON-RPC 通道，日志一律走 stderr
  console.error(`[cms-mcp] stdio 就绪，后端=${config.baseUrl}`);
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

async function runHttp(port: number): Promise<void> {
  const config = loadConfig();

  const httpServer = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', `http://localhost:${port}`);
    if (url.pathname !== '/mcp') {
      res.statusCode = 404;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ error: 'not found, use /mcp' }));
      return;
    }
    try {
      // 无状态模式：每个请求一个独立 server+transport
      const server = createServer(config);
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      res.on('close', () => {
        void transport.close();
        void server.close();
      });
      await server.connect(transport);
      let body: unknown;
      if (req.method === 'POST') {
        const raw = await readBody(req);
        body = raw ? JSON.parse(raw) : undefined;
      }
      await transport.handleRequest(req, res, body);
    } catch (e) {
      console.error('[cms-mcp] HTTP 请求处理失败', e);
      if (!res.headersSent) {
        res.statusCode = 500;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: e instanceof Error ? e.message : String(e) }));
      }
    }
  });

  await new Promise<void>((resolve) => httpServer.listen(port, resolve));
  console.error(`[cms-mcp] HTTP 就绪：http://localhost:${port}/mcp （POST/GET/DELETE，后端=${config.baseUrl}）`);
}

const arg = process.argv.slice(2);
if (arg[0] === '--http') {
  const port = Number(arg[1] ?? process.env.CMS_MCP_HTTP_PORT ?? '8787');
  runHttp(Number.isFinite(port) ? port : 8787).catch((e) => {
    console.error('[cms-mcp] 启动失败', e);
    process.exit(1);
  });
} else {
  runStdio().catch((e) => {
    console.error('[cms-mcp] 启动失败', e);
    process.exit(1);
  });
}
