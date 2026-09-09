import { useEffect, useState } from 'react';
import { withToken } from '../utils/download';
import {
  Card, Table, Button, Form, Input, Select, Space, Modal, Popconfirm, message, Row, Col, InputNumber, DatePicker,
} from 'antd';
import { PlusOutlined, SearchOutlined, ExportOutlined } from '@ant-design/icons';
import dayjs from 'dayjs';
import { settlementApi } from '@/api/modules';
import { contractApi } from '@/api/business';
import { useTable } from '@/hooks/useTable';
import ImportButton from '@/components/ImportButton';
import DictSelect, { DictTag } from '@/components/DictSelect';

const money = (v: number) =>
  v == null ? '-' : `¥${Number(v).toLocaleString('zh-CN', { maximumFractionDigits: 2 })}`;

/** 加载合同下拉选项（结算单/结算台账共用） */
function useContractOptions() {
  const [contracts, setContracts] = useState<any[]>([]);
  useEffect(() => {
    contractApi.list({ pageSize: 1000 }).then((res: any) => setContracts(res?.list || []));
  }, []);
  const contractOptions = contracts.map((c) => ({ value: c.id, label: `${c.code} ${c.name}` }));
  return { contracts, contractOptions };
}

/**
 * 结算单页面（需求 2.2 修正：/settlement/order 直接展示结算单列表，无 Tab 切换）
 */
export function SettlementOrderPage() {
  const { contracts, contractOptions } = useContractOptions();
  return (
    <Card title="结算单">
      <SettlementsTab contracts={contracts} contractOptions={contractOptions} />
    </Card>
  );
}

/**
 * 结算台账页面（需求 2.2 修正：/settlement/ledger 直接展示结算台账列表，无 Tab 切换）
 */
export function SettlementLedgerPage() {
  const { contracts, contractOptions } = useContractOptions();
  return (
    <Card title="结算台账">
      <LedgerTab contracts={contracts} contractOptions={contractOptions} />
    </Card>
  );
}

/** 默认导出兼容旧路由 /settlements：展示结算单页面 */
export default function Settlements() {
  return <SettlementOrderPage />;
}

function SettlementsTab({ contracts, contractOptions }: { contracts: any[]; contractOptions: any[] }) {
  const { loading, list, pagination, search, reload } = useTable<any>((p) => settlementApi.list(p));
  const [form] = Form.useForm();
  const [modal, setModal] = useState(false);
  const [editing, setEditing] = useState<any>(null);

  const submit = async () => {
    const v = await form.validateFields();
    const payload = { ...v, settleDate: v.settleDate ? dayjs(v.settleDate).format('YYYY-MM-DD') : null };
    if (editing) await settlementApi.update(editing.id, payload);
    else await settlementApi.create(payload);
    message.success('保存成功');
    setModal(false);
    form.resetFields();
    setEditing(null);
    reload();
  };

  const openEdit = (row: any) => {
    setEditing(row);
    form.setFieldsValue({ ...row, settleDate: row.settleDate ? dayjs(row.settleDate) : null });
    setModal(true);
  };

  return (
    <>
      <Form layout="inline" style={{ marginBottom: 16, rowGap: 8 }} onFinish={(v) => search(v)}>
        <Form.Item name="contractId"><Select2 options={contractOptions} placeholder="合同" /></Form.Item>
        <Form.Item name="typeCode"><DictSelect typeCode="settlement_type" placeholder="结算类型" /></Form.Item>
        <Form.Item name="status"><DictSelect typeCode="settlement_status" placeholder="结算状态" /></Form.Item>
        <Form.Item name="keyword"><Input placeholder="关键词" allowClear prefix={<SearchOutlined />} /></Form.Item>
        <Form.Item><Button type="primary" htmlType="submit">查询</Button></Form.Item>
      </Form>

      <div style={{ marginBottom: 16, textAlign: 'right' }}>
        <Button
          type="primary"
          icon={<PlusOutlined />}
          onClick={() => { setEditing(null); form.resetFields(); setModal(true); }}
        >
          新增结算单
        </Button>
      </div>

      <Table
        rowKey="id"
        loading={loading}
        dataSource={list}
        pagination={pagination}
        scroll={{ x: 1800 }}
        columns={[
          { title: '结算单编号', dataIndex: 'code', width: 160, fixed: 'left' },
          { title: '合同', width: 260, render: (_, r) => `${r.contract?.code || ''} ${r.contract?.name || ''}`.trim() || '-' },
          { title: '供应商', width: 220, render: (_, r) => r.contract?.supplier?.name || '-' },
          { title: '结算类型', dataIndex: 'typeCode', width: 110, render: (v) => <DictTag typeCode="settlement_type" value={v} /> },
          { title: '结算金额', dataIndex: 'amount', width: 140, render: money },
          { title: '扣款金额', dataIndex: 'deductAmount', width: 140, render: money },
          { title: '实际结算金额', dataIndex: 'actualAmount', width: 150, render: money },
          { title: '结算日期', dataIndex: 'settleDate', width: 120, render: (v) => v?.slice(0, 10) },
          { title: '结算状态', dataIndex: 'statusCode', width: 110, render: (v) => <DictTag typeCode="settlement_status" value={v} /> },
          { title: '备注', dataIndex: 'remark', width: 160 },
          {
            title: '操作',
            width: 160,
            fixed: 'right',
            render: (_, row) => (
              <Space size={4}>
                <Button type="link" size="small" onClick={() => openEdit(row)}>编辑</Button>
                <Popconfirm title="确认删除该结算单？" onConfirm={async () => { await settlementApi.remove(row.id); message.success('已删除'); reload(); }}>
                  <Button type="link" size="small" danger>删除</Button>
                </Popconfirm>
              </Space>
            ),
          },
        ]}
      />

      <Modal
        title={editing ? '编辑结算单' : '新增结算单'}
        open={modal}
        onOk={submit}
        onCancel={() => setModal(false)}
        width={860}
        destroyOnClose
      >
        <Form form={form} layout="vertical">
          <Row gutter={16}>
            <Col xs={24} md={12}>
              <Form.Item name="code" label="结算单编号" rules={[{ required: true }]}><Input /></Form.Item>
            </Col>
            <Col xs={24} md={12}>
              <Form.Item name="contractId" label="合同" rules={[{ required: true }]}>
                <Select2 options={contractOptions} />
              </Form.Item>
            </Col>
            <Col xs={24} md={8}>
              <Form.Item name="typeCode" label="结算类型" rules={[{ required: true }]}><DictSelect typeCode="settlement_type" /></Form.Item>
            </Col>
            <Col xs={24} md={8}>
              <Form.Item name="amount" label="结算金额"><InputNumber style={{ width: '100%' }} min={0} precision={2} /></Form.Item>
            </Col>
            <Col xs={24} md={8}>
              <Form.Item name="deductAmount" label="扣款金额"><InputNumber style={{ width: '100%' }} min={0} precision={2} /></Form.Item>
            </Col>
            <Col xs={24} md={8}>
              <Form.Item name="actualAmount" label="实际结算金额"><InputNumber style={{ width: '100%' }} min={0} precision={2} /></Form.Item>
            </Col>
            <Col xs={24} md={8}>
              <Form.Item name="settleDate" label="结算日期"><DatePicker style={{ width: '100%' }} /></Form.Item>
            </Col>
            <Col xs={24} md={8}>
              <Form.Item name="statusCode" label="结算状态"><DictSelect typeCode="settlement_status" /></Form.Item>
            </Col>
            <Col xs={24}>
              <Form.Item name="remark" label="备注"><Input.TextArea rows={2} /></Form.Item>
            </Col>
          </Row>
        </Form>
      </Modal>
    </>
  );
}

function LedgerTab({ contracts, contractOptions }: { contracts: any[]; contractOptions: any[] }) {
  const { loading, list, pagination, search, reload } = useTable<any>((p) => settlementApi.ledger(p));
  const [form] = Form.useForm();
  const [modal, setModal] = useState(false);
  const [editing, setEditing] = useState<any>(null);
  const [refreshing, setRefreshing] = useState(false);

  const doRefresh = async () => {
    setRefreshing(true);
    try {
      const res: any = await settlementApi.refreshLedger();
      message.success(`自动生成完成：新增 ${res?.created ?? 0} 条，更新 ${res?.updated ?? 0} 条`);
      reload();
    } finally {
      setRefreshing(false);
    }
  };

  const submit = async () => {
    const v = await form.validateFields();
    const payload = { ...v };
    if (editing) await settlementApi.updateLedger(editing.id, payload);
    else await settlementApi.createLedger(payload);
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
        <Form.Item name="settleMonth"><Input placeholder="结算月份(YYYY-MM)" allowClear /></Form.Item>
        <Form.Item name="isOnAccount"><DictSelect typeCode="yes_no" placeholder="是否挂账" /></Form.Item>
        <Form.Item><Button type="primary" htmlType="submit">查询</Button></Form.Item>
      </Form>

      <div style={{ marginBottom: 16, textAlign: 'right' }}>
        <Space>
          <Button type="primary" ghost loading={refreshing} onClick={doRefresh}>自动生成台账</Button>
          <ImportButton moduleName="结算台账" templateUrl={settlementApi.ledgerTemplateUrl()} uploadUrl={settlementApi.ledgerImportUrl()} onDone={reload} />
          <Button icon={<ExportOutlined />} onClick={() => window.open(withToken(settlementApi.exportLedgerUrl()))}>导出台账</Button>
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
        scroll={{ x: 2600 }}
        columns={[
          { title: '供应商名称', width: 220, fixed: 'left', render: (_, r) => r.contract?.supplier?.name || '-' },
          { title: '合同名称', width: 260, render: (_, r) => r.contract?.name || '-' },
          { title: '合同编号', width: 160, render: (_, r) => r.contract?.code || '-' },
          { title: '结算月份', dataIndex: 'settleMonth', width: 110 },
          { title: '本月结算额', dataIndex: 'monthSettleAmount', width: 130, render: money },
          { title: '本月开票额', dataIndex: 'monthInvoiceAmount', width: 130, render: money },
          { title: '结算次数', dataIndex: 'settleCount', width: 100 },
          { title: '本年结算额', dataIndex: 'yearSettleAmount', width: 130, render: money },
          { title: '截止当月开累采购额', dataIndex: 'cumPurchaseAmount', width: 160, render: money },
          { title: '开工结算额', dataIndex: 'startSettleAmount', width: 130, render: money },
          { title: '当月实际采购额', dataIndex: 'monthActualPurchase', width: 140, render: money },
          { title: '保理贴息', dataIndex: 'factoringDiscount', width: 120, render: money },
          { title: '逾期利息', dataIndex: 'overdueInterest', width: 120, render: money },
          { title: '本年结算对应收入', dataIndex: 'yearSettleIncome', width: 150, render: money },
          { title: '开累结算对应收入', dataIndex: 'cumSettleIncome', width: 160, render: money },
          { title: '是否挂账', dataIndex: 'isOnAccount', width: 100, render: (v) => <DictTag typeCode="yes_no" value={v} /> },
          {
            title: '操作',
            width: 160,
            fixed: 'right',
            render: (_, row) => (
              <Space size={4}>
                <Button type="link" size="small" onClick={() => openEdit(row)}>编辑</Button>
                <Popconfirm title="确认删除该台账记录？" onConfirm={async () => { await settlementApi.removeLedger(row.id); message.success('已删除'); reload(); }}>
                  <Button type="link" size="small" danger>删除</Button>
                </Popconfirm>
              </Space>
            ),
          },
        ]}
      />

      <Modal
        title={editing ? '编辑结算台账' : '新增结算台账'}
        open={modal}
        onOk={submit}
        onCancel={() => setModal(false)}
        width={960}
        destroyOnClose
      >
        <Form form={form} layout="vertical">
          <Row gutter={16}>
            <Col xs={24} md={12}>
              <Form.Item name="contractId" label="合同" rules={[{ required: true }]}>
                <Select2 options={contractOptions} />
              </Form.Item>
            </Col>
            <Col xs={24} md={12}>
              <Form.Item name="settleMonth" label="结算月份(YYYY-MM)" rules={[{ required: true }]}><Input placeholder="如 2026-09" /></Form.Item>
            </Col>
            <Col xs={24} md={8}><Form.Item name="monthSettleAmount" label="本月结算额（自动抓取结算单）"><InputNumber style={{ width: '100%' }} min={0} precision={2} disabled /></Form.Item></Col>
            <Col xs={24} md={8}><Form.Item name="monthInvoiceAmount" label="本月开票额（自动抓取收票登记）"><InputNumber style={{ width: '100%' }} min={0} precision={2} disabled /></Form.Item></Col>
            <Col xs={24} md={8}><Form.Item name="settleCount" label="结算次数（自动统计）"><InputNumber style={{ width: '100%' }} min={0} precision={0} disabled /></Form.Item></Col>
            <Col xs={24} md={8}><Form.Item name="yearSettleAmount" label="本年结算额"><InputNumber style={{ width: '100%' }} min={0} precision={2} /></Form.Item></Col>
            <Col xs={24} md={8}><Form.Item name="cumPurchaseAmount" label="截止当月开累采购额"><InputNumber style={{ width: '100%' }} min={0} precision={2} /></Form.Item></Col>
            <Col xs={24} md={8}><Form.Item name="startSettleAmount" label="开工结算额"><InputNumber style={{ width: '100%' }} min={0} precision={2} /></Form.Item></Col>
            <Col xs={24} md={8}><Form.Item name="monthActualPurchase" label="当月实际采购额"><InputNumber style={{ width: '100%' }} min={0} precision={2} /></Form.Item></Col>
            <Col xs={24} md={8}><Form.Item name="factoringDiscount" label="保理贴息（自动抓取资金费用）"><InputNumber style={{ width: '100%' }} min={0} precision={2} disabled /></Form.Item></Col>
            <Col xs={24} md={8}><Form.Item name="overdueInterest" label="逾期利息（自动抓取资金费用）"><InputNumber style={{ width: '100%' }} min={0} precision={2} disabled /></Form.Item></Col>
            <Col xs={24} md={8}><Form.Item name="yearSettleIncome" label="本年结算对应收入"><InputNumber style={{ width: '100%' }} min={0} precision={2} /></Form.Item></Col>
            <Col xs={24} md={8}><Form.Item name="cumSettleIncome" label="开累结算对应收入"><InputNumber style={{ width: '100%' }} min={0} precision={2} /></Form.Item></Col>
            <Col xs={24} md={8}><Form.Item name="isOnAccount" label="是否挂账"><DictSelect typeCode="yes_no" /></Form.Item></Col>
          </Row>
        </Form>
      </Modal>
    </>
  );
}

/** 合同下拉（选项已在外层准备好） */
function Select2({ value, options, placeholder }: { value?: any; options: any[]; placeholder?: string }) {
  return (
    <Select
      value={value}
      showSearch
      optionFilterProp="label"
      allowClear
      placeholder={placeholder || '请选择合同'}
      options={options}
    />
  );
}
