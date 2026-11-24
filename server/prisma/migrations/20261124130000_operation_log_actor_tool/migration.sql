-- 操作日志增加「发起方工具」列（2026-11-24 MCP 审计）
--
-- 背景：外部 AI 经 MCP 工具读写本系统时，读操作（cms_query / cms_get / cms_whoami /
-- cms_list_resources）**一条日志都不写**——OperationLogInterceptor 只放行写方法与
-- GET 导出下载；写操作（cms_import）虽然记了，但在日志里与人工点「导入」完全无法区分。
-- 于是「AI 到底查走了什么、谁给的权限」事后答不出来。
--
-- 本列：null = 人工操作；'cms_query' 等 = 外部 AI 经 MCP 工具发起。
-- 不把 bizType 改成 'MCP_TOOL' 的理由见 schema.prisma 该字段上的注释（它有既定语义）。

ALTER TABLE "OperationLog" ADD COLUMN "actorTool" TEXT;

-- 审计最常问的是「只看 AI 发起的操作」，而多数行为 null，普通 btree 索引足够
CREATE INDEX "OperationLog_actorTool_idx" ON "OperationLog" ("actorTool");
