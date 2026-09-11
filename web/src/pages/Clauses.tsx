import { useCallback, useEffect, useState } from 'react';
import { Card, Table, Button, Form, Input, Select, Space, Modal, Popconfirm, Tag, message } from 'antd';
import { PlusOutlined } from '@ant-design/icons';
import { templateApi } from '@/api/business';
import RichTextEditor from '@/components/RichTextEditor';

/** 模板/条款内容可用变量占位符（按类别分组，供「插入变量」面板展示与搜索） */
export interface VarItem {
  key: string;
  /** 插入到光标处的原始文本；缺省时为 {key} */
  raw?: string;
  tip?: string;
}
export interface VarGroup {
  label: string;
  items: VarItem[];
}

export const VARIABLE_GROUPS: VarGroup[] = [
  {
    label: '合同基本信息',
    items: [
      { key: '合同编号' },
      { key: '合同名称' },
      { key: '合同类型' },
      { key: '合同子类型' },
      { key: '项目名称' },
      { key: '项目简称', tip: '项目字母简称（手工填写）' },
      { key: '供应商名称', tip: '乙方' },
      { key: '合同额', tip: '含税总金额（数字）' },
      { key: '合同额大写', raw: '{{合同额大写}}', tip: '中文大写金额（自动计算）' },
      { key: '签订日期' },
      { key: '合同工期', tip: '工期描述（手工填写）' },
      { key: '合同约定付款方式' },
      { key: '甲方名称', tip: '需方/甲方' },
      { key: '乙方名称', tip: '供方/乙方' },
      { key: '当前日期', tip: '生成当天日期' },
    ],
  },
  {
    label: '合同条款',
    items: [
      { key: '技术条款' },
      { key: '质量条款' },
      { key: '付款条件' },
      { key: '验收方式' },
    ],
  },
  {
    label: '合同清单/附件',
    items: [
      { key: '物料编码清单', raw: '{{物料编码清单}}', tip: '物料编码清单表格' },
      { key: '合同清单', raw: '{{合同清单}}', tip: '合同清单表格' },
    ],
  },
  {
    label: '补充协议',
    items: [
      { key: '补充协议编号', raw: '{{补充协议编号}}', tip: '补充协议编号（原合同编号（N））' },
      { key: '补充协议类型', raw: '{{补充协议类型}}', tip: '涨价 / 降价 / 增量 / 增项 / 其他' },
      { key: '原合同编号', raw: '{{原合同编号}}', tip: '关联原合同编号' },
      { key: '原合同名称', raw: '{{原合同名称}}', tip: '关联原合同名称' },
      { key: '补充协议表', raw: '{{补充协议表}}', tip: '按类型渲染的补充协议明细表格' },
      { key: '原合同金额总价大写', raw: '{{原合同金额总价大写}}', tip: '原合同金额中文大写' },
      { key: '新增合同金额总价大写', raw: '{{新增合同金额总价大写}}', tip: '新增合同金额中文大写' },
      { key: '数量汇总', raw: '{{数量汇总}}', tip: '所有物资数量合计' },
      { key: '累计补充协议占比', raw: '{{累计补充协议占比}}', tip: '累计补充协议金额 / 原合同金额' },
      { key: '其他补充协议内容', raw: '{{其他补充协议内容}}', tip: '其他类补充协议的富文本正文' },
    ],
  },
  {
    label: '其他',
    items: [{ key: '项目简称' }, { key: '合同工期' }],
  },
];

/** 兼容旧调用：扁平变量名数组 */
export const VARIABLES = VARIABLE_GROUPS.flatMap((g) => g.items.map((i) => i.key));

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
