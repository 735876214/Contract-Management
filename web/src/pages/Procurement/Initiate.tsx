import { useMemo, useState } from 'react';
import {
  Alert,
  Button,
  Card,
  Descriptions,
  Drawer,
  Form,
  Input,
  Modal,
  Popconfirm,
  Select,
  Space,
  Steps,
  Switch,
  Table,
  Tag,
  Tooltip,
  message,
} from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { DeleteOutlined, PlusOutlined, ReloadOutlined, RocketOutlined, SendOutlined } from '@ant-design/icons';
import { procurementTaskApi } from '@/api/modules';
import { useTable } from '@/hooks/useTable';
import {
  BASIC_EDITABLE_STATUSES,
  PROCUREMENT_TASK_TYPES,
  TASK_STATUS_COLORS,
  taskStatusLabel,
  taskTypeLabel,
  type FlowStage,
  type ProcurementTaskType,
} from '@/constants/procurementWorkflow';
import dayjs from 'dayjs';

/** 采购任务行（批次二 · 任务 2.1） */
interface TaskRow {
  id: string;
  taskNo: string;
  type: string;
  content: string;
  purpose: string;
  status: string;
  stage: number;
  preMeetingRequired: boolean;
  totalListId: string | null;
  contractId: string | null;
  createdAt: string;
}

export default function Initiate() {
  const { loading, list, pagination, search, reload, params, setParams } = useTable<TaskRow>((p) =>
    procurementTaskApi.list(p),
  );

  const [form] = Form.useForm();
  const [editing, setEditing] = useState<TaskRow | null>(null);
  const [modalOpen, setModalOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [detail, setDetail] = useState<(TaskRow & { stages?: FlowStage[] }) | null>(null);
  const [detailOpen, setDetailOpen] = useState(false);
  const [publishing, setPublishing] = useState(false);

  const watchType = Form.useWatch('type', form);

  /** 筛选选项（状态按当前数据出现情况聚合，保证有值可选） */
  const statusOptions = useMemo(() => {
    const set = new Set<string>(list.map((r) => r?.status).filter(Boolean));
    return [...set].map((s) => ({ value: s, label: taskStatusLabel(s) }));
  }, [list]);

  const openCreate = () => {
    setEditing(null);
    form.resetFields();
    form.setFieldsValue({ type: 'SINGLE', preMeetingRequired: false });
    setModalOpen(true);
  };

  const openEdit = (row: TaskRow) => {
    setEditing(row);
    form.setFieldsValue({
      type: row.type,
      content: row.content,
      purpose: row.purpose,
      preMeetingRequired: row.preMeetingRequired,
    });
    setModalOpen(true);
  };

  const handleSave = async () => {
    const values = await form.validateFields();
    setSaving(true);
    try {
      if (editing) {
        await procurementTaskApi.update(editing.id, {
          content: values.content,
          purpose: values.purpose,
          preMeetingRequired: values.type === 'SINGLE' ? !!values.preMeetingRequired : undefined,
        });
        message.success('已保存');
      } else {
        await procurementTaskApi.create({
          type: values.type,
          content: values.content,
          purpose: values.purpose,
          preMeetingRequired: values.type === 'SINGLE' ? !!values.preMeetingRequired : undefined,
        });
        message.success('采购任务已创建（状态：未发起）');
      }
      setModalOpen(false);
      reload();
    } finally {
      setSaving(false);
    }
  };

  const openDetail = async (id: string) => {
    const d: any = await procurementTaskApi.detail(id);
    setDetail(d?.data ?? d);
    setDetailOpen(true);
  };

  /** 发布当前阶段：后端校验前置约束并流转状态 */
  const handlePublish = async (id: string) => {
    setPublishing(true);
    try {
      const d: any = await procurementTaskApi.publish(id);
      const row = d?.data ?? d;
      message.success(`已发布，状态流转为「${taskStatusLabel(row?.status ?? '')}」`);
      setDetailOpen(false);
      reload();
    } finally {
      setPublishing(false);
    }
  };

  const handleRemove = async (id: string) => {
    await procurementTaskApi.remove(id);
    message.success('已删除');
    reload();
  };

  const columns: ColumnsType<TaskRow> = [
    { title: '采购编号', dataIndex: 'taskNo', width: 170 },
    { title: '采购内容', dataIndex: 'content', ellipsis: true },
    {
      title: '采购类型',
      dataIndex: 'type',
      width: 130,
      render: (t: string) => <Tag color={t === 'FRAMEWORK' ? 'geekblue' : 'cyan'}>{taskTypeLabel(t)}</Tag>,
    },
    {
      title: '状态',
      dataIndex: 'status',
      width: 160,
      render: (s: string) => <Tag color={TASK_STATUS_COLORS[s] ?? 'default'}>{taskStatusLabel(s)}</Tag>,
    },
    {
      title: '创建时间',
      dataIndex: 'createdAt',
      width: 170,
      render: (v: string) => (v ? dayjs(v).format('YYYY-MM-DD HH:mm') : '-'),
    },
    {
      title: '操作',
      key: 'action',
      width: 260,
      render: (_, row) => {
        const basicEditable = BASIC_EDITABLE_STATUSES.includes(row.status);
        const publishable = row.status !== 'NOT_STARTED' && !['CONTRACT_EDITING', 'CONTRACT_APPROVING', 'COMPLETED'].includes(row.status);
        const removable = !['CONTRACT_EDITING', 'CONTRACT_APPROVING', 'COMPLETED'].includes(row.status);
        return (
          <Space size={2} wrap>
            <Button type="link" size="small" onClick={() => openDetail(row.id)}>
              查看
            </Button>
            <Tooltip title={basicEditable ? '编辑基本信息' : '已进入后续流程，基本信息不可修改'}>
              <Button type="link" size="small" disabled={!basicEditable} onClick={() => openEdit(row)}>
                继续编辑
              </Button>
            </Tooltip>
            <Popconfirm
              title="发布当前阶段子任务？"
              description="发布后状态将流转到下一阶段，发布前请确认该阶段内容已编制完成。"
              onConfirm={() => handlePublish(row.id)}
              disabled={!publishable}
            >
              <Button type="link" size="small" icon={<SendOutlined />} disabled={!publishable}>
                发布
              </Button>
            </Popconfirm>
            <Popconfirm title="确认删除该采购任务？" onConfirm={() => handleRemove(row.id)} disabled={!removable}>
              <Button type="link" size="small" danger disabled={!removable} icon={<DeleteOutlined />}>
                删除
              </Button>
            </Popconfirm>
          </Space>
        );
      },
    },
  ];

  return (
    <Space direction="vertical" size={12} style={{ width: '100%' }}>
      <Card>
        <Space wrap style={{ marginBottom: 12 }}>
          <Select
            allowClear
            placeholder="状态"
            style={{ width: 180 }}
            options={statusOptions}
            value={params.status || undefined}
            onChange={(v) => setParams((p: any) => ({ ...p, status: v, page: 1 }))}
          />
          <Select
            allowClear
            placeholder="采购类型"
            style={{ width: 160 }}
            options={PROCUREMENT_TASK_TYPES}
            value={(params.type as ProcurementTaskType) || undefined}
            onChange={(v) => setParams((p: any) => ({ ...p, type: v, page: 1 }))}
          />
          <Input.Search
            allowClear
            placeholder="编号 / 采购内容"
            style={{ width: 240 }}
            onSearch={(kw) => search({ keyword: kw })}
          />
          <Button icon={<ReloadOutlined />} onClick={reload}>
            刷新
          </Button>
          <Button type="primary" icon={<PlusOutlined />} onClick={openCreate}>
            新建采购任务
          </Button>
        </Space>
        <Table<TaskRow>
          rowKey="id"
          loading={loading}
          columns={columns}
          dataSource={list}
          pagination={pagination}
          scroll={{ x: 1000 }}
        />
      </Card>

      {/* 新建 / 编辑 */}
      <Modal
        title={editing ? `编辑采购任务 · ${editing.taskNo}` : '新建采购任务'}
        open={modalOpen}
        confirmLoading={saving}
        onOk={handleSave}
        onCancel={() => setModalOpen(false)}
        destroyOnClose
      >
        <Form form={form} layout="vertical">
          <Form.Item name="type" label="采购类型" rules={[{ required: true, message: '请选择采购类型' }]}>
            <Select disabled={!!editing} options={PROCUREMENT_TASK_TYPES} placeholder="请选择采购类型" />
          </Form.Item>
          <Form.Item name="content" label="采购内容" rules={[{ required: true, message: '请填写采购内容' }]}>
            <Input placeholder="如：钢筋采购" maxLength={100} />
          </Form.Item>
          <Form.Item name="purpose" label="采购用途">
            <Input.TextArea rows={3} placeholder="选填" maxLength={500} />
          </Form.Item>
          {watchType === 'SINGLE' && (
            <Form.Item
              name="preMeetingRequired"
              label="需采前会会议纪要"
              valuePropName="checked"
              tooltip="预计采购金额 ≥ 100 万的单项采购需先编制采前会会议纪要"
            >
              <Switch disabled={!!editing && editing.stage >= 1} />
            </Form.Item>
          )}
          {editing && (
            <Alert
              type="info"
              showIcon
              message="基本信息仅可在「未发起 / 总清单编制中」阶段修改；发布后进入后续流程将锁定。"
            />
          )}
        </Form>
      </Modal>

      {/* 详情 + 工作流 */}
      <Drawer
        title={detail ? `采购任务 · ${detail.taskNo}` : '采购任务'}
        width={640}
        open={detailOpen}
        onClose={() => setDetailOpen(false)}
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
                    s.state === 'done' ? '已发布' : s.state === 'editing' ? '编制中（可发布）' : '前置任务未发布，已锁定',
                }))}
              />
            </div>

            {!['CONTRACT_EDITING', 'CONTRACT_APPROVING', 'COMPLETED'].includes(detail.status) && detail.status !== 'NOT_STARTED' && (
              <Button type="primary" icon={<RocketOutlined />} loading={publishing} onClick={() => handlePublish(detail.id)}>
                发布当前阶段
              </Button>
            )}
          </Space>
        )}
      </Drawer>
    </Space>
  );
}
