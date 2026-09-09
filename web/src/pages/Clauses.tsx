import { useCallback, useEffect, useState } from 'react';
import { Card, Table, Button, Form, Input, Select, Space, Modal, Popconfirm, Tag, message } from 'antd';
import { PlusOutlined } from '@ant-design/icons';
import { templateApi } from '@/api/business';
import RichTextEditor from '@/components/RichTextEditor';

/** 模板/条款内容可用变量占位符说明（需求 2.3：条款库从合同模板页迁移为独立页面） */
export const VARIABLES = [
  '合同编号', '合同名称', '合同类型', '合同额', '税率', '签订日期', '合同约定付款方式',
  '项目名称', '供应商名称', '公司地址', '银行名称', '银行账号', '法人姓名', '法人电话',
  '合同授权人姓名', '合同授权人电话', '合同授权人身份证号', '联系人姓名', '联系人电话', '联系人邮箱',
];

/**
 * 合同条款页面（需求 2.2 修正：原「条款库」统一命名为「合同条款」，功能完整迁移至此）
 * 路由 /base/clause，接口与数据模型不变（/templates/clauses）。
 * 需求 2.3：条款固定四种类型（技术条款/质量条款/付款条件/验收方式），支持按类型筛选。
 */
export const CLAUSE_TYPE_OPTIONS = [
  { value: 'technical', label: '技术条款' },
  { value: 'quality', label: '质量条款' },
  { value: 'payment', label: '付款条件' },
  { value: 'acceptance', label: '验收方式' },
];

/** 类型编码 → 名称 */
export const CLAUSE_TYPE_LABEL: Record<string, string> = Object.fromEntries(
  CLAUSE_TYPE_OPTIONS.map((t) => [t.value, t.label]),
);
export default function Clauses() {
  const [clauses, setClauses] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [filterType, setFilterType] = useState<string | undefined>();
  const [modal, setModal] = useState(false);
  const [editing, setEditing] = useState<any>(null);
  const [form] = Form.useForm();

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res: any = await templateApi.clauses(filterType ? { type: filterType } : undefined);
      setClauses(res?.list || res || []);
    } finally {
      setLoading(false);
    }
  }, [filterType]);

  useEffect(() => {
    load();
  }, [load]);

  const openEdit = (row?: any) => {
    setEditing(row || null);
    form.resetFields();
    if (row) form.setFieldsValue(row);
    setModal(true);
  };

  const submit = async () => {
    const values = await form.validateFields();
    if (editing) await templateApi.updateClause(editing.id, values);
    else await templateApi.createClause(values);
    message.success('保存成功');
    setModal(false);
    setEditing(null);
    load();
  };

  const remove = async (id: string) => {
    await templateApi.removeClause(id);
    message.success('已删除');
    load();
  };

  return (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      <Card
        title="合同条款"
        extra={
          <Space>
            <Select
              allowClear
              placeholder="按条款类型筛选"
              style={{ width: 160 }}
              value={filterType}
              onChange={(v) => setFilterType(v)}
              options={CLAUSE_TYPE_OPTIONS}
            />
            <Button type="primary" icon={<PlusOutlined />} onClick={() => openEdit()}>
              新增条款
            </Button>
          </Space>
        }
      >
        <Table
          rowKey="id"
          loading={loading}
          dataSource={clauses}
          pagination={{ pageSize: 10, showTotal: (t: number) => `共 ${t} 条` }}
          scroll={{ x: 1100 }}
          columns={[
            { title: '序号', key: 'index', width: 70, render: (_, __, i) => i + 1 },
            { title: '条款名称', dataIndex: 'title', width: 220, ellipsis: true },
            {
              title: '条款类型',
              dataIndex: 'type',
              width: 120,
              render: (v: string) => (v ? <Tag color="blue">{CLAUSE_TYPE_LABEL[v] || v}</Tag> : '-'),
            },
            { title: '条款内容', dataIndex: 'content', width: 380, ellipsis: true },
            { title: '创建时间', dataIndex: 'createdAt', width: 170, render: (v) => v?.slice(0, 19).replace('T', ' ') },
            { title: '更新时间', dataIndex: 'updatedAt', width: 170, render: (v) => v?.slice(0, 19).replace('T', ' ') },
            {
              title: '操作',
              width: 140,
              fixed: 'right',
              render: (_, row) => (
                <Space size={4}>
                  <Button type="link" size="small" onClick={() => openEdit(row)}>编辑</Button>
                  <Popconfirm title="确认删除该条款？" onConfirm={() => remove(row.id)}>
                    <Button type="link" size="small" danger>删除</Button>
                  </Popconfirm>
                </Space>
              ),
            },
          ]}
        />
      </Card>

      {/* 新增/编辑条款 */}
      <Modal
        title={editing ? '编辑条款' : '新增条款'}
        open={modal}
        onOk={submit}
        onCancel={() => setModal(false)}
        width={640}
        destroyOnClose
      >
        <Form form={form} layout="vertical">
          <Form.Item name="title" label="条款名称" rules={[{ required: true }]}><Input placeholder="条款标题/名称" /></Form.Item>
          <Form.Item name="type" label="条款类型" rules={[{ required: true, message: '请选择条款类型' }]}>
            <Select placeholder="技术条款 / 质量条款 / 付款条件 / 验收方式" options={CLAUSE_TYPE_OPTIONS} />
          </Form.Item>
          <Form.Item name="content" label="条款内容" rules={[{ required: true }]}>
            <RichTextEditor variables={VARIABLES} minHeight={200} placeholder="条款正文，支持富文本排版与变量占位符" />
          </Form.Item>
        </Form>
      </Modal>
    </Space>
  );
}
