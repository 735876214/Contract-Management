import { useState } from 'react';
import { withToken } from '../utils/download';
import { Card, Table, Button, Form, Input, Space, Modal, Popconfirm, message, Tag, Descriptions, Drawer, Select } from 'antd';
import { PlusOutlined, SearchOutlined, ExportOutlined } from '@ant-design/icons';
import { supplierApi } from '@/api/business';
import { useTable } from '@/hooks/useTable';
import ImportButton from '@/components/ImportButton';

const FIELDS = [
  ['legalPerson', '法人姓名'],
  ['legalPhone', '法人电话'],
  ['contractAuthPerson', '合同授权人姓名'],
  ['contractAuthPhone', '合同授权人电话'],
  ['contractAuthIdNo', '合同授权人身份证号'],
  ['contactName', '联系人姓名'],
  ['contactPhone', '联系人电话'],
  ['contactEmail', '联系人邮箱'],
  ['bankName', '银行名称'],
  ['bankAccount', '银行账号'],
  ['address', '公司地址'],
] as const;

export default function Suppliers() {
  const { loading, list, total, params, search, reload, pagination } = useTable<any>((p) => supplierApi.list(p));
  const [form] = Form.useForm();
  const [modal, setModal] = useState(false);
  const [editing, setEditing] = useState<any>(null);
  const [detail, setDetail] = useState<any>(null);

  const submit = async () => {
    const values = await form.validateFields();
    if (editing) await supplierApi.update(editing.id, values);
    else await supplierApi.create(values);
    message.success('保存成功');
    setModal(false);
    form.resetFields();
    setEditing(null);
    reload();
  };


  return (
    <Card
      title="供应商库"
      extra={
        <Space>
          <ImportButton moduleName="供应商信息" templateUrl={supplierApi.templateUrl()} uploadUrl={supplierApi.importUrl()} onDone={reload} />
          <Button icon={<ExportOutlined />} onClick={() => window.open(withToken(supplierApi.exportUrl()))}>导出</Button>
          <Button type="primary" icon={<PlusOutlined />} onClick={() => { setEditing(null); form.resetFields(); setModal(true); }}>
            新增供应商
          </Button>
        </Space>
      }
    >
      <Form layout="inline" style={{ marginBottom: 16, rowGap: 8 }} onFinish={(v) => search(v)}>
        <Form.Item name="keyword"><Input placeholder="名称/法人/联系人" allowClear prefix={<SearchOutlined />} /></Form.Item>
        <Form.Item name="status">
          <Select
            allowClear
            placeholder="状态"
            style={{ width: 140 }}
            options={[{ value: 1, label: '启用' }, { value: 0, label: '停用' }]}
          />
        </Form.Item>
        <Form.Item><Button type="primary" htmlType="submit">查询</Button></Form.Item>
      </Form>

      <Table
        rowKey="id"
        loading={loading}
        dataSource={list}
        pagination={pagination}
        scroll={{ x: 1600 }}
        columns={[
          { title: '供应商名称', dataIndex: 'name', width: 240, fixed: 'left' },
          { title: '法人姓名', dataIndex: 'legalPerson', width: 110 },
          { title: '法人电话', dataIndex: 'legalPhone', width: 130 },
          { title: '合同授权人', dataIndex: 'contractAuthPerson', width: 130 },
          { title: '授权人电话', dataIndex: 'contractAuthPhone', width: 130 },
          { title: '联系人', dataIndex: 'contactName', width: 110 },
          { title: '联系人电话', dataIndex: 'contactPhone', width: 130 },
          { title: '银行名称', dataIndex: 'bankName', width: 200 },
          { title: '银行账号', dataIndex: 'bankAccount', width: 200 },
          {
            title: '状态',
            dataIndex: 'status',
            width: 90,
            render: (s) => (s === 1 ? <Tag color="green">启用</Tag> : <Tag>停用</Tag>),
          },
          { title: '引用合同', dataIndex: 'contractCount', width: 100 },
          {
            title: '操作',
            width: 220,
            fixed: 'right',
            render: (_, row) => (
              <Space size={4}>
                <Button type="link" size="small" onClick={() => setDetail(row)}>详情</Button>
                <Button type="link" size="small" onClick={() => { setEditing(row); form.setFieldsValue(row); setModal(true); }}>编辑</Button>
                <Button type="link" size="small" onClick={async () => { await supplierApi.toggle(row.id); reload(); }}>
                  {row.status === 1 ? '停用' : '启用'}
                </Button>
                <Popconfirm title="被合同引用时不可删除" onConfirm={async () => { await supplierApi.remove(row.id); message.success('已删除'); reload(); }}>
                  <Button type="link" size="small" danger>删除</Button>
                </Popconfirm>
              </Space>
            ),
          },
        ]}
      />

      <Modal
        title={editing ? '编辑供应商' : '新增供应商'}
        open={modal}
        onOk={submit}
        onCancel={() => setModal(false)}
        width={720}
        destroyOnClose
      >
        <Form form={form} layout="vertical">
          <Form.Item name="name" label="供应商名称（系统内唯一）" rules={[{ required: true }]}><Input /></Form.Item>
          {FIELDS.map(([key, label]) => (
            <Form.Item key={key} name={key} label={label}>
              <Input />
            </Form.Item>
          ))}
          <Form.Item name="remark" label="备注"><Input.TextArea rows={2} /></Form.Item>
        </Form>
      </Modal>

      <Drawer title="供应商详情" width={520} open={!!detail} onClose={() => setDetail(null)}>
        <Descriptions column={1} size="small" bordered>
          <Descriptions.Item label="供应商名称">{detail?.name}</Descriptions.Item>
          {FIELDS.map(([key, label]) => (
            <Descriptions.Item key={key} label={label}>{detail?.[key] || '-'}</Descriptions.Item>
          ))}
          <Descriptions.Item label="备注">{detail?.remark || '-'}</Descriptions.Item>
        </Descriptions>
      </Drawer>
    </Card>
  );
}
