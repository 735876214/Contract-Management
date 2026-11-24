/**
 * 工具注册：把资源目录映射成 MCP 工具。
 *
 * 工具分三组，对应用户诉求：
 *  - 查询：cms_query / cms_get / cms_whoami / cms_list_resources
 *  - 导出：cms_export / cms_download_template / cms_export_contract_word
 *  - 导入：cms_import（含 validateOnly 预校验）
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { CmsClient, runWithTool } from './cms-client.js';
import { RESOURCES, getResource, requiredQueryFor, type Capability } from './resources.js';
import type { CmsConfig } from './config.js';

type ToolResult = {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
};

function ok(data: unknown): ToolResult {
  const text = typeof data === 'string' ? data : JSON.stringify(data, null, 2);
  return { content: [{ type: 'text', text }] };
}

function fail(err: unknown): ToolResult {
  const msg = err instanceof Error ? err.message : String(err);
  return { content: [{ type: 'text', text: `错误：${msg}` }], isError: true };
}

const resourceKeys = RESOURCES.map((r) => r.key) as [string, ...string[]];
const resourceEnum = z.enum(resourceKeys);

const filterSchema = z.record(z.string(), z.any()).optional();

/** 把 query/filter + 分页拼接成后端查询参数 */
function buildQuery(args: {
  filter?: Record<string, unknown>;
  page?: number;
  pageSize?: number;
  keyword?: string;
}): Record<string, unknown> {
  const q: Record<string, unknown> = { ...(args.filter ?? {}) };
  if (args.page !== undefined) q.page = args.page;
  if (args.pageSize !== undefined) q.pageSize = args.pageSize;
  if (args.keyword !== undefined && q.keyword === undefined) q.keyword = args.keyword;
  return q;
}

function assertRequiredQuery(
  resourceKey: string,
  capability: Capability,
  query: Record<string, unknown>,
): void {
  const r = getResource(resourceKey);
  for (const key of requiredQueryFor(r, capability)) {
    if (query[key] === undefined || query[key] === null || query[key] === '') {
      throw new Error(
        `资源「${r.label}(${r.key})」的${capability}操作缺少必填查询参数 ${key}（通过 query/filter 或工具参数传入）`,
      );
    }
  }
}

/**
 * 递归剔除机密字段（apiKey/secret/password/token 等），
 * 避免把 /auth/profile 返回的系统参数里的机密透传给外部 AI。
 * 未命中机密的字段原样保留（user/permissions/projects 等对 AI 有用）。
 */
const SECRET_KEY_RE = /(api[-_]?key|secret|password|passwd|token|credential|private)/i;
function redactSecrets(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactSecrets);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (SECRET_KEY_RE.test(k)) {
        out[k] = '***';
      } else {
        out[k] = redactSecrets(v);
      }
    }
    return out;
  }
  return value;
}

export function createServer(config: CmsConfig, client = new CmsClient(config)): McpServer {
  const server = new McpServer({
    name: 'cms-mcp',
    version: '1.0.0',
  });

  /**
   * 注册工具（**一律走这个**，不要在下面直接调 `server.registerTool`）。
   *
   * 作用：把 handler 包进 `runWithTool(name)`，于是该工具发出的每个 `/api` 请求都带上
   * `x-cms-actor: mcp` + `x-cms-tool: <name>`，后端据此写审计——**含纯 GET 查询**
   * （cms_query / cms_get / cms_whoami / cms_list_resources 原本一条日志都不留）。
   *
   * 后果提醒：绕过这个包装注册的工具，在审计里与人工操作**完全无法区分**。
   * 所以这里用一个私有别名（而不是直接暴露 server.registerTool）让「漏包」写不出来。
   */
  /**
   * 类型断言刻意保留 `typeof server.registerTool`：这样每个调用点的 `args` 仍由
   * `inputSchema` 推导（与手写 registerTool 时一模一样），不必给 8 个 handler 手标参数类型；
   * 实现体里只是多了 runWithTool 这一层。
   */
  const tool = ((name: string, config: unknown, handler: (args: unknown) => Promise<ToolResult>) =>
    server.registerTool(name as never, config as never, ((args: unknown) =>
      runWithTool(name, () => handler(args))) as never)) as unknown as typeof server.registerTool;

  // ---------------- 元信息 ----------------

  tool(
    'cms_list_resources',
    {
      title: '列出可操作的资源与能力',
      description:
        '返回本 MCP 支持的全部业务资源（项目/供应商/合同/物料/日报/资产/结算/付款/发票/台账/还款/采购任务/字典），' +
        '以及每个资源是否支持查询、Excel 导出、模板下载、导入，是否需要项目上下文。外部 AI 应先调用它了解能力边界。',
      inputSchema: {},
    },
    async () => {
      try {
        return ok({
          baseUrl: config.baseUrl,
          defaultProjectId: config.projectId ?? null,
          exportDir: config.exportDir,
          resources: RESOURCES.map((r) => ({
            key: r.key,
            label: r.label,
            needsProject: r.needsProject,
            canQuery: true,
            canGet: !!r.detailPath,
            canExport: !!r.exportPath,
            canDownloadTemplate: !!r.templateUrl,
            canImport: !!r.importPath,
            requiredQuery: r.requiredQuery ?? {},
            note: r.note ?? null,
          })),
        });
      } catch (e) {
        return fail(e);
      }
    },
  );

  tool(
    'cms_whoami',
    {
      title: '查看当前身份与权限',
      description: '返回当前登录用户、权限码与可访问项目列表，帮助外部 AI 判断能查询/导入哪些项目的数据。',
      inputSchema: {},
    },
    async () => {
      try {
        const profile = await client.profile();
        return ok(redactSecrets(profile));
      } catch (e) {
        return fail(e);
      }
    },
  );

  // ---------------- 查询 ----------------

  tool(
    'cms_query',
    {
      title: '查询列表（分页 + 关键字 + 筛选）',
      description:
        '按资源查询列表数据，返回后端统一信封中的 data。支持 page/pageSize/keyword 及任意筛选字段（filter）。' +
        '合同/物料/日报/资产/结算/付款/发票/台账/还款/采购任务需项目上下文 projectId（可省略，回落 CMS_PROJECT_ID）。',
      inputSchema: {
        resource: resourceEnum,
        projectId: z.string().optional().describe('项目 id（x-project-id）；省略时用环境变量默认值'),
        page: z.number().int().positive().optional(),
        pageSize: z.number().int().positive().optional(),
        keyword: z.string().optional(),
        filter: filterSchema.describe('其它筛选字段，键值对，直接拼到 query string'),
      },
    },
    async (args) => {
      try {
        const r = getResource(args.resource);
        const query = buildQuery(args);
        assertRequiredQuery(args.resource, 'query', query);
        const data = await client.requestJson(r.path, { method: 'GET', query, projectId: args.projectId });
        return ok(data);
      } catch (e) {
        return fail(e);
      }
    },
  );

  tool(
    'cms_get',
    {
      title: '查询单条详情',
      description: '按资源 + id 查询单条详情（GET /<资源路径>/<id>）。',
      inputSchema: {
        resource: resourceEnum,
        id: z.string().describe('记录 id'),
        projectId: z.string().optional(),
      },
    },
    async (args) => {
      try {
        const r = getResource(args.resource);
        if (!r.detailPath) {
          throw new Error(
            `资源「${r.label}(${r.key})」没有单条详情接口，cms_get 不支持；请用 cms_query 按筛选条件检索`,
          );
        }
        const data = await client.requestJson(`${r.detailPath}/${encodeURIComponent(args.id)}`, {
          method: 'GET',
          projectId: args.projectId,
        });
        return ok(data);
      } catch (e) {
        return fail(e);
      }
    },
  );

  // ---------------- 导出 ----------------

  tool(
    'cms_export',
    {
      title: '导出 Excel 到本地文件',
      description:
        '调用后端导出接口，把 Excel 下载到本机导出目录，返回绝对路径与字节数。' +
        '仅对 canExport=true 的资源可用；字典导出需传 query.typeCode。',
      inputSchema: {
        resource: resourceEnum,
        projectId: z.string().optional(),
        query: filterSchema.describe('导出筛选参数（如 dict 的 typeCode）'),
      },
    },
    async (args) => {
      try {
        const r = getResource(args.resource);
        if (!r.exportPath) throw new Error(`资源「${r.label}(${r.key})」不支持 Excel 导出`);
        const query = args.query ?? {};
        assertRequiredQuery(args.resource, 'export', query);
        const result = await client.download(r.exportPath, {
          query,
          projectId: args.projectId,
          filenameHint: `${r.key}.xlsx`,
          timeoutMs: Math.max(config.timeoutMs, 60000),
        });
        return ok({ message: `已导出到 ${result.filePath}`, ...result });
      } catch (e) {
        return fail(e);
      }
    },
  );

  tool(
    'cms_download_template',
    {
      title: '下载导入模板',
      description: '下载某资源的 Excel 导入模板到本机导出目录，返回绝对路径。仅对 canDownloadTemplate=true 的资源可用。',
      inputSchema: {
        resource: resourceEnum,
        projectId: z.string().optional(),
        query: filterSchema,
      },
    },
    async (args) => {
      try {
        const r = getResource(args.resource);
        if (!r.templateUrl) throw new Error(`资源「${r.label}(${r.key})」没有导入模板`);
        const query = args.query ?? {};
        assertRequiredQuery(args.resource, 'template', query);
        const result = await client.download(r.templateUrl, {
          query,
          projectId: args.projectId,
          filenameHint: `${r.key}-template.xlsx`,
          timeoutMs: Math.max(config.timeoutMs, 60000),
        });
        return ok({ message: `已下载模板到 ${result.filePath}`, ...result });
      } catch (e) {
        return fail(e);
      }
    },
  );

  tool(
    'cms_export_contract_word',
    {
      title: '导出合同 Word',
      description: '按合同 id 导出 Word 文档（变量替换后的正文），下载到本机导出目录，返回绝对路径。',
      inputSchema: {
        id: z.string().describe('合同 id'),
        projectId: z.string().optional(),
      },
    },
    async (args) => {
      try {
        const result = await client.download(`contracts/${encodeURIComponent(args.id)}/export-word`, {
          projectId: args.projectId,
          filenameHint: `contract-${args.id}.docx`,
          timeoutMs: Math.max(config.timeoutMs, 60000),
        });
        return ok({ message: `已导出到 ${result.filePath}`, ...result });
      } catch (e) {
        return fail(e);
      }
    },
  );

  // ---------------- 导入 ----------------

  tool(
    'cms_import',
    {
      title: '导入 Excel（可预校验）',
      description:
        '把本机一个 Excel 文件导入到指定资源（multipart，字段名 file）。' +
        'validateOnly=true 时只预校验不写库（/import/validate），返回逐行问题。' +
        '导入为两阶段「全成功或全失败」，失败会返回逐行错误。仅对 canImport=true 的资源可用。',
      inputSchema: {
        resource: resourceEnum,
        filePath: z.string().describe('本机 Excel 文件的绝对路径'),
        projectId: z.string().optional(),
        query: filterSchema.describe('附加查询参数（如 contract-materials 的 contractId、dict 的 typeCode）'),
        validateOnly: z.boolean().optional().describe('true=只预校验不写库'),
      },
    },
    async (args) => {
      try {
        const r = getResource(args.resource);
        if (!r.importPath) throw new Error(`资源「${r.label}(${r.key})」不支持导入`);
        const query = args.query ?? {};
        assertRequiredQuery(args.resource, 'import', query);
        const path = args.validateOnly
          ? r.importValidatePath ?? `${r.importPath}/validate`
          : r.importPath;
        const data = await client.upload(path, args.filePath, {
          query,
          projectId: args.projectId,
          timeoutMs: Math.max(config.timeoutMs, 120000),
        });
        return ok(data);
      } catch (e) {
        return fail(e);
      }
    },
  );

  return server;
}
