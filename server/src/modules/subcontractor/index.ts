/**
 * subcontractor 模块对外公开入口。
 *
 * 其他模块只允许 `from '../subcontractor'`；直接引内部文件会被
 * `scripts/check-module-boundaries.mjs` 判为越界。
 */
export { SubcontractorModule } from './subcontractor.module';
export { SubcontractorService } from './subcontractor.service';
export { resolveOrCreateSubcontractor } from './resolve';
