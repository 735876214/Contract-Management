import { Module } from '@nestjs/common';
import { OtherProjectService } from './other-project.service';
import { OtherProjectController } from './other-project.controller';

@Module({
  controllers: [OtherProjectController],
  providers: [OtherProjectService],
  exports: [OtherProjectService],
})
export class OtherProjectModule {}
