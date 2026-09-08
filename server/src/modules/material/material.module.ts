import { Module } from '@nestjs/common';
import { MaterialController } from './material.controller';
import { MaterialService } from './material.service';
import { DictModule } from '../dict/dict.module';

@Module({
  imports: [DictModule],
  controllers: [MaterialController],
  providers: [MaterialService],
})
export class MaterialModule {}
