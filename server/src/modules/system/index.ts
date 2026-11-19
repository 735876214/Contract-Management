/**
 * system 模块对外公开入口。
 *
 * 其他模块只允许 `from '../system'`；直接引内部文件会被
 * `scripts/check-module-boundaries.mjs` 判为越界（`auth` 守卫按基础设施白名单例外）。
 */

export { SystemModule } from './system.module';
export { SystemService } from './system.service';
export { MenuService } from './menu.service';
// 用户表写入原语：认证模块记最后登录时间/改密码走这里，不直接写表
export { touchUserLastLogin, setUserPasswordHash } from './user-writes';