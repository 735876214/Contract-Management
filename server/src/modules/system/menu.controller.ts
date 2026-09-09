import { Controller, Get, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { MenuService } from './menu.service';
import { CurrentUser, JwtUser } from '../../common/decorators/user.decorator';

/**
 * 菜单接口（前端 Sider 动态加载，需求 5.5）
 * GET /api/menu：按当前用户权限过滤后的菜单树
 */
@UseGuards(JwtAuthGuard)
@Controller('menu')
export class MenuController {
  constructor(private readonly menuService: MenuService) {}

  @Get()
  getMenu(@CurrentUser() user: JwtUser) {
    return this.menuService.getMenuForUser(user);
  }
}
