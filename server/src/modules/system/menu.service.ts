import { Injectable } from '@nestjs/common';
import { JwtUser } from '../../common/decorators/user.decorator';
import { MENU_TREE, MenuNode } from '../../constants/menuTree';

// 菜单配置（含 MenuNode 结构）已抽到 constants/menuTree.ts（零运行时依赖，可被单测直接加载）。
// 此处保留再导出，兼容既有 `import { MenuNode } from './menu.service'` 的引用。
export { MENU_TREE };
export type { MenuNode };

@Injectable()
export class MenuService {
  /** 返回当前用户可见的菜单树 */
  getMenuForUser(user: JwtUser): MenuNode[] {
    const permissions = new Set<string>(user?.permissions || []);
    const isSuperAdmin = !!user?.isSuperAdmin;

    const filter = (nodes: MenuNode[]): MenuNode[] => {
      const out: MenuNode[] = [];
      for (const node of nodes) {
        if (node.permission && !isSuperAdmin && !permissions.has(node.permission)) continue;
        if (node.children) {
          const children = filter(node.children);
          if (children.length === 0) continue; // 子菜单全部无权限 → 分组整体隐藏
          out.push({ ...node, children });
        } else {
          out.push(node);
        }
      }
      return out;
    };

    return filter(MENU_TREE);
  }
}
