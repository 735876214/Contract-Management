import { useMemo } from 'react';
import { Dropdown, Modal } from 'antd';
import { CloseOutlined, EditOutlined } from '@ant-design/icons';
import { useNavigate } from 'react-router-dom';
import { useTabsStore } from '@/store/tabs';
import { isEditorKey } from '@/utils/tabs';
import { useResponsive } from '@/hooks/useResponsive';
import { renderIcon } from '@/components/Sider/utils/iconHelper';

/**
 * 多页签导航条（主内容区顶部、顶栏与内容区之间）。
 *
 * 分工：**本组件只管"展示 + 交互"**，标签的增删改查全在 `@/store/tabs`（纯逻辑在 `@/utils/tabs`），
 * 页面实例的缓存与挂载在 `BasicLayout`（那里的 `useOutlet()` 才是缓存的数据来源）。
 *
 * 关于响应式：标签栏是**页面外壳**的一部分（它的容器就是视口），故按 DESIGN.md §10.1
 * 用 `useResponsive()`；组件内部的宽度收敛（标签变窄、横向滚动）用纯 CSS。
 *
 * ⚠️ 已知限制（有意接受，不额外处理）：
 * - AntD `Modal` 默认带全屏遮罩 → 打开弹窗时点不到标签栏，"隐藏页面的弹窗滞留"场景不成立；
 * - `Popconfirm` / `Dropdown` 等浮层在切页前会因失焦自行关闭；
 * - `RichTextEditor` 的全屏层已 portal 到 `body`（`containerQuery.spec.mts` 有锁），全屏时同样遮住标签栏。
 */
export default function TagsView() {
  const navigate = useNavigate();
  const { isMobile } = useResponsive();
  const tabs = useTabsStore((s) => s.tabs);
  const activeKey = useTabsStore((s) => s.activeKey);
  const closeTab = useTabsStore((s) => s.closeTab);
  const closeOthers = useTabsStore((s) => s.closeOthers);
  const closeAll = useTabsStore((s) => s.closeAll);
  const closeSide = useTabsStore((s) => s.closeSide);
  const refresh = useTabsStore((s) => s.refresh);
  const dirtyKeys = useTabsStore((s) => s.dirtyKeys);

  const index = useMemo(() => tabs.findIndex((t) => t.key === activeKey), [tabs, activeKey]);
  const closableCount = useMemo(() => tabs.filter((t) => t.closable).length, [tabs]);

  /** 关闭后落到 `activate` 指定的标签；为 null 表示当前标签没被关掉 */
  const go = (activate: string | null) => {
    if (activate) navigate(activate);
  };

  /** 关闭前拦一下：有未保存内容的标签必须先确认（脏状态由编辑器页上报） */
  const requestClose = (key: string, run: () => void) => {
    if (!dirtyKeys.includes(key)) {
      run();
      return;
    }
    Modal.confirm({
      title: '该页有未保存的内容',
      content: '关闭后未保存的内容将丢失，确定关闭吗？',
      okText: '仍然关闭',
      okType: 'danger',
      cancelText: '返回',
      onOk: run,
    });
  };

  // 关闭类操作可能一次关掉多个脏标签；只要其中任何一个脏就统一确认一次
  const requestBatchClose = (scopeKeys: string[], run: () => void) => {
    const hit = scopeKeys.filter((k) => dirtyKeys.includes(k));
    if (!hit.length) {
      run();
      return;
    }
    Modal.confirm({
      title: `有 ${hit.length} 个标签存在未保存的内容`,
      content: '关闭后这些标签里未保存的内容将丢失，确定继续吗？',
      okText: '仍然关闭',
      okType: 'danger',
      cancelText: '返回',
      onOk: run,
    });
  };

  const contextItems = (key: string) => {
    const i = tabs.findIndex((t) => t.key === key);
    return [
      { key: 'refresh', label: '刷新当前页' },
      { type: 'divider' as const },
      { key: 'others', label: '关闭其他标签', disabled: closableCount === 0 },
      { key: 'left', label: '关闭左侧标签', disabled: !tabs.slice(0, i).some((t) => t.closable) },
      { key: 'right', label: '关闭右侧标签', disabled: !tabs.slice(i + 1).some((t) => t.closable) },
      { key: 'all', label: '关闭全部标签', disabled: closableCount === 0 },
    ];
  };

  const onContextClick = (key: string, action: string) => {
    if (action === 'refresh') {
      // 递增 version → 缓存键变化 → 该标签内的页面重挂载并重新取数。
      // 脏标签必须先确认：重挂载等于把未保存的编辑直接扔掉（第 17~20 轮审计）。
      if (!dirtyKeys.includes(key)) {
        refresh(key);
        return;
      }
      Modal.confirm({
        title: '该页有未保存的内容',
        content: '刷新会重新加载页面，未保存的内容将丢失，确定刷新吗？',
        okText: '仍然刷新',
        okType: 'danger',
        cancelText: '取消',
        onOk: () => refresh(key),
      });
      return;
    }
    if (action === 'others') {
      requestBatchClose(tabs.filter((t) => t.closable && t.key !== key).map((t) => t.key), () => go(closeOthers(key)));
      return;
    }
    if (action === 'all') {
      requestBatchClose(tabs.filter((t) => t.closable).map((t) => t.key), () => go(closeAll()));
      return;
    }
    const i = tabs.findIndex((t) => t.key === key);
    const scope = action === 'left' ? tabs.slice(0, i) : tabs.slice(i + 1);
    requestBatchClose(scope.filter((t) => t.closable).map((t) => t.key), () =>
      go(closeSide(key, action === 'left' ? 'left' : 'right')),
    );
  };

  return (
    <div
      className={`cms-tags-view${isMobile ? ' is-compact' : ''}`}
      role="tablist"
      aria-label="已打开的页面"
    >
      {tabs.map((t) => {
        const active = t.key === activeKey;
        const dirty = dirtyKeys.includes(t.key);
        const editor = isEditorKey(t.key);
        return (
          <Dropdown
            key={t.key}
            trigger={['contextMenu']}
            menu={{
              items: contextItems(t.key),
              onClick: ({ key: action }) => onContextClick(t.key, action),
            }}
          >
            <div
              role="tab"
              aria-selected={active}
              className={`cms-tags-view__item${active ? ' is-active' : ''}${dirty ? ' is-dirty' : ''}${
                editor ? ' is-editor' : ''
              }`}
              onClick={() => {
                if (!active) navigate(t.href);
              }}
            >
              {/* 图标仅激活态显示（一排小图标过吵；参考图 3 也是仅激活标签带图标） */}
              {active && (
                <span className="cms-tags-view__icon">
                  {editor ? <EditOutlined /> : t.icon ? renderIcon(t.icon) : null}
                </span>
              )}
              <span className="cms-tags-view__label" title={t.title}>
                {t.title}
              </span>
              {t.closable && (
                <button
                  type="button"
                  className="cms-tags-view__close"
                  aria-label={`关闭 ${t.title}`}
                  onClick={(e) => {
                    e.stopPropagation();
                    requestClose(t.key, () => go(closeTab(t.key)));
                  }}
                >
                  <CloseOutlined />
                </button>
              )}
            </div>
          </Dropdown>
        );
      })}
    </div>
  );
}
