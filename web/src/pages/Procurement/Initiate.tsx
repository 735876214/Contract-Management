import { useRef, useState } from 'react';
import {
  Alert,
  Button,
  Descriptions,
  Form,
  Input,
  Modal,
  Select,
  Space,
  Steps,
  Tag,
  message,
} from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { FileWordOutlined, PlusOutlined } from '@ant-design/icons';
import { procurementTaskApi } from '@/api/modules';
import TotalListEditor, {
  TotalListEditorContent,
  type TotalListContentRef,
} from '@/components/procurement/TotalListEditor';
import TaskViewModal from '@/components/procurement/TaskViewModal';
import ModuleListPage, { type ModuleListRow } from '@/components/procurement/ModuleListPage';
import {
  BASIC_EDITABLE_STATUSES,
  PROCUREMENT_TASK_TYPES,
  TASK_STATUS_COLORS,
  TASK_STATUS_LABELS,
  taskStatusLabel,
  taskTypeLabel,
  type FlowStage,
} from '@/constants/procurementWorkflow';
import { exportTaskModuleWord, TASK_MODULE_LABELS, type TaskModuleType } from '@/utils/procurementTaskDocs';
import dayjs from 'dayjs';

/** 采购任务行（批次二 · 任务 2.1；列表数据同 ModuleListRow，用途字段另行透出） */
interface TaskRow {
  id: string;
  taskNo: string;
  type: string;
  content: string;
  purpose: string;
  status: string;
  stage: number;
  preMeetingRequired: boolean;
  estimatedAmountWan?: number;
  totalListId: string | null;
  contractId: string | null;
  createdAt: string;
}

/** 新建/编辑两步流程（需求修正 修改一 + 问题一/三）：第一步 基本信息 → 第二步 编制总采购清单（保存并发布） */
export default function Initiate() {
  const [form] = Form.useForm();
  const [editing, setEditing] = useState<TaskRow | null>(null);
  const [modalOpen, setModalOpen] = useState(false);
  const [saving, setSaving] = useState(false);

  /** 新建两步流程状态 */
  const [createStep, setCreateStep] = useState(0);
  const [createdTask, setCreatedTask] = useState<{ id: string; taskNo: string; status: string; stage: number } | null>(
    null,
  );
  /** 第二步内容区动作引用（问题三：「保存并发布」由外层 footer 触发） */
  const contentRef = useRef<TotalListContentRef | null>(null);
  const [publishing, setPublishing] = useState(false);

  const [detail, setDetail] = useState<(TaskRow & { stages?: FlowStage[] }) | null>(null);
  const [detailOpen, setDetailOpen] = useState(false);
  /** 任务查看弹窗（问题一：已完成任务「查看」→ 任务信息+采购明细+Word 文档） */
  const [viewRow, setViewRow] = useState<ModuleListRow | null>(null);
  /** 总采购清单只读查看弹窗（问题三补充：居中弹窗，非侧边抽屉） */
  const [listTask, setListTask] = useState<ModuleListRow | null>(null);
  /** 列表刷新键 */
  const [listRefresh, setListRefresh] = useState(0);
  const refreshList = () => setListRefresh((k) => k + 1);

  /** 新建流程：第一步只填采购类型与采购内容（是否需要采前会由总清单合计自动判定） */
  const openCreate = () => {
    setEditing(null);
    setCreateStep(0);
    setCreatedTask(null);
    form.resetFields();
    form.setFieldsValue({ type: 'SINGLE' });
    setModalOpen(true);
  };

  /**
   * 继续编辑（问题一）：stage 0（未发起/总清单编制中）的任务直接进入第二步
   * 「编制总采购清单」（带出已有明细）；上一步可回到基础信息单独保存。
   */
  const openEdit = (row: TaskRow) => {
    setEditing(row);
    form.setFieldsValue({
      type: row.type,
      content: row.content,
      purpose: row.purpose,
    });
    setCreatedTask({ id: row.id, taskNo: row.taskNo, status: row.status, stage: row.stage });
    setCreateStep(1);
    setModalOpen(true);
  };

  const handleSave = async () => {
    const values = await form.validateFields();
    setSaving(true);
    try {
      if (editing) {
        // 编辑态：仅保存基本信息（问题一：基础信息用单独的保存按钮）
        await procurementTaskApi.update(editing.id, {
          content: values.content,
          purpose: values.purpose,
        });
        message.success('基本信息已保存');
        setModalOpen(false);
        setEditing(null);
        setCreatedTask(null);
        setCreateStep(0);
        refreshList();
      } else if (createdTask) {
        // 已创建过（第二步返回第一步后再下一步）：不重复创建
        setCreateStep(1);
      } else {
        // 第一步：创建任务后进入第二步（编制总采购清单）
        const res: any = await procurementTaskApi.create({ type: values.type, content: values.content });
        const task = res?.data ?? res;
        message.success('基本信息已保存，请继续编制总采购清单');
        setCreatedTask({
          id: task.id,
          taskNo: task.taskNo,
          status: task.status ?? 'NOT_STARTED',
          stage: task.stage ?? 0,
        });
        setCreateStep(1);
        refreshList();
      }
    } finally {
      setSaving(false);
    }
  };

  /** 第二步「保存并发布」（问题三）：保存清单 → 发布阶段 0，成功后关闭弹窗 */
  const handleSaveAndPublish = async () => {
    if (!createdTask) return;
    setPublishing(true);
    try {
      const ok = await contentRef.current?.saveAndPublish();
      if (ok) {
        setModalOpen(false);
        setCreateStep(0);
        setCreatedTask(null);
        setEditing(null);
        refreshList();
      }
    } finally {
      setPublishing(false);
    }
  };

  /** 第二步 → 上一步（基础信息可继续编辑并单独保存） */
  const goPrevStep = () => setCreateStep(0);

  const openDetail = async (id: string) => {
    const d: any = await procurementTaskApi.detail(id);
    setDetail(d?.data ?? d);
    setDetailOpen(true);
  };

  /** 列表行查看（问题一）：已完成任务 → 任务查看弹窗（采购明细+Word 文档）；其余 → 任务详情弹窗 */
  const handleViewRow = (row: ModuleListRow) => {
    if (row.status === 'COMPLETED') setViewRow(row);
    else void openDetail(row.id);
  };

  /** 已完成任务「更多 → 导出Word」子菜单项（问题二：按模块逐个导出） */
  const exportWordChildren = (row: ModuleListRow) =>
    (Object.keys(TASK_MODULE_LABELS) as TaskModuleType[]).map((m) => ({
      key: `export-${m}`,
      label: TASK_MODULE_LABELS[m],
      onClick: async () => {
        try {
          const filename = await exportTaskModuleWord(m, row.id);
          message.success(`已导出：${filename}`);
        } catch (e: any) {
          message.error(e?.message || '导出失败，请稍后重试');
        }
      },
    }));

  const handleRemove = (row: ModuleListRow) => {
    Modal.confirm({
      title: '确认删除该采购任务？',
      content: '删除后任务的全部阶段数据（总清单/各模块文档）将一并移除，不可恢复。',
      okText: '确认删除',
      okType: 'danger',
      onOk: async () => {
        await procurementTaskApi.remove(row.id);
        message.success('已删除');
        refreshList();
      },
    });
  };

  /** 列表特有列（问题四：generic 模式完整列定义） */
  const extraColumns: ColumnsType<ModuleListRow> = [
    {
      title: '采购编号',
      dataIndex: 'taskNo',
      width: 170,
      render: (v: string, row) => (
        <Button type="link" size="small" style={{ padding: 0 }} onClick={() => openDetail(row.id)}>
          {v}
        </Button>
      ),
    },
    { title: '采购内容', dataIndex: 'content', ellipsis: { showTitle: true }, render: (v: string) => v || '-' },
    {
      title: '采购类型',
      dataIndex: 'type',
      width: 120,
      render: (t: string) => <Tag color={t === 'FRAMEWORK' ? 'geekblue' : 'cyan'}>{taskTypeLabel(t)}</Tag>,
    },
    {
      title: '状态',
      dataIndex: 'status',
      width: 150,
      render: (s: string) => <Tag color={TASK_STATUS_COLORS[s] ?? 'default'}>{taskStatusLabel(s)}</Tag>,
    },
    {
      title: '预计金额（万元）',
      dataIndex: 'estimatedAmountWan',
      width: 130,
      align: 'right',
      render: (v: number | null | undefined) => (v != null && v !== undefined ? String(v) : '-'),
    },
    {
      title: '创建时间',
      dataIndex: 'createdAt',
      width: 150,
      render: (v: string) => (v ? dayjs(v).format('YYYY-MM-DD HH:mm') : '-'),
    },
  ];

  /** 列表特有筛选项 */
  const extraFilters = [
    {
      key: 'status',
      label: '状态',
      control: 'select' as const,
      options: Object.entries(TASK_STATUS_LABELS).map(([value, label]) => ({ value, label })),
    },
    { key: 'type', label: '采购类型', control: 'select' as const, options: PROCUREMENT_TASK_TYPES },
    { key: 'keyword', label: '关键词', control: 'input' as const, placeholder: '编号 / 采购内容' },
  ];

  return (
    <Space direction="vertical" size={12} style={{ width: '100%' }}>
      {/* 标准列表页（问题四：与六模块/合同/结算页面统一规约） */}
      <ModuleListPage
        mode="generic"
        fetcher={(params) => procurementTaskApi.list(params)}
        extraFilters={extraFilters as never}
        extraColumns={extraColumns}
        refreshKey={listRefresh}
        onView={handleViewRow}
        onDelete={handleRemove}
        rowMenuItems={(row) => {
          const basicEditable = BASIC_EDITABLE_STATUSES.includes(row.status);
          return [
            {
              key: 'totalList',
              label: row.stage >= 1 ? '总采购清单(已冻结)' : '总采购清单',
              onClick: () => setListTask(row),
            },
            {
              key: 'continue',
              label: '继续编辑',
              disabled: !basicEditable,
              onClick: () => openEdit(row as unknown as TaskRow),
            },
            // 问题二：已完成任务提供各模块 Word 文档导出子菜单
            ...(row.status === 'COMPLETED'
              ? [
                  {
                    key: 'exportWord',
                    label: (
                      <span>
                        <FileWordOutlined /> 导出Word
                      </span>
                    ),
                    children: exportWordChildren(row),
                  },
                ]
              : []),
          ];
        }}
      />

      {/* 新建（两步流程）/ 继续编辑（问题一：直接进入第二步） */}
      <Modal
        title={
          <Steps
            size="small"
            current={createStep}
            items={[{ title: '基本信息' }, { title: '编制总采购清单' }]}
            style={{ maxWidth: 420 }}
          />
        }
        open={modalOpen}
        width={createStep === 1 ? 1320 : 560}
        footer={
          createStep === 1
            ? [
                // 问题三：第二步取消「保存」，升级为「保存并发布」
                <Button key="cancel" onClick={() => setModalOpen(false)}>
                  取消
                </Button>,
                <Button key="prev" onClick={goPrevStep}>
                  上一步
                </Button>,
                <Button key="publish" type="primary" loading={publishing} onClick={handleSaveAndPublish}>
                  保存并发布
                </Button>,
              ]
            : [
                <Button key="cancel" onClick={() => setModalOpen(false)}>
                  取消
                </Button>,
                editing ? (
                  // 问题一：编辑态第一步仅保存基本信息
                  <Button key="save" type="primary" loading={saving} onClick={handleSave}>
                    保存基本信息
                  </Button>
                ) : (
                  <Button key="next" type="primary" loading={saving} onClick={handleSave}>
                    下一步：编制总采购清单
                  </Button>
                ),
              ]
        }
        onCancel={() => setModalOpen(false)}
        forceRender
      >
        {createStep === 1 && createdTask ? (
          <TotalListEditorContent
            ref={contentRef}
            task={createdTask}
            embedded
            onSaved={() => {
              setCreatedTask((t) => (t ? { ...t, status: 'NOT_STARTED' } : t));
            }}
          />
        ) : (
          <Form form={form} layout="vertical">
            <Form.Item name="type" label="采购类型" rules={[{ required: true, message: '请选择采购类型' }]}>
              <Select disabled={!!editing} options={PROCUREMENT_TASK_TYPES} placeholder="请选择采购类型" />
            </Form.Item>
            <Form.Item name="content" label="采购内容" rules={[{ required: true, message: '请填写采购内容' }]}>
              <Input placeholder="如：钢筋采购" maxLength={100} />
            </Form.Item>
            {editing && (
              <>
                <Form.Item name="purpose" label="采购用途">
                  <Input.TextArea rows={3} placeholder="选填" maxLength={500} />
                </Form.Item>
                <Alert
                  type="info"
                  showIcon
                  message="保存基本信息后，可回到第二步继续编制总采购清单；是否需要采前会会议纪要由总采购清单的预计采购合价合计自动判定（单项采购且合计 ≥ 100 万元时生成）。"
                />
              </>
            )}
            {!editing && (
              <Alert
                type="info"
                showIcon
                message="填写基本信息后进入第二步编制总采购清单；是否需要采前会会议纪要由总采购清单的预计采购合价合计自动判定，无需手动选择。"
              />
            )}
          </Form>
        )}
      </Modal>

      {/* 任务查看弹窗（问题一：已完成任务「查看」→ 任务信息+采购明细+Word 文档） */}
      <TaskViewModal task={viewRow} open={!!viewRow} onClose={() => setViewRow(null)} />

      {/* 详情 + 工作流（问题三：居中弹窗；行内/详情发布入口取消，各阶段发布在各模块页面与总清单第二步进行） */}
      <Modal
        title={detail ? `采购任务 · ${detail.taskNo}` : '采购任务'}
        width={640}
        centered
        open={detailOpen}
        onCancel={() => setDetailOpen(false)}
        footer={null}
      >
        {detail && (
          <Space direction="vertical" size={16} style={{ width: '100%' }}>
            <Descriptions column={1} size="small" bordered>
              <Descriptions.Item label="采购编号">{detail.taskNo}</Descriptions.Item>
              <Descriptions.Item label="采购类型">
                <Tag color={detail.type === 'FRAMEWORK' ? 'geekblue' : 'cyan'}>{taskTypeLabel(detail.type)}</Tag>
              </Descriptions.Item>
              <Descriptions.Item label="采购内容">{detail.content}</Descriptions.Item>
              <Descriptions.Item label="采购用途">{detail.purpose || '-'}</Descriptions.Item>
              <Descriptions.Item label="当前状态">
                <Tag color={TASK_STATUS_COLORS[detail.status] ?? 'default'}>{taskStatusLabel(detail.status)}</Tag>
              </Descriptions.Item>
              <Descriptions.Item label="预计采购合价合计">
                {detail.estimatedAmountWan != null ? `${detail.estimatedAmountWan} 万元` : '-'}
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
              <Descriptions.Item label="创建时间">
                {detail.createdAt ? dayjs(detail.createdAt).format('YYYY-MM-DD HH:mm') : '-'}
              </Descriptions.Item>
            </Descriptions>

            <div>
              <div style={{ marginBottom: 12, fontWeight: 600 }}>工作流进度（前一任务未发布时后续任务禁用）</div>
              <Steps
                direction="vertical"
                size="small"
                items={(detail.stages ?? []).map((s) => ({
                  title: s.label,
                  status: s.state === 'done' ? 'finish' : s.state === 'editing' ? 'process' : 'wait',
                  description:
                    s.state === 'done' ? '已发布' : s.state === 'editing' ? '编制中' : '前置任务未发布，已锁定',
                }))}
              />
            </div>
          </Space>
        )}
      </Modal>

      {/* 总采购清单只读查看（问题三补充：居中弹窗） */}
      <TotalListEditor
        task={
          listTask
            ? { id: listTask.id, taskNo: listTask.taskNo, status: listTask.status, stage: listTask.stage }
            : null
        }
        open={!!listTask}
        onClose={() => setListTask(null)}
      />
    </Space>
  );
}
