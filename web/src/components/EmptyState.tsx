import type { ReactNode } from 'react';
import { Empty, Button } from 'antd';

/**
 * 统一空状态（列表、卡片、图表容器的空态都走它）。
 *
 * 为什么要有它：改造前各处的空态是裸 `<Empty description="…" />`，
 * 描述文案、插画尺寸、是否给"下一步动作"各写各的 —— 同一屏里两种空态能长得不一样。
 *
 * 取舍：**不做自定义 SVG 插画**。本仓没有插画设计资源，而 [DESIGN.md] §0 已明确
 * "不搬外部设计文档里的摄影与插画规范"，凭空造一套插画只会与既有视觉体系打架。
 * 统一到 AntD 的 `PRESENTED_IMAGE_SIMPLE`（比默认插画小、更克制）+ 可选的行动按钮，
 * 已经能解决"空态太大、没有出口"这两个真实问题。
 */
export interface EmptyStateProps {
  /** 空态文案；默认「暂无数据」 */
  description?: ReactNode;
  /** 行动按钮文案（如「新增台账」「查看全部」）。给了它就渲染一个主色文字链按钮 */
  actionText?: string;
  /** 行动按钮回调 */
  onAction?: () => void;
  /** 自定义行动区（优先于 actionText）；如放多个按钮 */
  action?: ReactNode;
  /**
   * 紧凑态：用于表格 `locale.emptyText`、下拉列表、卡片内的小空态。
   * 去掉插画、缩小内边距 —— 表格空态用大插画会把整页撑开（这正是改造前的问题之一）。
   */
  compact?: boolean;
  /** 容器高度（如图表卡的 300px，避免空态时卡片塌陷） */
  height?: number | string;
}

export default function EmptyState({
  description = '暂无数据',
  actionText,
  onAction,
  action,
  compact,
  height,
}: EmptyStateProps) {
  const actionNode =
    action ??
    (actionText ? (
      <Button type="link" size="small" style={{ padding: 0 }} onClick={onAction}>
        {actionText}
      </Button>
    ) : undefined);

  return (
    <Empty
      image={compact ? Empty.PRESENTED_IMAGE_SIMPLE : undefined}
      styles={{ image: compact ? { height: 40, marginBottom: 8 } : undefined }}
      style={{
        margin: compact ? 0 : '24px 0',
        padding: compact ? '12px 0' : undefined,
        height,
        display: height ? 'flex' : undefined,
        flexDirection: height ? 'column' : undefined,
        justifyContent: height ? 'center' : undefined,
      }}
      description={
        <span className={compact ? 'cms-hint' : undefined}>
          {description}
          {actionNode ? <>　{actionNode}</> : null}
        </span>
      }
    />
  );
}
