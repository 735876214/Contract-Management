/**
 * 工具注册：把资源目录映射成 MCP 工具。
 *
 * 工具分三组，对应用户诉求：
 *  - 查询：cms_query / cms_get / cms_whoami / cms_list_resources
 *  - 导出：cms_export / cms_download_template / cms_export_contract_word
 *  - 导入：cms_import（含 validateOnly 预校验）
 */
import { McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { CmsClient, runWithTool } from './cms-client.js';
import {
  RESOURCES,
  getResource,
  permissionCodesFor,
  requiredQueryFor,
  type Capability,
  type CmsResource,
} from './resources.js';
import { PROMPTS } from './prompts.js';
import { CONTEXT_RESOURCES, DICT_URI_TEMPLATE } from './context.js';
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

  // ---------------- 工具级权限 ----------------
  /**
   * 本地权限过滤开关：`CMS_MCP_PERMISSION_FILTER=off` 可关掉。
   *
   * 存在的理由：本地过滤只是 UX（让 AI 在调用前就知道「这个账号查不了合同」），
   * 真正的边界在后端每个接口的 `@RequirePermissions`。若某部署的角色体系与本仓
   * 默认权限码不一致，关掉即可退回「由后端 1403 报错」的行为，不会丢功能。
   */
  const permissionFilterOff = (): boolean =>
    String(process.env.CMS_MCP_PERMISSION_FILTER || '').toLowerCase() === 'off';

  const CAPABILITY_LABEL: Record<Capability, string> = {
    query: '查询',
    export: '导出',
    template: '下载模板',
    import: '导入（会写库）',
  };

  /** 是否有权对某资源执行某能力（OR 语义，与后端 PermissionsGuard 一致） */
  async function allowed(resource: CmsResource, capability: Capability): Promise<boolean> {
    if (permissionFilterOff()) return true;
    const codes = permissionCodesFor(resource, capability);
    if (codes.length === 0) return true;
    const scope = await client.scope();
    if (scope.isSuperAdmin) return true;
    return codes.some((c) => scope.permissions.includes(c));
  }

  /** 无权时给出**可解释**的错误：缺哪个码、怎么继续，而不是让模型自己猜 */
  async function assertAllowed(resource: CmsResource, capability: Capability): Promise<void> {
    if (await allowed(resource, capability)) return;
    const codes = permissionCodesFor(resource, capability);
    throw new Error(
      '当前账号无权对「' +
        resource.label +
        '(' +
        resource.key +
        ')」执行' +
        CAPABILITY_LABEL[capability] +
        '：需 ' +
        codes.join(' 或 ') +
        '。本系统按角色授权，请联系管理员分配后再试（可用 cms_whoami 查看当前权限码）。' +
        '这不是接口故障，重试同样会失败。',
    );
  }

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
        // 过滤关闭时不去 /auth/profile：这条路以前是纯本地的（离线也能列资源目录），
        // 端口一开就让所有工具都依赖后端在线，属于没必要的退步。
        const scope = permissionFilterOff()
          ? { isSuperAdmin: true, permissions: [] as string[] }
          : await client.scope();
        /** OR 语义：与 allowed() 同口径，但这里是同步判断一批资源，避免逐个 await */
        const can = (codes: string[]): boolean =>
          permissionFilterOff() ||
          codes.length === 0 ||
          scope.isSuperAdmin ||
          codes.some((c) => scope.permissions.includes(c));

        const rows = RESOURCES.map((r) => ({
          key: r.key,
          label: r.label,
          needsProject: r.needsProject,
          canQuery: can(r.permissions.read),
          canGet: !!r.detailPath && can(r.permissions.read),
          canExport: !!r.exportPath && can(r.permissions.read),
          canDownloadTemplate: !!r.templateUrl && can(r.permissions.read),
          canImport: !!r.importPath && can(r.permissions.write),
          requiredQuery: r.requiredQuery ?? {},
          requiredPermissions: r.permissions,
          note: r.note ?? null,
        }));

        // 一项能力都没有的资源不列：否则 AI 会拿「什么都做不了」的 key 反复试，每次换来一条 403。
        // 但被挡掉的是哪些要明确说出来，让人知道该去要什么权限，而不是以为本系统没这个数据。
        const visible = rows.filter(
          (r) => r.canQuery || r.canGet || r.canExport || r.canDownloadTemplate || r.canImport,
        );
        const hiddenByPermission = rows.filter((r) => !visible.includes(r)).map((r) => r.key);

        return ok({
          baseUrl: config.baseUrl,
          defaultProjectId: config.projectId ?? null,
          exportDir: config.exportDir,
          permissionFilter: permissionFilterOff() ? 'off' : 'on',
          hiddenByPermission,
          resources: visible,
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
        // 工具级权限：先判本地，让「查不了」在调用前就说清楚（后端仍是最终边界）
        await assertAllowed(r, 'query');
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
        // 工具级权限：先判本地，让「查不了」在调用前就说清楚（后端仍是最终边界）
        await assertAllowed(r, 'query');
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
        // 工具级权限：先判本地，让「查不了」在调用前就说清楚（后端仍是最终边界）
        await assertAllowed(r, 'export');
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
        // 工具级权限：先判本地，让「查不了」在调用前就说清楚（后端仍是最终边界）
        await assertAllowed(r, 'template');
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
        await assertAllowed(getResource('contracts'), 'query');
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
        // 工具级权限：先判本地，让「查不了」在调用前就说清楚（后端仍是最终边界）
        await assertAllowed(r, 'import');
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

  // ---------------- 口径提示词（MCP prompts） ----------------
  /**
   * 注册本系统的口径提示词。
   *
   * 正文一律向服务端取（单一事实源在 server 侧 `ai-insight/prompt-catalog.ts`），
   * 本包只声明结构 —— 系统更新口径后，外部 AI 下次 `prompts/get` 自动拿到新版本，本包不必发版。
   *
   * 权限：走后端 `ai:view`。无该权限时 `prompts/get` 会拿到可读的 403 文案；
   * `prompts/list` 无法按用户过滤（MCP 的 list 是全局的），所以照常列出。
   */
  for (const spec of PROMPTS) {
    const argsShape: Record<string, z.ZodTypeAny> = {};
    for (const a of spec.args) {
      argsShape[a.name] = a.required
        ? z.string().describe(a.description)
        : z.string().optional().describe(a.description);
    }
    server.registerPrompt(
      spec.key,
      { title: spec.title, description: spec.description, argsSchema: argsShape as never },
      (async (args: Record<string, string | undefined>) => {
        const text = await client.promptText(spec.key, args || {});
        return { messages: [{ role: 'user' as const, content: { type: 'text' as const, text } }] };
      }) as never,
    );
  }

  // ---------------- 口径上下文（MCP resources） ----------------
  /**
   * 只读口径资源：状态码与统计排除项 / 采购工作流 / 指标口径。
   *
   * 正文一律向服务端取（`GET /api/ai/context/:key`，内容由 `server/src/constants/*` 生成），
   * 本包只声明 uri 与元信息。客户端可以在**不调工具**的情况下先读这三份，再决定怎么查数——
   * 这比「让模型自己猜 PARTIAL 是什么意思」可靠得多。
   */
  for (const spec of CONTEXT_RESOURCES) {
    server.registerResource(
      spec.key,
      spec.uri,
      { title: spec.name, description: spec.description, mimeType: spec.mimeType },
      (async (uri: URL) => {
        const doc = await client.contextDoc(spec.key);
        return { contents: [{ uri: uri.href, mimeType: spec.mimeType, text: doc.markdown }] };
      }) as never,
    );
  }

  /**
   * 字典项资源模板 `cms://dict/{typeCode}`。
   *
   * 状态码的中文标签在数据库里（`DictItem`），不在代码里——上面那份 statuses 文档只有 code。
   * 标签必须走这条资源取，否则就是在 MCP 里硬编码第二份标签。
   * 不做本地权限判定：后端该接口只要求登录（前端下拉数据源同款）。
   */
  server.registerResource(
    'dict',
    new ResourceTemplate(DICT_URI_TEMPLATE, { list: undefined }),
    {
      title: '数据字典',
      description: '按 typeCode 取字典项（code → 中文标签）。typeCode 清单见 cms://context/statuses。',
      mimeType: 'application/json',
    },
    (async (uri: URL, variables: Record<string, string | string[]>) => {
      const raw = variables?.typeCode;
      const typeCode = Array.isArray(raw) ? String(raw[0] || '') : String(raw || '');
      const items = await client.dictOptions(typeCode);
      return {
        contents: [
          {
            uri: uri.href,
            mimeType: 'application/json',
            text: JSON.stringify({ typeCode, items }, null, 2),
          },
        ],
      };
    }) as never,
  );

  return server;
}
