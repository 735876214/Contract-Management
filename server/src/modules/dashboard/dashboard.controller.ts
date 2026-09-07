import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { DashboardService } from './dashboard.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CurrentUser, JwtUser, ProjectId } from '../../common/decorators/user.decorator';

@UseGuards(JwtAuthGuard)
@Controller('dashboard')
export class DashboardController {
  constructor(private service: DashboardService) {}

  @Get('overview')
  overview(@ProjectId() projectId: string, @CurrentUser() user: JwtUser) {
    return this.service.overview(projectId, user);
  }

  @Get('trend')
  trend(@ProjectId() projectId: string) {
    return this.service.trend(projectId);
  }

  @Get('contract-type')
  contractType(@ProjectId() projectId: string) {
    return this.service.contractType(projectId);
  }

  @Get('invoice-stats')
  invoiceStats(@ProjectId() projectId: string) {
    return this.service.invoiceStats(projectId);
  }

  @Get('reminders')
  reminders(@ProjectId() projectId: string, @CurrentUser() user: JwtUser, @Query() query: any) {
    return this.service.reminders(projectId, user);
  }
}
