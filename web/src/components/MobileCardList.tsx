import type { ReactNode } from 'react';
import { Card, Pagination, Spin } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import EmptyState from '@/components/EmptyState';
import { columnKeyOf } from '@/utils/listColumns';

/**
 * 窄容器（手机）列表的**卡片视图**（docs/09 §4 阶段 B）。
 *
 * 为什么复用「列」而不是每页手写卡片：组件按已渲染的列定义逐列取值/格式化，
 * 于是移动端列模板（4–6 列）直接决定卡片上显示哪几行，列设置、格式化、
 * 行操作（「操作」列）全部沿用同一份定义——不会出现"表格改了、卡片没跟上"。
 *
 * 只负责**展示**：分页、loading、空态与表格同源；行点击可选（如台账下钻）。
 */
export interface MobileCardPagination {
  current?: number;
  pageSize?: number;
  total?: number;
  onChange?: (page: number, pageSize: number) => void;
}

export interface MobileCardListProps<T> {
  rows: T[];
  /** 与表格相同的列定义（一般是已按移动端预设过滤后的列） */
  columns: ColumnsType<T>;
  /** 行键字段名，默认 `id` */
  rowKey?: string;
  loading?: boolean;
  /** 与表格相同的分页配置；`false`/不传 = 不分页 */
  pagination?: MobileCardPagination | false;
  emptyText?: ReactNode;
  onCardClick?: (row: T) => void;
}

/** 按 antd 的 `dataIndex` 语义取值（支持 `['a', 'b']` 这种嵌套路径） */
function readDataIndex(row: any, dataIndex: unknown): unknown {
  if (dataIndex == null) return undefined;
  if (Array.isArray(dataIndex)) {
    return dataIndex.reduce<any>((acc, k) => (acc == null ? acc : acc[k]), row);
  }
  return row?.[dataIndex as string | number];
}

function renderCell(column: any, row: any, index: number): ReactNode {
  const value = readDataIndex(row, column.dataIndex);
  if (typeof column.render === 'function') return column.render(value, row, index);
  return value == null || value === '' ? '-' : (value as ReactNode);
}

export default function MobileCardList<T extends Record<string, any>>({
  rows,
  columns,
  rowKey = 'id',
  loading = false,
  pagination,
  emptyText,
  onCardClick,
}: MobileCardListProps<T>) {
  const actionColumn = columns.find((c) => columnKeyOf(c as any) === 'op');
  const fields = columns.filter((c) => c !== actionColumn);

  const pageProps =
    pagination === false || !pagination
      ? null
      : {
          current: pagination.current,
          pageSize: pagination.pageSize,
          total: pagination.total,
          showSizeChanger: false,
          size: 'small' as const,
          showTotal: (t: number) => `共 ${t} 条`,
          onChange: pagination.onChange,
        };

  return (
    <Spin spinning={loading}>
      {rows.length === 0 ? (
        <EmptyState compact description={emptyText ?? '暂无数据'} />
      ) : (
        rows.map((row, index) => {
          const [titleField, ...restFields] = fields;
          return (
            <Card
              key={String(row[rowKey] ?? index)}
              size="small"
              className="mobile-card-item"
              style={{ marginBottom: 12 }}
              onClick={onCardClick ? () => onCardClick(row) : undefined}
              hoverable={!!onCardClick}
            >
              {titleField && (
                <div style={{ fontWeight: 600, marginBottom: 8, wordBreak: 'break-all' }}>
                  {renderCell(titleField, row, index)}
                </div>
              )}
              <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                {restFields.map((col, i) => (
                  <div key={columnKeyOf(col as any) || `f-${i}`} style={{ display: 'flex', gap: 8, fontSize: 13 }}>
                    <span style={{ flex: '0 0 88px', color: 'var(--cms-muted-soft)' }}>{col.title as ReactNode}</span>
                    <span style={{ flex: 1, minWidth: 0, wordBreak: 'break-all' }}>{renderCell(col, row, index)}</span>
                  </div>
                ))}
              </div>
              {actionColumn && (
                <div
                  style={{
                    marginTop: 8,
                    paddingTop: 8,
                    borderTop: '1px solid var(--cms-hairline-soft)',
                    display: 'flex',
                    justifyContent: 'flex-end',
                  }}
                >
                  {renderCell(actionColumn, row, index)}
                </div>
              )}
            </Card>
          );
        })
      )}
      {pageProps && (pageProps.total ?? 0) > 0 && (
        <Pagination style={{ marginTop: 4, textAlign: 'center' }} {...pageProps} />
      )}
    </Spin>
  );
}
