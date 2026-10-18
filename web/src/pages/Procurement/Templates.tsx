import { useMemo, useRef, useState } from 'react';
import { Card, Table, Button, Form, Input, Select, Space, Modal, Popconfirm, message, Tag } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import {
  PlusOutlined,
  ReloadOutlined,
  EditOutlined,
  DeleteOutlined,
  HistoryOutlined,
  SearchOutlined,
} from '@ant-design/icons';
import { procurementApi } from '@/api/modules';
import RichTextEditor from '@/components/RichTextEditor';
import EmptyState from '@/components/EmptyState';
import VersionHistoryModal from '@/components/templates/VersionHistoryModal';
import { useTable } from '@/hooks/useTable';
import { checkPlaceholders } from '@/utils/placeholderCheck';
import {
  PROCUREMENT_MODULES,
  getProcurementVariableGroups,
  procurementModuleLabel,
  extractProcurementVariables,
} from '@/constants/procurementVariables';

/** 采购模块各业务类型的 Word 模板（全局通用；每个业务类型仅一个模板，新增覆盖旧模板） */
interface ProcurementTemplateRow {
  id: string;
  moduleType: string;
  templateName: string;
  content: string;
  variables: string[];
  tags: string | null;
  status: number;
  version: number;
  updatedAt: string;
}

const moduleColor = (code: string): string => {
  const idx = PROCUREMENT_MODULES.findIndex((m) => m.value === code);
  const colors = ['blue', 'geekblue', 'cyan', 'purple', 'gold', 'orange', 'green', 'magenta'];
  return colors[idx >= 0 ? idx % colors.length : 0];
};

export default function ProcurementTemplates() {
  // 能力对齐合同模板（2026-10-18）：服务端筛选 + 分页
  const { loading, list, search, reload, pagination } = useTable<ProcurementTemplateRow>((p) =>
    procurementApi.list(p),
  );

  const [editing, setEditing] = useState<ProcurementTemplateRow | null>(null);
  const [modalOpen, setModalOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [form] = Form.useForm();
  const contentRef = useRef('');
  const [filterForm] = Form.useForm();

  // 版本历史
  const [versionRow, setVersionRow] = useState<ProcurementTemplateRow | null>(null);
  const [versions, setVersions] = useState<any[]>([]);
  const [versionLoading, setVersionLoading] = useState(false);

  const openCreate = () => {
    setEditing(null);
    form.resetFields();
    form.setFieldsValue({ moduleType: undefined, templateName: '', status: 1 });
    contentRef.current = '';
    setModalOpen(true);
  };

  const openEdit = (row: ProcurementTemplateRow) => {
    setEditing(row);
    form.setFieldsValue({
      moduleType: row.moduleType,
      templateName: row.templateName,
      tags: row.tags || undefined,
      status: row.status === 0 ? 0 : 1,
    });
    contentRef.current = row.content || '';
    setModalOpen(true);
  };

  /** 按模块类型查现有模板（不能依赖当前筛选后的列表——筛选后可能看不到冲突行） */
  const findConflict = async (moduleType: string, excludeId?: string) => {
    const res: any = await procurementApi.list({ moduleType, page: 1, pageSize: 1 });
    const rows: any[] = res?.list ?? res?.rows ?? (Array.isArray(res) ? res : []);
    return rows.find((r) => r.moduleType === moduleType && r.id !== excludeId);
  };

  /** 校验并提交；占位符防呆（对齐合同模板）+ 同类型覆盖前确认 */
  const handleSubmit = async () => {
    const values = await form.validateFields();
    const content = contentRef.current || '';
    if (!content.trim()) {
      message.warning('请填写模板内容');
      return;
    }
    const problems = checkPlaceholders(content);
    const payload = {
      moduleType: values.moduleType as string,
      templateName: values.templateName as string,
      content,
      variables: extractProcurementVariables(content),
      tags: values.tags || null,
      status: values.status === 0 ? 0 : 1,
    };
    const doSave = async () => {
      const conflict = await findConflict(payload.moduleType, editing?.id);
      if (conflict) {
        Modal.confirm({
          title: '覆盖确认',
          content: `「${procurementModuleLabel(payload.moduleType)}」已有模板《${conflict.templateName}》，保存后将覆盖旧模板（旧版本会进入版本历史），是否继续？`,
          okText: '覆盖旧模板',
          cancelText: '取消',
          // 新建：把新内容写到冲突模板上；编辑（换了模块类型）：后端 update 会快照并删除冲突行
          onOk: () =>
            editing
              ? doSaveInner(payload, editing.id, editing.version)
              : doSaveInner(payload, conflict.id, conflict.version),
        });
        return;
      }
      await doSaveInner(payload, editing?.id, editing?.version);
    };
    if (problems.length) {
      Modal.confirm({
        title: '占位符写法警告',
        width: 520,
        content: (
          <div>
            <p>以下写法会导致变量或清单表格无法替换（生成文档后残留占位符）：</p>
            <ul style={{ paddingLeft: 20 }}>
              {problems.map((p) => (
                <li key={p} style={{ marginBottom: 4 }}>{p}</li>
              ))}
            </ul>
            <p>仍要保存吗？</p>
          </div>
        ),
        onOk: doSave,
      });
      return;
    }
    await doSave();
  };

  const doSaveInner = async (
    payload: { moduleType: string; templateName: string; content: string; variables: string[]; tags: string | null; status: number },
    editId?: string,
    editVersion?: number,
  ): Promise<void> => {
    setSaving(true);
    try {
      if (editId) {
        await procurementApi.update(editId, { ...payload, version: editVersion });
        message.success('采购模板已更新');
      } else {
        await procurementApi.create(payload);
        message.success('采购模板已保存');
      }
      setModalOpen(false);
      reload();
    } finally {
      setSaving(false);
    }
  };

  const handleRemove = async (id: string): Promise<void> => {
    await procurementApi.remove(id);
    message.success('已删除');
    reload();
  };

  const openVersions = async (row: ProcurementTemplateRow) => {
    setVersionRow(row);
    setVersions([]);
    setVersionLoading(true);
    try {
      const res: any = await procurementApi.versions(row.id);
      setVersions(Array.isArray(res) ? res : res?.list || []);
    } finally {
      setVersionLoading(false);
    }
  };

  const rollback = async (versionId: string) => {
    if (!versionRow) return;
    await procurementApi.rollback(versionRow.id, { versionId });
    message.success('已回滚到该版本');
    setVersionRow(null);
    reload();
  };

  const columns: ColumnsType<ProcurementTemplateRow> = [
    {
      title: '模块类型',
      dataIndex: 'moduleType',
      width: 200,
      render: (v: string) => <Tag color={moduleColor(v)}>{procurementModuleLabel(v)}</Tag>,
    },
    { title: '模板名称', dataIndex: 'templateName', ellipsis: true },
    {
      title: '标签',
      dataIndex: 'tags',
      width: 140,
      render: (v: string) => (v ? v.split(',').filter(Boolean).map((t: string) => <Tag key={t}>{t}</Tag>) : '-'),
    },
    { title: '版本号', dataIndex: 'version', width: 90, render: (v: number) => <Tag color="blue">v{v ?? 1}</Tag> },
    {
      title: '状态',
      dataIndex: 'status',
      width: 90,
      render: (v: number) => (v === 0 ? <Tag>停用</Tag> : <Tag color="green">启用</Tag>),
    },
    {
      title: '更新时间',
      dataIndex: 'updatedAt',
      width: 180,
      render: (v: string) => (v ? String(v).slice(0, 19).replace('T', ' ') : '-'),
    },
    {
      title: '操作',
      width: 220,
      fixed: 'right',
      render: (_, row) => (
        <Space size={4}>
          <Button type="link" size="small" icon={<HistoryOutlined />} onClick={() => openVersions(row)}>版本</Button>
          <Button type="link" size="small" icon={<EditOutlined />} onClick={() => openEdit(row)}>
            编辑
          </Button>
          <Popconfirm title="确认删除该采购模板？（版本历史一并删除）" onConfirm={() => handleRemove(row.id)}>
            <Button type="link" danger size="small" icon={<DeleteOutlined />}>
              删除
            </Button>
          </Popconfirm>
        </Space>
      ),
    },
  ];

  const moduleTypeValue = Form.useWatch('moduleType', form);
  const variableGroups = useMemo(
    () => (moduleTypeValue ? getProcurementVariableGroups(moduleTypeValue) : getProcurementVariableGroups('INITIATE')),
    [moduleTypeValue],
  );

  return (
    <Card
      title="采购模板"
      extra={
        <Space>
          <Button icon={<ReloadOutlined />} onClick={reload}>
            刷新
          </Button>
          <Button type="primary" icon={<PlusOutlined />} onClick={openCreate}>
            新增模板
          </Button>
        </Space>
      }
    >
      <Form
        form={filterForm}
        layout="inline"
        style={{ marginBottom: 16, rowGap: 8 }}
        onFinish={(v) => search({ keyword: v.keyword || undefined, moduleType: v.moduleType || undefined })}
      >
        <Form.Item name="keyword">
          <Input placeholder="模板名称 / 标签关键词" allowClear prefix={<SearchOutlined />} />
        </Form.Item>
        <Form.Item name="moduleType">
          <Select
            allowClear
            style={{ minWidth: 180 }}
            placeholder="模块类型"
            options={PROCUREMENT_MODULES.map((m) => ({ value: m.value, label: m.label }))}
          />
        </Form.Item>
        <Form.Item>
          <Space>
            <Button type="primary" htmlType="submit">查询</Button>
            <Button
              onClick={() => {
                filterForm.resetFields();
                search({ keyword: undefined, moduleType: undefined });
              }}
            >
              重置
            </Button>
          </Space>
        </Form.Item>
      </Form>

      <Table<ProcurementTemplateRow>
        scroll={{ x: 'max-content' }}
        rowKey="id"
        loading={loading}
        dataSource={list}
        columns={columns}
        pagination={pagination}
        locale={{
          emptyText: <EmptyState compact description="暂无采购模板，点击右上角「新增模板」创建" />,
        }}
      />

      <Modal
        title={editing ? '编辑采购模板' : '新增采购模板'}
        open={modalOpen}
        onCancel={() => setModalOpen(false)}
        onOk={handleSubmit}
        confirmLoading={saving}
        okText="保存"
        width={960}
        destroyOnHidden
      >
        <Form form={form} layout="vertical">
          <Space size={16} style={{ display: 'flex', flexWrap: 'wrap' }}>
            <Form.Item
              name="moduleType"
              label="模块类型"
              rules={[{ required: true, message: '请选择模块类型' }]}
              style={{ minWidth: 240 }}
            >
              <Select
                placeholder="请选择模块类型"
                options={PROCUREMENT_MODULES.map((m) => ({ value: m.value, label: m.label }))}
              />
            </Form.Item>
            <Form.Item
              name="templateName"
              label="模板名称"
              rules={[{ required: true, message: '请填写模板名称' }]}
              style={{ minWidth: 280 }}
            >
              <Input placeholder="如：采购公告模板" maxLength={100} />
            </Form.Item>
            <Form.Item name="tags" label="标签" style={{ minWidth: 180 }}>
              <Input placeholder="多个标签用逗号分隔" maxLength={100} />
            </Form.Item>
            <Form.Item name="status" label="状态" style={{ minWidth: 110 }}>
              <Select
                options={[
                  { value: 1, label: '启用' },
                  { value: 0, label: '停用' },
                ]}
              />
            </Form.Item>
          </Space>
          <Form.Item label="模板内容" required>
            <RichTextEditor
              value={editing?.content || ''}
              onChange={(html) => {
                contentRef.current = html;
              }}
              variableGroups={variableGroups}
              variableScope="procurement"
              minHeight={380}
              placeholder="请输入模板内容，可使用「插入变量」添加占位符（如 {{项目名称}}、{{采购公告-采购清单}}）"
            />
          </Form.Item>
          {editing && (
            <div style={{ color: 'var(--cms-muted-soft)' }}>
              提示：每个业务类型仅保留一个模板；选择已有模板的模块类型保存后将覆盖旧模板（旧版本进入版本历史）。
            </div>
          )}
        </Form>
      </Modal>

      <VersionHistoryModal
        open={!!versionRow}
        versions={versions}
        loading={versionLoading}
        emptyText="该模板还没有历史版本（每次编辑/覆盖前会自动保存一份）"
        onClose={() => setVersionRow(null)}
        onRollback={rollback}
      />
    </Card>
  );
}
