import { Module } from '@nestjs/common';
import { DevExampleController } from './dev-example.controller';
import { DevExampleService } from './dev-example.service';

/**
 * 插件自带的 Nest 模块。
 *
 * 只在插件**被启用**时由 `server/src/plugins/plugin-modules.ts` 放进 `AppModule` 的
 * `imports`（构建期装配，见 `server/src/plugins/README.md`）。禁用时本模块不会挂载，
 * 其路由自然 404——先隐藏，再保护，而不是先删代码。
 */
@Module({
  controllers: [DevExampleController],
  providers: [DevExampleService],
})
export class DevExampleModule {}
