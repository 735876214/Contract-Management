import { Global, Module } from '@nestjs/common';
import { DictService } from './dict.service';
import { DictController } from './dict.controller';

/** 字典服务全系统使用（下拉数据源 + 后端枚举校验），声明为全局模块 */
@Global()
@Module({
  controllers: [DictController],
  providers: [DictService],
  exports: [DictService],
})
export class DictModule {}
