import { Controller, Get, Param, Query, Req, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../modules/auth/guards/jwt-auth.guard';
import { ImportTaskService } from './services/import-task.service';

/**
 * 异步导入任务（需求 2.7）
 * - GET /api/import-tasks            任务列表
 * - GET /api/import-tasks/:id        进度查询（轮询）
 */
@UseGuards(JwtAuthGuard)
@Controller('import-tasks')
export class ImportTaskController {
  constructor(private tasks: ImportTaskService) {}

  @Get()
  list(@Query() query: any, @Req() req: any) {
    return this.tasks.list(query, req.user);
  }

  @Get(':id')
  detail(@Param('id') id: string) {
    return this.tasks.findOne(id);
  }
}
