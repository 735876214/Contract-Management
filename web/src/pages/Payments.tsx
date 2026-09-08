import { useEffect, useState } from 'react';
import {
  Card, Table, Button, Form, Input, Select, Space, Modal, Popconfirm, message, Tabs, Row, Col, InputNumber, DatePicker,
} from 'antd';
import { PlusOutlined, SearchOutlined, ExportOutlined } from '@ant-design/icons';
import dayjs from 'dayjs';
import { paymentApi } from '@/api/modules';
import { contractApi } from '@/api/business';
import { useTable } from '@/hooks/useTable';
import DictSelect, { DictTag } from '@/components/DictSelect';

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
      <Tabs
        items={[
          { key: 'plan', label: '付款计划', children: <PlanTab contracts={contracts} contractOptions={contractOptions} /> },
          { key: 'apply', label: '付款申请', children: <ApplyTab contractOptions={contractOptions} /> },
          { key: 'record', label: '付款台账', children: <RecordTab contractOptions={contractOptions} /> },
          { key: 'verify', label: '核销管理', children: <VerificationTab /> },
          { key: 'overdue', label: '逾期提醒', children: <OverdueTab /> },
        ]}
      />
    </Card>
  );
}

function PlanTab({ contracts, contractOptions }: { contracts: any[]; contractOptions: any[] }) {
  const { loading, list, pagination, search, reload } = useTable<any>((p) => paymentApi.plans(p));
  const [form] = Form.useForm();
  const [modal, setModal] = useState(false);
  const [editing, setEditing] = useState<any>(null);
  const [genOpen, setGenOpen] = useState(false);
  const [genForm] = Form.useForm();

  const submit = async () => {
    const v = await form.validateFields();
    const payload = { ...v, planDate: v.planDate ? dayjs(v.planDate).format('YYYY-MM-DD') : null };
    if (editing) await paymentApi.updatePlan(editing.id, payload);
    else await paymentApi.createPlan(payload);
    message.success('保存成功');
    setModal(false);
    form.resetFields();
    setEditing(null);
    reload();
  };

  const openEdit = (row: any) => {
    setEditing(row);
    form.setFieldsValue({ ...row, planDate: row.planDate ? dayjs(row.planDate) : null });
    setModal(true);
  };

  const doGenerate = async () => {
    const v = await genForm.validateFields();
    await paymentApi.generatePlans({ contractId: v.contractId });
    message.success('已按合同生成付款计划');
    setGenOpen(false);
    genForm.resetFields();
    reload();
  };

  return (
    <>
      <Form layout="inline" style={{ marginBottom: 16, rowGap: 8 }} onFinish={(v) => search(v)}>
        <Form.Item name="contractId"><Select2 options={contractOptions} placeholder="合同" /></Form.Item>
        <Form.Item name="status"><DictSelect typeCode="payment_plan_status" placeholder="状态" /></Form.Item>
        <Form.Item><Button type="primary" htmlType="submit">查询</Button></Form.Item>
      </Form>

      <div style={{ marginBottom: 16, textAlign: 'right' }}>
        <Space>
          <Button onClick={() => { genForm.resetFields(); setGenOpen(true); }}>按合同生成计划</Button>
          <Button type="primary" icon={<PlusOutlined />} onClick={() => { setEditing(null); form.resetFields(); setModal(true); }}>
            新增计划
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
          { title: '合同', width: 260, render: (_, r) => `${r.contract?.code || ''} ${r.contract?.name || ''}`.trim() || '-' },
          { title: '期次', dataIndex: 'period', width: 100 },
          { title: '计划金额', dataIndex: 'planAmount', width: 140, render: money },
          { title: '计划付款日期', dataIndex: 'planDate', width: 130, render: (v) => v?.slice(0, 10) },
          { title: '付款条件', dataIndex: 'condition', width: 200 },
          { title: '状态', dataIndex: 'statusCode', width: 120, render: (v) => <DictTag typeCode="payment_plan_status" value={v} /> },
          {
            title: '操作',
            width: 160,
            fixed: 'right',
            render: (_, row) => (
              <Space size={4}>
                <Button type="link" size="small" onClick={() => openEdit(row)}>编辑</Button>
                <Popconfirm title="确认删除该计划？" onConfirm={async () => { await paymentApi.removePlan(row.id); message.success('已删除'); reload(); }}>
                  <Button type="link" size="small" danger>删除</Button>
                </Popconfirm>
              </Space>
            ),
          },
        ]}
      />

      <Modal
        title={editing ? '编辑付款计划' : '新增付款计划'}
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
              <Form.Item name="period" label="期次" rules={[{ required: true }]}><Input /></Form.Item>
            </Col>
            <Col xs={24} md={12}>
              <Form.Item name="planAmount" label="计划金额" rules={[{ required: true }]}><InputNumber style={{ width: '100%' }} min={0} precision={2} /></Form.Item>
            </Col>
            <Col xs={24} md={12}>
              <Form.Item name="planDate" label="计划付款日期"><DatePicker style={{ width: '100%' }} /></Form.Item>
            </Col>
            <Col xs={24}>
              <Form.Item name="condition" label="付款条件"><Input.TextArea rows={2} /></Form.Item>
            </Col>
            <Col xs={24} md={12}>
              <Form.Item name="statusCode" label="状态"><DictSelect typeCode="payment_plan_status" /></Form.Item>
            </Col>
          </Row>
        </Form>
      </Modal>

      <Modal title="按合同生成付款计划" open={genOpen} onOk={doGenerate} onCancel={() => setGenOpen(false)} destroyOnClose>
        <Form form={genForm} layout="vertical">
          <Form.Item name="contractId" label="选择合同" rules={[{ required: true, message: '请选择合同' }]}>
            <Select2 options={contractOptions} />
          </Form.Item>
        </Form>
      </Modal>
    </>
  );
}

function ApplyTab({ contractOptions }: { contractOptions: any[] }) {
  const { loading, list, pagination, search, reload } = useTable<any>((p) => paymentApi.applies(p));
  const [form] = Form.useForm();
  const [modal, setModal] = useState(false);
  const [editing, setEditing] = useState<any>(null);

  const submit = async () => {
    const v = await form.validateFields();
    const payload = { ...v, payDate: v.payDate ? dayjs(v.payDate).format('YYYY-MM-DD') : null };
    if (editing) await paymentApi.updateApply(editing.id, payload);
    else await paymentApi.createApply(payload);
    message.success('保存成功');
    setModal(false);
    form.resetFields();
    setEditing(null);
    reload();
  };

  const openEdit = (row: any) => {
    setEditing(row);
    form.setFieldsValue({ ...row, payDate: row.payDate ? dayjs(row.payDate) : null });
    setModal(true);
  };

  // 选择合同后自动带出收款方/开户行/银行账号
  const onContractChange = async (id: string) => {
    if (!id) return;
    const res: any = await contractApi.detail(id);
    const sup = res?.supplier || {};
    form.setFieldsValue({ payee: sup.name, bankName: sup.bankName, bankAccount: sup.bankAccount });
  };

  return (
    <>
      <Form layout="inline" style={{ marginBottom: 16, rowGap: 8 }} onFinish={(v) => search(v)}>
        <Form.Item name="contractId"><Select2 options={contractOptions} placeholder="合同" /></Form.Item>
        <Form.Item name="status"><DictSelect typeCode="approval_status" placeholder="状态" /></Form.Item>
        <Form.Item><Button type="primary" htmlType="submit">查询</Button></Form.Item>
      </Form>

      <div style={{ marginBottom: 16, textAlign: 'right' }}>
        <Button type="primary" icon={<PlusOutlined />} onClick={() => { setEditing(null); form.resetFields(); setModal(true); }}>
          新增申请
        </Button>
      </div>

      <Table
        rowKey="id"
        loading={loading}
        dataSource={list}
        pagination={pagination}
        scroll={{ x: 1900 }}
        columns={[
          { title: '申请编号', dataIndex: 'code', width: 160, fixed: 'left' },
          { title: '合同', width: 260, render: (_, r) => r.contract?.code || '-' },
          { title: '收款方', dataIndex: 'payee', width: 180 },
          { title: '银行名称', dataIndex: 'bankName', width: 200 },
          { title: '银行账号', dataIndex: 'bankAccount', width: 200 },
          { title: '申请金额', dataIndex: 'applyAmount', width: 140, render: money },
          { title: '付款日期', dataIndex: 'payDate', width: 120, render: (v) => v?.slice(0, 10) },
          { title: '付款方式', dataIndex: 'methodCode', width: 110, render: (v) => <DictTag typeCode="payment_method" value={v} /> },
          { title: '状态', dataIndex: 'statusCode', width: 110, render: (v) => <DictTag typeCode="approval_status" value={v} /> },
          { title: '备注', dataIndex: 'remark', width: 160 },
          {
            title: '操作',
            width: 140,
            fixed: 'right',
            render: (_, row) => (
              <Space size={4}>
                <Button type="link" size="small" onClick={() => openEdit(row)}>编辑</Button>
                <Popconfirm title="确认删除？" onConfirm={async () => { await paymentApi.removeApply(row.id); message.success('已删除'); reload(); }}>
                  <Button type="link" size="small" danger>删除</Button>
                </Popconfirm>
              </Space>
            ),
          },
        ]}
      />

      <Modal
        title={editing ? '编辑付款申请' : '新增付款申请'}
        open={modal}
        onOk={submit}
        onCancel={() => setModal(false)}
        width={860}
        destroyOnClose
      >
        <Form form={form} layout="vertical">
          <Row gutter={16}>
            <Col xs={24} md={12}>
              <Form.Item name="code" label="申请编号" rules={[{ required: true }]}><Input /></Form.Item>
            </Col>
            <Col xs={24} md={12}>
              <Form.Item name="contractId" label="合同" rules={[{ required: true }]}>
                <Select2 options={contractOptions} onChange={onContractChange} />
              </Form.Item>
            </Col>
            <Col xs={24} md={12}><Form.Item name="payee" label="收款方"><Input /></Form.Item></Col>
            <Col xs={24} md={12}><Form.Item name="bankName" label="银行名称"><Input /></Form.Item></Col>
            <Col xs={24} md={12}><Form.Item name="bankAccount" label="银行账号"><Input /></Form.Item></Col>
            <Col xs={24} md={12}>
              <Form.Item name="applyAmount" label="申请金额" rules={[{ required: true }]}><InputNumber style={{ width: '100%' }} min={0} precision={2} /></Form.Item>
            </Col>
            <Col xs={24} md={12}><Form.Item name="payDate" label="付款日期"><DatePicker style={{ width: '100%' }} /></Form.Item></Col>
            <Col xs={24} md={12}><Form.Item name="methodCode" label="付款方式"><DictSelect typeCode="payment_method" /></Form.Item></Col>
            <Col xs={24}>
              <Form.Item name="remark" label="备注"><Input.TextArea rows={2} /></Form.Item>
            </Col>
          </Row>
        </Form>
      </Modal>
    </>
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

function VerificationTab() {
  const [loading, setLoading] = useState(false);
  const [data, setData] = useState<any[]>([]);
  useEffect(() => {
    setLoading(true);
    paymentApi.verifications().then((res: any) => setData(Array.isArray(res) ? res : res?.list || [])).finally(() => setLoading(false));
  }, []);
  return (
    <Table
      rowKey="id"
      loading={loading}
      dataSource={data}
      pagination={{ pageSize: 20 }}
      scroll={{ x: 1300 }}
      columns={[
        { title: '合同编号', width: 160, render: (_, r) => r.contract?.code || '-' },
        { title: '合同名称', width: 240, render: (_, r) => r.contract?.name || '-' },
        { title: '供应商', width: 200, render: (_, r) => r.contract?.supplier?.name || '-' },
        { title: '结算金额', width: 140, render: money },
        { title: '发票金额', width: 140, render: money },
        { title: '已付金额', width: 140, render: money },
        { title: '结算未核销', dataIndex: 'unpaidSettlement', width: 140, render: money },
        { title: '发票未核销', dataIndex: 'unpaidInvoice', width: 140, render: money },
      ]}
    />
  );
}

function OverdueTab() {
  const [loading, setLoading] = useState(false);
  const [data, setData] = useState<any[]>([]);
  useEffect(() => {
    setLoading(true);
    paymentApi.overdue().then((res: any) => setData(Array.isArray(res) ? res : res?.list || [])).finally(() => setLoading(false));
  }, []);
  return (
    <Table
      rowKey="id"
      loading={loading}
      dataSource={data}
      pagination={{ pageSize: 20 }}
      scroll={{ x: 1200 }}
      columns={[
        { title: '合同编号', width: 160, render: (_, r) => r.contract?.code || '-' },
        { title: '合同名称', width: 240, render: (_, r) => r.contract?.name || '-' },
        { title: '供应商', width: 200, render: (_, r) => r.contract?.supplier?.name || '-' },
        { title: '期次', dataIndex: 'period', width: 100 },
        { title: '计划金额', dataIndex: 'planAmount', width: 140, render: money },
        { title: '计划日期', dataIndex: 'planDate', width: 130, render: (v) => v?.slice(0, 10) },
        { title: '逾期天数', dataIndex: 'overdueDays', width: 100, render: (v) => <span style={{ color: '#cf1322', fontWeight: 600 }}>{v}</span> },
        { title: '状态', dataIndex: 'statusCode', width: 110, render: (v) => <DictTag typeCode="payment_plan_status" value={v} /> },
      ]}
    />
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
