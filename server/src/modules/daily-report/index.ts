/**
 * daily-report 模块对外公开入口。
 *
 * 其他模块只允许 `from '../daily-report'`；直接引内部文件会被
 * `scripts/check-module-boundaries.mjs` 判为越界（`auth` 守卫按基础设施白名单例外）。
 */
export { DailyReportModule } from './daily-report.module';
export { DailyReportService } from './daily-report.service';
/** 总日报的推送写入原语（给 receipt-order 的「推送总日报」用，需传入事务句柄） */
export { clearPushedDailyRowsOfReceiptOrder, pushDailyRows } from './daily-report-push-writes';
