/**
 * other-project 模块对外公开入口。
 *
 * 其他模块只允许 `from '../other-project'`；直接引内部文件会被
 * `scripts/check-module-boundaries.mjs` 判为越界。
 */
export { OtherProjectModule } from './other-project.module';
export { OtherProjectService } from './other-project.service';
