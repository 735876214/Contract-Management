-- ============================================================================
-- 异步导入任务（ImportTask）崩溃恢复支持
--
-- 背景：ImportTaskService 采用「进程内 fire-and-forget」执行（无 worker 轮询），
-- 此前 execute() 只把状态置 RUNNING、**没有任何心跳**——进程崩溃/重启后该行会**永久停在
-- RUNNING**（finishedAt 永远为空），导入任务列表里挂着一个永远"进行中"的任务。
--
-- 本迁移：
-- 1) 加 `lockedAt` 心跳列（执行期间随进度刷新）与 `dedupeKey` 幂等去重键；
-- 2) 把索引 (status) 升级为 (status, lockedAt) —— 同时服务「按状态筛列表」与「按心跳回收僵尸」；
-- 3) **就地回收存量僵尸行**：部署前就卡在 PENDING/RUNNING 且已超过 10 分钟的行，进程早已不在，
--    永远不会再推进，直接置为 FAILED 并给出明确提示（幂等：再次执行为空更新）。
-- ============================================================================

-- 1) 结构变更
DROP INDEX "ImportTask_status_idx";

ALTER TABLE "ImportTask" ADD COLUMN     "dedupeKey" TEXT,
ADD COLUMN     "lockedAt" TIMESTAMP(3);

CREATE INDEX "ImportTask_status_lockedAt_idx" ON "ImportTask"("status", "lockedAt");
CREATE INDEX "ImportTask_dedupeKey_idx" ON "ImportTask"("dedupeKey");

-- 2) 存量僵尸行回收（阈值与 IMPORT_TASK_STALE_MS 一致：10 分钟）
UPDATE "ImportTask"
   SET "status"     = 'FAILED',
       "message"    = '导入被中断（服务重启或执行超时），请重新导入',
       "finishedAt" = now()
 WHERE "status" IN ('PENDING', 'RUNNING')
   AND "createdAt" < now() - interval '10 minutes';
