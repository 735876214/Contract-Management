/**
 * procurement 模块对外公开入口。
 *
 * 其他模块只允许 `from '../procurement'`；直接引内部文件会被
 * `scripts/check-module-boundaries.mjs` 判为越界（`auth` 守卫按基础设施白名单例外）。
 */

export { ProcurementModule } from './procurement.module';
export { ProcurementTaskService } from './procurement-task.service';
export { ProcurementTemplateService } from './procurement-template.service';
// 采购任务写入原语：合同签章后回写任务状态走这里，不直接写表
export { setProcurementTaskStatus } from './procurement-task-writes';