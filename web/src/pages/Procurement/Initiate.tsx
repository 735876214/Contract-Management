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
import RichTextEditor from '@/components/RichTextEditor';
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

/** 采购品类（补充三：采购发起第一步填写；决定合同模板映射） */
const PROCUREMENT_CATEGORIES = [
  { value: '物资', label: '物资' },
  { value: '租赁', label: '租赁' },
];

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
  procurementCategory?: string | null;
  createdAt: string;
}

/** 新建/编辑三步流程（问题一 + 补充三）：
 *  第一步 基本信息 + 采购品类 → 第二步 编制总采购清单 → 第三步 技术质量标准/验收方式/付款方式（保存并发布） */
export default function Initiate() {
  const [form] = Form.useForm();
  const [editing, setEditing] = useState<TaskRow | null>(null);
  const [modalOpen, setModalOpen] = useState(false);
  const [saving, setSaving] = useState(false);

  /** 新建三步流程状态：0 基本信息 / 1 编制总采购清单 / 2 技术质量·验收·付款 */
  const [createStep, setCreateStep] = useState(0);
  const [createdTask, setCreatedTask] = useState<{ id: string; taskNo: string; status: string; stage: number } | null>(
    null,
  );
  /** 第二步（编制总采购清单）内容区动作引用 */
  const contentRef = useRef<TotalListContentRef | null>(null);
  const [publishing, setPublishing] = useState(false);
  /** 第二步「下一步」保存总清单时的加载态（补充三：总清单保存后即进入第三步填写三字段） */
  const [advancing, setAdvancing] = useState(false);

  const [detail, setDetail] = useState<(TaskRow & { stages?: FlowStage[] }) | null>(null);
  const [detailOpen, setDetailOpen] = useState(false);
  /** 任务查看弹窗（问题一：已完成任务「查看」→ 任务信息+采购明细+Word 文档） */
  const [viewRow, setViewRow] = useState<ModuleListRow | null>(null);
  /** 总采购清单只读查看弹窗（问题三补充：居中弹窗，非侧边抽屉） */
  const [listTask, setListTask] = useState<ModuleListRow | null>(null);
  /** 列表刷新键 */
  const [listRefresh, setListRefresh] = useState(0);
  const refreshList = () => setListRefresh((k) => k + 1);

  /** 新建流程：第一步填采购类型、采购内容、采购品类（是否需要采前会由总清单合计自动判定） */
  const openCreate = () => {
    setEditing(null);
    setCreateStep(0);
    setCreatedTask(null);
    form.resetFields();
    form.setFieldsValue({ type: 'SINGLE' });
    setModalOpen(true);
  };

  /**
   * 继续编辑：预填基本信息 + 采购品类 + 三字段，从第一步进入（可回看/修改采购品类）。
   * 第二步（编制总清单）与第三步（三字段）随后沿用既有数据。
   */
  const openEdit = async (row: TaskRow) => {
    setEditing(row);
    try {
      const d: any = await procurementTaskApi.detail(row.id);
      const task = d?.data ?? d;
      form.setFieldsValue({
        type: row.type,
        content: row.content,
        purpose: row.purpose,
        procurementCategory: row.procurementCategory ?? undefined,
        techQuality: task?.techQuality ?? '',
        acceptanceMethod: task?.acceptanceMethod ?? '',
        paymentMethod: task?.paymentMethod ?? '',
      });
    } catch {
      form.setFieldsValue({
        type: row.type,
        content: row.content,
        purpose: row.purpose,
        procurementCategory: row.procurementCategory ?? undefined,
      });
    }
    setCreatedTask({ id: row.id, taskNo: row.taskNo, status: row.status, stage: row.stage });
    setCreateStep(0);
    setModalOpen(true);
  };

  /** 第一步「下一步：编制总采购清单」：新建则创建任务，编辑则保存基本信息，均进入第二步 */
  const handleSave = async () => {
    const values = await form.validateFields();
    setSaving(true);
    try {
      if (editing) {
        // 编辑态：保存基本信息（含采购品类）后进入第二步
        await procurementTaskApi.update(editing.id, {
          content: values.content,
          purpose: values.purpose,
          procurementCategory: values.procurementCategory || null,
        });
        message.success('基本信息已保存，请继续编制总采购清单');
        setCreateStep(1);
      } else if (createdTask) {
        // 已创建过（从第二步返回第一步再前进）：不重复创建，仅同步采购品类
        await procurementTaskApi.update(createdTask.id, {
          procurementCategory: values.procurementCategory || null,
        });
        setCreateStep(1);
      } else {
        // 第一步：创建任务后进入第二步（编制总采购清单）
        const res: any = await procurementTaskApi.create({
          type: values.type,
          content: values.content,
          procurementCategory: values.procurementCategory || null,
        });
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

  /** 第二步「下一步：填写技术质量等」：保存总采购清单（不发布），成功后进入第三步 */
  const goToStep3 = async () => {
    if (!createdTask) return;
    setAdvancing(true);
    try {
      const ok = await contentRef.current?.save();
      if (ok) setCreateStep(2);
    } finally {
      setAdvancing(false);
    }
  };

  /** 第三步「保存并发布」：写入三字段，然后发布总清单阶段，关闭弹窗 */
  const handleFinalPublish = async () => {
    if (!createdTask) return;
    const values = await form.validateFields(['techQuality', 'acceptanceMethod', 'paymentMethod']);
    setPublishing(true);
    try {
      await procurementTaskApi.update(createdTask.id, {
        techQuality: values.techQuality || '',
        acceptanceMethod: values.acceptanceMethod || '',
        paymentMethod: values.paymentMethod || '',
      });
      await procurementTaskApi.publish(createdTask.id);
      message.success('采购任务已发布，技术质量/验收方式/付款方式已记录');
      setModalOpen(false);
      setCreateStep(0);
      setCreatedTask(null);
      setEditing(null);
      form.resetFields();
      refreshList();
    } finally {
      setPublishing(false);
    }
  };

  /** 上一步：2→1 / 1→0 */
  const goPrevStep = () => setCreateStep((s) => Math.max(0, s - 1));

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
      title: '采购品类',
      dataIndex: 'procurementCategory',
      width: 100,
      render: (v: string | null | undefined) =>
        v ? <Tag color="purple">{v}</Tag> : <span style={{ color: '#bfbfbf' }}>-</span>,
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
    {
      key: 'procurementCategory',
      label: '采购品类',
      control: 'select' as const,
      options: PROCUREMENT_CATEGORIES.map((c) => ({ value: c.value, label: c.label })),
    },
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
        actionBeforeSearch={
          <Button type="primary" icon={<PlusOutlined />} onClick={openCreate}>
            任务发起
          </Button>
        }
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

      {/* 新建（三步流程）/ 继续编辑（问题一：从第一步进入） */}
      <Modal
        title={
          <Steps
            size="small"
            current={createStep}
            items={[{ title: '基本信息' }, { title: '编制总采购清单' }, { title: '技术质量/验收/付款' }]}
            style={{ maxWidth: 520 }}
          />
        }
        open={modalOpen}
        width={createStep === 1 ? 1320 : createStep === 2 ? 820 : 560}
        footer={
          createStep === 2
            ? [
                <Button key="cancel" onClick={() => setModalOpen(false)}>
                  取消
                </Button>,
                <Button key="prev" onClick={goPrevStep}>
                  上一步
                </Button>,
                <Button key="publish" type="primary" loading={publishing} onClick={handleFinalPublish}>
                  保存并发布
                </Button>,
              ]
            : createStep === 1
              ? [
                  <Button key="cancel" onClick={() => setModalOpen(false)}>
                    取消
                  </Button>,
                  <Button key="prev" onClick={goPrevStep}>
                    上一步
                  </Button>,
                  <Button key="next" type="primary" loading={advancing} onClick={goToStep3}>
                    下一步：填写技术质量等
                  </Button>,
                ]
              : [
                  <Button key="cancel" onClick={() => setModalOpen(false)}>
                    取消
                  </Button>,
                  <Button key="next" type="primary" loading={saving} onClick={handleSave}>
                    下一步：编制总采购清单
                  </Button>,
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
        ) : createStep === 2 && createdTask ? (
          <Form form={form} layout="vertical">
            <Alert
              type="info"
              showIcon
              style={{ marginBottom: 12 }}
              message="以下三项技术/验收/付款标准将随采购任务流转，自动推送到采前会会议纪要、采购公告、采购文件及关联合同模板的对应位置。"
            />
            <Form.Item name="techQuality" label="技术质量标准" getValueFromEvent={(h: string) => h || ''}>
              <RichTextEditor placeholder="填写技术质量标准（富文本）" minHeight={150} />
            </Form.Item>
            <Form.Item name="acceptanceMethod" label="验收方式" getValueFromEvent={(h: string) => h || ''}>
              <RichTextEditor placeholder="填写验收方式（富文本）" minHeight={150} />
            </Form.Item>
            <Form.Item name="paymentMethod" label="付款方式" getValueFromEvent={(h: string) => h || ''}>
              <RichTextEditor placeholder="填写付款方式（富文本）" minHeight={150} />
            </Form.Item>
          </Form>
        ) : (
          <Form form={form} layout="vertical">
            <Form.Item name="type" label="采购类型" rules={[{ required: true, message: '请选择采购类型' }]}>
              <Select disabled={!!editing} options={PROCUREMENT_TASK_TYPES} placeholder="请选择采购类型" />
            </Form.Item>
            <Form.Item name="content" label="采购内容" rules={[{ required: true, message: '请填写采购内容' }]}>
              <Input placeholder="如：钢筋采购" maxLength={100} />
            </Form.Item>
            {/* 补充三：采购品类（物资/租赁），第一步填写，决定合同模板映射 */}
            <Form.Item
              name="procurementCategory"
              label="采购品类"
              rules={[{ required: true, message: '请选择采购品类' }]}
            >
              <Select options={PROCUREMENT_CATEGORIES} placeholder="请选择采购品类（物资 / 租赁）" />
            </Form.Item>
            {editing && (
              <>
                <Form.Item name="purpose" label="采购用途">
                  <Input.TextArea rows={3} placeholder="选填" maxLength={500} />
                </Form.Item>
                <Alert
                  type="info"
                  showIcon
                  message="保存基本信息后，可进入第二步编制总采购清单，再于第三步填写技术质量/验收/付款标准；是否需要采前会会议纪要由总采购清单的预计采购合价合计自动判定（单项采购且合计 ≥ 100 万元时生成）。"
                />
              </>
            )}
            {!editing && (
              <Alert
                type="info"
                showIcon
                message="填写基本信息与采购品类后进入第二步编制总采购清单，再于第三步填写技术质量/验收/付款标准；是否需要采前会会议纪要由总采购清单的预计采购合价合计自动判定，无需手动选择。"
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
              <Descriptions.Item label="采购品类">
                {detail.procurementCategory ? (
                  <Tag color="purple">{detail.procurementCategory}</Tag>
                ) : (
                  <span style={{ color: '#bfbfbf' }}>未填写</span>
                )}
              </Descriptions.Item>
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
