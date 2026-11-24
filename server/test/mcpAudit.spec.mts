import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  ACTOR_TOOL_FALLBACK,
  MCP_ACTOR,
  MCP_ACTOR_HEADER,
  MCP_TOOL_HEADER,
  mcpAuditContext,
  normalizeActorTool,
} from '../src/constants/mcpAudit.ts';

/**
 * **MCP 调用审计锁**（2026-11-24）。
 *
 * 真事：外部 AI 经 `mcp/` 读写本系统时，读操作（cms_query / cms_get / cms_whoami /
 * cms_list_resources）**一条日志都不留**——`OperationLogInterceptor` 只放行写方法与 GET 导出下载；
 * 写操作（cms_import）虽然记了，但和人工点「导入」完全无法区分。
 * 于是「AI 查走/导走了什么、谁给的权限」事后答不出来。
 *
 * 本锁保护两件事：
 *   ① 归一化足够严：`x-cms-tool` 是**外部进程**填的，写进审计表前必须只留 `[a-z0-9_-]`；
 *   ② 两端字面量不漂移：`mcp/` 是独立包，不能 import `server/src`，头名只能靠字面量对齐——
 *      改了 server 侧常量而 mcp 侧没改，审计会**静默归零**（不报错、只是查不到 AI 操作）。
 */

const read = (rel: string) => readFileSync(fileURLToPath(new URL(`../../${rel}`, import.meta.url)), 'utf8');

describe('MCP 调用审计：请求头 → OperationLog.actorTool', () => {
  it('没有人机区分头时返回 null（普通请求不受影响）', () => {
    assert.equal(mcpAuditContext({}), null);
    assert.equal(mcpAuditContext({ [MCP_TOOL_HEADER]: 'cms_query' }), null);
  });

  it('认到 x-cms-actor=mcp 就返回上下文（大小写不敏感）', () => {
    const ctx = mcpAuditContext({ [MCP_ACTOR_HEADER]: 'MCP', [MCP_TOOL_HEADER]: 'cms_query' });
    assert.deepEqual(ctx, { actor: MCP_ACTOR, tool: 'cms_query' });
    assert.equal(mcpAuditContext({ [MCP_ACTOR_HEADER]: '  mcp  ' })?.tool, ACTOR_TOOL_FALLBACK);
  });

  it('头的值可能是数组（Node 对重复头就是这样给的），取第一个', () => {
    assert.equal(mcpAuditContext({ [MCP_ACTOR_HEADER]: ['mcp'] })?.actor, MCP_ACTOR);
    assert.equal(mcpAuditContext({ [MCP_ACTOR_HEADER]: ['mcp', 'x'] })?.actor, MCP_ACTOR);
  });

  it('工具名归一：只留 [a-z0-9_-]、转小写、超长截断', () => {
    assert.equal(normalizeActorTool('cms_query'), 'cms_query');
    assert.equal(normalizeActorTool('CMS-Query'), 'cms-query');
    // 外部输入不得把换行/引号/空格带进审计表（伪造日志、破坏 CSV 导出、撑爆列宽）
    assert.equal(normalizeActorTool('cms_query\nFORGED'), 'cms_queryforged');
    assert.equal(normalizeActorTool('  '), ACTOR_TOOL_FALLBACK);
    assert.equal(normalizeActorTool("cms'query;drop"), 'cmsquerydrop');
    assert.equal(normalizeActorTool('a'.repeat(200)).length, 64);
  });

  it('两端字面量必须一致（mcp/ 是独立包，靠字面量对齐）', () => {
    const client = read('mcp/src/cms-client.ts');
    assert.ok(
      client.includes(`MCP_ACTOR_HEADER = '${MCP_ACTOR_HEADER}'`),
      `mcp/src/cms-client.ts 里的发起方头名与 server/src/constants/mcpAudit.ts 不一致（${MCP_ACTOR_HEADER}）——` +
        '两端不一致时审计会静默归零：AI 的调用被记成人工操作，日志页筛「AI/MCP 调用」永远是空。',
    );
    assert.ok(
      client.includes(`MCP_TOOL_HEADER = '${MCP_TOOL_HEADER}'`),
      `mcp/src/cms-client.ts 里的工具名头与 server/src/constants/mcpAudit.ts 不一致（${MCP_TOOL_HEADER}）`,
    );
    assert.ok(
      client.includes(`MCP_ACTOR = '${MCP_ACTOR}'`),
      `mcp/src/cms-client.ts 里的发起方取值与 server/src/constants/mcpAudit.ts 不一致（${MCP_ACTOR}）`,
    );
    // 审计头必须在公共 headers() 里注入，否则只有部分请求带上（下载/上传走的是另一条路径）
    assert.ok(
      /auditHeaders\(\)/.test(client) && /\{[^}]*\.\.\.extra[^}]*\.\.\.auditHeaders\(\)/.test(client),
      'mcp/src/cms-client.ts 的 headers() 必须在统一出口注入 auditHeaders()，否则导出/导入类请求会漏标',
    );
  });

  it('每个 MCP 工具都必须走带审计的注册包装（漏包 = 该工具在审计里等同人工）', () => {
    const src = read('mcp/src/server.ts');
    // 调用点形如 `  tool(` + 下一行的工具名（与手写 registerTool 的排布一致）
    const audited = src.match(/^ {2}tool\($/gm)?.length ?? 0;
    assert.ok(audited >= 8, `只找到 ${audited} 个走 tool() 包装的工具，应为 8 个`);
    // 包装体内部的那次 registerTool 缩进是 4 空格，这里只禁「顶格两空格直接调」
    assert.ok(
      !/^ {2}server\.registerTool\(/m.test(src),
      'mcp/src/server.ts 里有工具绕过了 tool() 包装直接注册：该工具发出的请求不会被标为 AI 操作',
    );
  });
});
