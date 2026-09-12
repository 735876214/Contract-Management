import { useEffect, useState } from 'react';
import { Alert, Button, Descriptions, List, Modal, Space, Spin, Tag, message } from 'antd';
import { DownloadOutlined, FileWordOutlined } from '@ant-design/icons';
import dayjs from 'dayjs';
import { procurementTaskApi } from '@/api/modules';
import {
  TASK_STATUS_COLORS,
  TASK_STATUS_LABELS,
  taskStatusLabel,
  taskTypeLabel,
  type FlowStage,
} from '@/constants/procurementWorkflow';
import { TotalListEditorContent } from '@/components/procurement/TotalListEditor';
import { TASK_MODULE_LABELS, exportTaskModuleWord, type TaskModuleType } from '@/utils/procurementTaskDocs';

/**
 * 采购任务查看弹窗（问题一：已完成任务点「查看」→ 居中弹窗）：
 * 任务基本信息 + 采购明细（总采购清单只读）+ 已生成模块的 Word 文档导出列表。
 */

/** 阶段 key → 可导出 Word 的模块类型（总清单/合同阶段无模块文档，不在此列） */
const STAGE_MODULE: Record<string, TaskModuleType> = {
  PRE_MEETING: 'PRE_MEETING',
  NOTICE: 'NOTICE',
  DOCUMENT: 'DOCUMENT',
  RESULT_REPORT: 'RESULT_REPORT',
  PRICE_COMPARE: 'PRICE_COMPARE',
  FRAMEWORK_EXPLAIN: 'FRAMEWORK',
};

interface TaskDetail {
  id: string;
  taskNo: string;
  type: string;
  content: string;
  purpose?: string | null;
  status: string;
  stage: number;
  preMeetingRequired?: boolean;
  estimatedAmountWan?: number | null;
  createdAt?: string;
  stages?: FlowStage[];
}

export interface TaskViewModalProps {
  /** 传入即打开（taskNo 用于标题与采购明细加载） */
  task: { id: string; taskNo: string; status?: string; stage?: number } | null;
  open: boolean;
  onClose: () => void;
}

export default function TaskViewModal({ task, open, onClose }: TaskViewModalProps) {
  const [detail, setDetail] = useState<TaskDetail | null>(null);
  const [loading, setLoading] = useState(false);
  const [exporting, setExporting] = useState<string | null>(null);

  useEffect(() => {
    if (!open || !task?.id) return;
    setLoading(true);
    procurementTaskApi
      .detail(task.id)
      .then((res: any) => setDetail(res?.data ?? res))
      .catch(() => {
        setDetail(null);
        message.error('任务详情加载失败，请稍后重试');
      })
      .finally(() => setLoading(false));
  }, [open, task?.id]);

  /** 已完成阶段 → 可导出的模块文档列表 */
  const wordModules = (detail?.stages ?? [])
    .filter((s) => s.state === 'done' && STAGE_MODULE[s.key])
    .map((s) => STAGE_MODULE[s.key]);

  const handleExport = async (moduleType: TaskModuleType) => {
    if (!task?.id) return;
    setExporting(moduleType);
    try {
      const filename = await exportTaskModuleWord(moduleType, task.id);
      message.success(`已导出：${filename}`);
    } catch (e: any) {
      message.error(e?.message || '导出失败，请稍后重试');
    } finally {
      setExporting(null);
    }
  };

  return (
    <Modal
      title={detail ? `采购任务 · ${detail.taskNo}` : '采购任务'}
      width={1180}
      centered
      open={open}
      onCancel={onClose}
      footer={<Button onClick={onClose}>关闭</Button>}
      destroyOnClose
    >
      <Spin spinning={loading}>
        {detail && (
          <Space direction="vertical" size={16} style={{ width: '100%' }}>
            <Descriptions column={2} size="small" bordered>
              <Descriptions.Item label="采购编号">{detail.taskNo}</Descriptions.Item>
              <Descriptions.Item label="采购类型">
                <Tag color={detail.type === 'FRAMEWORK' ? 'geekblue' : 'cyan'}>{taskTypeLabel(detail.type)}</Tag>
              </Descriptions.Item>
              <Descriptions.Item label="采购内容">{detail.content}</Descriptions.Item>
              <Descriptions.Item label="当前状态">
                <Tag color={TASK_STATUS_COLORS[detail.status] ?? 'default'}>
                  {taskStatusLabel(detail.status) || TASK_STATUS_LABELS[detail.status] || detail.status}
                </Tag>
              </Descriptions.Item>
              <Descriptions.Item label="采购用途">{detail.purpose || '-'}</Descriptions.Item>
              <Descriptions.Item label="预计采购合价合计">
                {detail.estimatedAmountWan != null ? `${detail.estimatedAmountWan} 万元` : '-'}
              </Descriptions.Item>
              <Descriptions.Item label="创建时间">
                {detail.createdAt ? dayjs(detail.createdAt).format('YYYY-MM-DD HH:mm') : '-'}
              </Descriptions.Item>
              <Descriptions.Item label="采前会会议纪要">
                {detail.type === 'FRAMEWORK' ? (
                  <Tag>不需要（引用框架协议）</Tag>
                ) : detail.preMeetingRequired ? (
                  <Tag color="orange">需要（预计采购合价合计 ≥ 100 万元）</Tag>
                ) : (
                  <Tag>不需要（预计采购合价合计 &lt; 100 万元）</Tag>
                )}
              </Descriptions.Item>
            </Descriptions>

            <div>
              <div style={{ marginBottom: 8, fontWeight: 600 }}>采购明细（总采购清单）</div>
              <TotalListEditorContent
                task={{
                  id: detail.id,
                  taskNo: detail.taskNo,
                  status: detail.status,
                  stage: detail.stage,
                }}
                readOnly
                embedded
              />
            </div>

            <div>
              <div style={{ marginBottom: 8, fontWeight: 600 }}>Word 文档</div>
              {wordModules.length ? (
                <List
                  size="small"
                  bordered
                  dataSource={wordModules}
                  renderItem={(m) => (
                    <List.Item
                      actions={[
                        <Button
                          key="export"
                          type="link"
                          size="small"
                          icon={<DownloadOutlined />}
                          loading={exporting === m}
                          onClick={() => handleExport(m)}
                        >
                          导出Word
                        </Button>,
                      ]}
                    >
                      <Space size={8}>
                        <FileWordOutlined style={{ color: '#2b7cff' }} />
                        {TASK_MODULE_LABELS[m]}
                      </Space>
                    </List.Item>
                  )}
                />
              ) : (
                <Alert type="info" showIcon message="暂无已生成的模块 Word 文档（各阶段模块发布后此处提供导出）。" />
              )}
            </div>
          </Space>
        )}
      </Spin>
    </Modal>
  );
}
