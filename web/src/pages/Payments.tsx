import { useEffect, useState } from 'react';
import {
  Card, Table, Button, Form, Input, Select, Space, Modal, Popconfirm, message, Row, Col, InputNumber,
} from 'antd';
import { PlusOutlined, ExportOutlined } from '@ant-design/icons';
import { paymentApi } from '@/api/modules';
import { contractApi } from '@/api/business';
import { useTable } from '@/hooks/useTable';
import ImportButton from '@/components/ImportButton';

const money = (v: number) =>
  v == null ? '-' : `¥${Number(v).toLocaleString('zh-CN', { maximumFractionDigits: 2 })}`;

export default function Payments() {
  const [contracts, setContracts] = useState<any[]>([]);
  useEffect(() => {
    contractApi.list({ pageSize: 1000 }).then((res: any) => setContracts(res?.list || []));
  }, []);
  const contractOptions = contracts.map((c) => ({ value: c.id, label: `${c.code} ${c.name}` }));

  return (
    <Card title="付款管理">
      <RecordTab contractOptions={contractOptions} />
    </Card>
  );
}

function RecordTab({ contractOptions }: { contractOptions: any[] }) {
  const { loading, list, pagination, search, reload } = useTable<any>((p) => paymentApi.records(p));
  const [form] = Form.useForm();
  const [modal, setModal] = useState(false);
  const [editing, setEditing] = useState<any>(null);

  const submit = async () => {
    const v = await form.validateFields();
    const payload = { ...v };
    if (editing) await paymentApi.updateRecord(editing.id, payload);
    else await paymentApi.createRecord(payload);
    message.success('保存成功');
    setModal(false);
    form.resetFields();
    setEditing(null);
    reload();
  };

  const openEdit = (row: any) => {
    setEditing(row);
    form.setFieldsValue(row);
    setModal(true);
  };

  return (
    <>
      <Form layout="inline" style={{ marginBottom: 16, rowGap: 8 }} onFinish={(v) => search(v)}>
        <Form.Item name="contractId"><Select2 options={contractOptions} placeholder="合同" /></Form.Item>
        <Form.Item name="payMonth"><Input placeholder="付款月份(YYYY-MM)" allowClear /></Form.Item>
        <Form.Item><Button type="primary" htmlType="submit">查询</Button></Form.Item>
      </Form>

      <div style={{ marginBottom: 16, textAlign: 'right' }}>
        <Space>
          <ImportButton moduleName="付款台账" templateUrl={paymentApi.recordsTemplateUrl()} uploadUrl={paymentApi.recordsImportUrl()} onDone={reload} />
          <Button icon={<ExportOutlined />} onClick={() => window.open(paymentApi.exportRecordsUrl())}>导出台账</Button>
          <Button type="primary" icon={<PlusOutlined />} onClick={() => { setEditing(null); form.resetFields(); setModal(true); }}>
            新增台账
          </Button>
        </Space>
      </div>

      <Table
        rowKey="id"
        loading={loading}
        dataSource={list}
        pagination={pagination}
        scroll={{ x: 1400 }}
        columns={[
          { title: '供应商名称', width: 220, fixed: 'left', render: (_, r) => r.contract?.supplier?.name || '-' },
          { title: '合同名称', width: 260, render: (_, r) => r.contract?.name || '-' },
          { title: '合同编号', width: 160, render: (_, r) => r.contract?.code || '-' },
          { title: '付款月份', dataIndex: 'payMonth', width: 110 },
          { title: '本月付款额', dataIndex: 'amount', width: 140, render: money },
          {
            title: '操作',
            width: 160,
            fixed: 'right',
            render: (_, row) => (
              <Space size={4}>
                <Button type="link" size="small" onClick={() => openEdit(row)}>编辑</Button>
                <Popconfirm title="确认删除该台账记录？" onConfirm={async () => { await paymentApi.removeRecord(row.id); message.success('已删除'); reload(); }}>
                  <Button type="link" size="small" danger>删除</Button>
                </Popconfirm>
              </Space>
            ),
          },
        ]}
      />

      <Modal
        title={editing ? '编辑付款台账' : '新增付款台账'}
        open={modal}
        onOk={submit}
        onCancel={() => setModal(false)}
        width={720}
        destroyOnClose
      >
        <Form form={form} layout="vertical">
          <Row gutter={16}>
            <Col xs={24} md={12}>
              <Form.Item name="contractId" label="合同" rules={[{ required: true }]}><Select2 options={contractOptions} /></Form.Item>
            </Col>
            <Col xs={24} md={12}>
              <Form.Item name="payMonth" label="付款月份(YYYY-MM)" rules={[{ required: true }]}><Input placeholder="如 2026-09" /></Form.Item>
            </Col>
            <Col xs={24} md={12}>
              <Form.Item name="amount" label="本月付款额" rules={[{ required: true }]}><InputNumber style={{ width: '100%' }} min={0} precision={2} /></Form.Item>
            </Col>
          </Row>
        </Form>
      </Modal>
    </>
  );
}

/** 合同下拉（选项已在外层准备好） */
function Select2({ value, options, placeholder, onChange }: { value?: any; options: any[]; placeholder?: string; onChange?: (id: string) => void }) {
  return (
    <Select
      value={value}
      showSearch
      optionFilterProp="label"
      allowClear
      placeholder={placeholder || '请选择合同'}
      options={options}
      onChange={onChange}
    />
  );
}
