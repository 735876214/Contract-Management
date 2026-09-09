import { useCallback, useEffect, useState } from 'react';
import { Card, Table, Button, Form, Input, Space, Modal, Popconfirm, message } from 'antd';
import { PlusOutlined } from '@ant-design/icons';
import { templateApi } from '@/api/business';
import DictSelect, { DictTag } from '@/components/DictSelect';
import RichTextEditor from '@/components/RichTextEditor';

/** 模板/条款内容可用变量占位符说明（需求 2.3：条款库从合同模板页迁移为独立页面） */
export const VARIABLES = [
  '合同编号', '合同名称', '合同类型', '合同额', '税率', '签订日期', '合同约定付款方式',
  '项目名称', '供应商名称', '公司地址', '银行名称', '银行账号', '法人姓名', '法人电话',
  '合同授权人姓名', '合同授权人电话', '合同授权人身份证号', '联系人姓名', '联系人电话', '联系人邮箱',
];

/**
 * 条款库页面（需求 2.3）
 * 原为「合同模板」页内嵌 Card，现迁移至「基础信息管理 → 合同条款 → 条款库」菜单，
 * 路由 /base/clause，接口与数据模型保持不变（/templates/clauses）。
 */
export default function Clauses() {
  const [clauses, setClauses] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [modal, setModal] = useState(false);
  const [editing, setEditing] = useState<any>(null);
  const [form] = Form.useForm();

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res: any = await templateApi.clauses();
      setClauses(res?.list || res || []);
    } finally {
      setLoading(false);
    }
  }, []);

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
        title="条款库"
        extra={
          <Button type="primary" icon={<PlusOutlined />} onClick={() => openEdit()}>
            新增条款
          </Button>
        }
      >
        <Table
          rowKey="id"
          loading={loading}
          dataSource={clauses}
          pagination={{ pageSize: 10, showTotal: (t: number) => `共 ${t} 条` }}
          scroll={{ x: 900 }}
          columns={[
            { title: '条款标题', dataIndex: 'title', width: 240 },
            { title: '分类', dataIndex: 'categoryCode', width: 160, render: (v) => <DictTag typeCode="contract_template_category" value={v} /> },
            { title: '内容', dataIndex: 'content', width: 400, ellipsis: true },
            {
              title: '操作',
              width: 160,
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
          <Form.Item name="title" label="条款标题" rules={[{ required: true }]}><Input /></Form.Item>
          <Form.Item name="categoryCode" label="分类">
            <DictSelect typeCode="contract_template_category" />
          </Form.Item>
          <Form.Item name="content" label="条款内容" rules={[{ required: true }]}>
            <RichTextEditor variables={VARIABLES} minHeight={200} placeholder="条款正文，支持富文本排版与变量占位符" />
          </Form.Item>
        </Form>
      </Modal>
    </Space>
  );
}
