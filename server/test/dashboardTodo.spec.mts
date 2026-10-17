import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { TODO_CATEGORIES } from '../src/constants/todoCategories.ts';
import { DASHBOARD_TODO_TABS } from '../../web/src/constants/dashboardTodoTabs.ts';

/**
 * 「我的待办」分类的前后端镜像锁（业务口径 2026-10-16：为每个模块都预留一个待办位置）。
 * 与 paymentModes / TASK_STATUS_COLORS 同一套做法：后端聚合接口按 TODO_CATEGORIES 分组，
 * 前端工作台的分类 Tab 按 DASHBOARD_TODO_TABS 渲染 —— 两侧必须逐条一致，任一侧改动未同步即红。
 */
describe('我的待办：前后端分类镜像', () => {
  it('key 逐条一致且顺序相同（Tab 的展示顺序就是注册表顺序）', () => {
    assert.deepEqual(
      DASHBOARD_TODO_TABS.map((t) => t.key),
      TODO_CATEGORIES.map((c) => c.key),
    );
  });

  it('label 逐条一致（Tab 上的文字就是分类名）', () => {
    assert.deepEqual(
      DASHBOARD_TODO_TABS.map((t) => t.label),
      TODO_CATEGORIES.map((c) => c.label),
    );
  });

  it('每个分类都声明了权限码（决定该分类对哪些用户可见）', () => {
    for (const c of TODO_CATEGORIES) {
      assert.match(c.permission, /^(contract|settlement|payment|invoice|finance):view$/);
    }
  });

  it('每类都有合理的下发上限（工作台是入口不是完整列表）', () => {
    for (const c of TODO_CATEGORIES) {
      assert.ok(c.limit >= 1 && c.limit <= 50, `${c.key}.limit=${c.limit} 不合理`);
    }
  });

  it('key 不重复（注册表写重了会把两类的待办混在一起）', () => {
    const keys = TODO_CATEGORIES.map((c) => c.key);
    assert.equal(new Set(keys).size, keys.length);
  });
});
