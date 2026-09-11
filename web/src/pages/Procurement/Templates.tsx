import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Card, Table, Button, Form, Input, Select, Space, Modal, Popconfirm, message, Tag } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { PlusOutlined, ReloadOutlined, EditOutlined, DeleteOutlined } from '@ant-design/icons';
import { procurementApi } from '@/api/modules';
import RichTextEditor from '@/components/RichTextEditor';
import {
  PROCUREMENT_MODULES,
  getProcurementVariableGroups,
  procurementModuleLabel,
  extractProcurementVariables,
} from '@/constants/procurementVariables';

/** 采购模块各业务类型的 Word 模板（每个业务类型仅一个模板，新增覆盖旧模板） */
interface ProcurementTemplateRow {
  id: string;
  moduleType: string;
  templateName: string;
  content: string;
  variables: string[];
  updatedAt: string;
}

const moduleColor = (code: string): string => {
  const idx = PROCUREMENT_MODULES.findIndex((m) => m.value === code);
  const colors = ['blue', 'geekblue', 'cyan', 'purple', 'gold', 'orange', 'green', 'magenta'];
  return colors[idx >= 0 ? idx % colors.length : 0];
};

export default function ProcurementTemplates() {
  const [loading, setLoading] = useState(false);
  const [rows, setRows] = useState<ProcurementTemplateRow[]>([]);

  const [editing, setEditing] = useState<ProcurementTemplateRow | null>(null);
  const [modalOpen, setModalOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [form] = Form.useForm();
  const contentRef = useRef('');

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = (await procurementApi.list()) as { rows?: ProcurementTemplateRow[] } | ProcurementTemplateRow[] | undefined;
      const list = Array.isArray(res) ? res : (res?.rows ?? []);
      setRows(list);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const openCreate = () => {
    setEditing(null);
    form.resetFields();
    form.setFieldsValue({ moduleType: undefined, templateName: '' });
    contentRef.current = '';
    setModalOpen(true);
  };

  const openEdit = (row: ProcurementTemplateRow) => {
    setEditing(row);
    form.setFieldsValue({ moduleType: row.moduleType, templateName: row.templateName });
    contentRef.current = row.content || '';
    setModalOpen(true);
  };

  /** 校验并提交；新增时若同业务类型已有模板，覆盖前确认 */
  const handleSubmit = async () => {
    const values = await form.validateFields();
    const content = contentRef.current || '';
    if (!content.trim()) {
      message.warning('请填写模板内容');
      return;
    }
    const payload = {
      moduleType: values.moduleType as string,
      templateName: values.templateName as string,
      content,
      variables: extractProcurementVariables(content),
    };
    // 新增（或切换了模块类型）且该类型已有模板 → 覆盖确认
    const conflict = rows.find((r) => r.moduleType === payload.moduleType && r.id !== editing?.id);
    if (conflict) {
      Modal.confirm({
        title: '覆盖确认',
        content: `「${procurementModuleLabel(payload.moduleType)}」已有模板《${conflict.templateName}》，保存后将覆盖旧模板，是否继续？`,
        okText: '覆盖旧模板',
        cancelText: '取消',
        onOk: () => doSave(payload, conflict.id),
      });
      return;
    }
    await doSave(payload, editing?.id);
  };

  const doSave = async (
    payload: { moduleType: string; templateName: string; content: string; variables: string[] },
    editId?: string,
  ): Promise<void> => {
    setSaving(true);
    try {
      if (editId) {
        await procurementApi.update(editId, payload);
        message.success('采购模板已更新');
      } else {
        await procurementApi.create(payload);
        message.success('采购模板已保存');
      }
      setModalOpen(false);
      load();
    } finally {
      setSaving(false);
    }
  };

  const handleRemove = async (id: string): Promise<void> => {
    await procurementApi.remove(id);
    message.success('已删除');
    load();
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
      title: '更新时间',
      dataIndex: 'updatedAt',
      width: 180,
      render: (v: string) => (v ? String(v).slice(0, 19).replace('T', ' ') : '-'),
    },
    {
      title: '操作',
      width: 140,
      render: (_, row) => (
        <Space size={4}>
          <Button type="link" size="small" icon={<EditOutlined />} onClick={() => openEdit(row)}>
            编辑
          </Button>
          <Popconfirm title="确认删除该采购模板？" onConfirm={() => handleRemove(row.id)}>
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
          <Button icon={<ReloadOutlined />} onClick={load}>
            刷新
          </Button>
          <Button type="primary" icon={<PlusOutlined />} onClick={openCreate}>
            新增模板
          </Button>
        </Space>
      }
    >
      <Table<ProcurementTemplateRow>
        rowKey="id"
        loading={loading}
        dataSource={rows}
        columns={columns}
        pagination={false}
        locale={{ emptyText: '暂无采购模板，点击右上角「新增模板」创建' }}
      />

      <Modal
        title={editing ? '编辑采购模板' : '新增采购模板'}
        open={modalOpen}
        onCancel={() => setModalOpen(false)}
        onOk={handleSubmit}
        confirmLoading={saving}
        okText="保存"
        width={960}
        destroyOnClose
      >
        <Form form={form} layout="vertical">
          <Space size={16} style={{ display: 'flex' }}>
            <Form.Item
              name="moduleType"
              label="模块类型"
              rules={[{ required: true, message: '请选择模块类型' }]}
              style={{ minWidth: 260 }}
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
              style={{ minWidth: 360 }}
            >
              <Input placeholder="如：采购公告模板" maxLength={100} />
            </Form.Item>
          </Space>
          <Form.Item label="模板内容" required>
            <RichTextEditor
              value={editing?.content || ''}
              onChange={(html) => {
                contentRef.current = html;
              }}
              variableGroups={variableGroups}
              minHeight={380}
              placeholder="请输入模板内容，可使用「插入变量」添加占位符（如 {{项目名称}}、{{采购公告-采购清单}}）"
            />
          </Form.Item>
          {editing && (
            <div style={{ color: '#8c8c8c' }}>
              提示：每个业务类型仅保留一个模板；选择已有模板的模块类型保存后将覆盖旧模板。
            </div>
          )}
        </Form>
      </Modal>
    </Card>
  );
}
