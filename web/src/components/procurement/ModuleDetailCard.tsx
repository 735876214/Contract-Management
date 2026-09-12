import { useEffect, useState, type ReactNode } from 'react';
import { Card, Descriptions, Space, Spin, Tag } from 'antd';
import dayjs from 'dayjs';
import { buildProcurementDoc } from '@/utils/procurementExport';
import { replaceProcurementVariables } from '@/constants/procurementVariables';

/**
 * 各采购业务模块统一的「只读详情」视图（需求修正 · 修改二）：
 * 点击模块菜单后默认展示当前任务的只读详情页（基本信息 + 已填写内容），
 * 操作按钮由各页面按状态传入（编辑中：编辑/预览/导出Word/发布；已完成：预览/导出Word/重新编辑）。
 */
export interface ModuleDetailCardProps {
  /** 详情标题，如「采购文件 · 任务详情」 */
  title: string;
  taskNo?: string | null;
  content?: string | null;
  /** 模块状态标签 */
  statusLabel: string;
  statusColor?: string;
  publishedAt?: string | null;
  /** 额外信息项（如采前会的会议时间等） */
  extraDescriptions?: ReactNode;
  /** 只读文档 HTML（变量已替换，含模板底稿） */
  docHtml: string;
  docLoading?: boolean;
  /** 操作按钮组 */
  actions?: ReactNode;
}

export default function ModuleDetailCard({
  title,
  taskNo,
  content,
  statusLabel,
  statusColor,
  publishedAt,
  extraDescriptions,
  docHtml,
  docLoading,
  actions,
}: ModuleDetailCardProps) {
  return (
    <Card
      size="small"
      title={title}
      extra={actions ? <Space wrap>{actions}</Space> : undefined}
    >
      <Descriptions column={3} size="small" bordered style={{ marginBottom: 12 }}>
        <Descriptions.Item label="采购编号">{taskNo || '-'}</Descriptions.Item>
        <Descriptions.Item label="采购内容">{content || '-'}</Descriptions.Item>
        <Descriptions.Item label="状态">
          <Tag color={statusColor ?? (publishedAt ? 'green' : 'orange')}>{statusLabel}</Tag>
        </Descriptions.Item>
        {publishedAt ? (
          <Descriptions.Item label="发布时间">
            {dayjs(publishedAt).format('YYYY-MM-DD HH:mm')}
          </Descriptions.Item>
        ) : null}
        {extraDescriptions}
      </Descriptions>
      <Spin spinning={!!docLoading}>
        <div
          style={{
            maxHeight: '52vh',
            overflow: 'auto',
            border: '1px solid #eee',
            padding: 24,
            background: '#fff',
          }}
          dangerouslySetInnerHTML={{ __html: docHtml || '<p style="color:#bfbfbf">暂无内容</p>' }}
        />
      </Spin>
    </Card>
  );
}

/**
 * 只读详情文档构建：模板优先 → 变量替换 → 图片内联（与预览/导出同一管线，所见即所得）。
 * 构建失败时降级为模块内置文档的变量替换结果。
 */
export function useModuleDetailDoc(
  enabled: boolean,
  moduleType: string,
  taskId: string | undefined,
  docHtml: string,
  values: Record<string, string>,
): { html: string; loading: boolean } {
  const [html, setHtml] = useState('');
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    let alive = true;
    if (!enabled || !docHtml) {
      setHtml('');
      setLoading(false);
      return;
    }
    setLoading(true);
    buildProcurementDoc({ moduleType, taskId, docHtml, values })
      .then(({ html: built }) => {
        if (alive) setHtml(built);
      })
      .catch(() => {
        if (alive) setHtml(replaceProcurementVariables(docHtml, values, moduleType));
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [enabled, moduleType, taskId, docHtml, values]);

  return { html, loading };
}
