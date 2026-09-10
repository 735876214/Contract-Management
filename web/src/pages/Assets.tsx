import { useEffect, useMemo, useState } from 'react';
import { withToken } from '../utils/download';
import {
  Card, Table, Button, Form, Input, Select, Space, Modal, Popconfirm, message, Row, Col, InputNumber, DatePicker, Alert,
} from 'antd';
import { PlusOutlined, SearchOutlined, ExportOutlined } from '@ant-design/icons';
import dayjs from 'dayjs';
import { assetApi } from '@/api/modules';
import { supplierApi } from '@/api/business';
import { dictApi } from '@/api/dict';
import { useTable } from '@/hooks/useTable';
import DictSelect, { DictTag } from '@/components/DictSelect';
import ImportButton from '@/components/ImportButton';

const money = (v: any) =>
  v == null ? '-' : Number(v).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const qty = (v: any) => (v == null ? '-' : Number(v).toLocaleString('zh-CN', { maximumFractionDigits: 2 }));

/** 调入费/维保费行只填金额，不填数量 */
const isFeeSource = (code?: string) => code === 'TRANSFER_IN_FEE' || code === 'MAINTENANCE';

const STATUS_QTY_KEYS: [string, string][] = [
  ['inUseQty', '在用'],
  ['idleQty', '闲置'],
  ['scrapQty', '报废'],
  ['lostQty', '丢失'],
];

export default function Assets() {
  const { loading, list, pagination, search, reload } = useTable<any>((p) => assetApi.list(p));
  const [form] = Form.useForm();
  const [modal, setModal] = useState(false);
  const [editing, setEditing] = useState<any>(null);
  const [submitting, setSubmitting] = useState(false);
  const [suppliers, setSuppliers] = useState<any[]>([]);
  const [units, setUnits] = useState<any[]>([]);

  useEffect(() => {
    supplierApi.options().then((res: any) => setSuppliers(res || []));
    dictApi.options('measurement_unit').then((res: any) => setUnits(res || []));
  }, []);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const columns: any[] = [
    { title: '序号', width: 70, fixed: 'left', render: (_: any, __: any, i: number) => (pagination.current - 1) * pagination.pageSize + i + 1 },
    { title: '日期', dataIndex: 'date', width: 110, fixed: 'left', render: (v: any) => v?.slice(0, 10) },
    { title: '来源', dataIndex: 'sourceCode', width: 110, fixed: 'left', render: (v: any) => <DictTag typeCode="asset_ledger_source" value={v} /> },
    { title: '资产类别（一级）', dataIndex: 'categoryL1Code', width: 140, render: (v: any) => <DictTag typeCode="asset_category_l1" value={v} /> },
    { title: '资产类别（重点关注）', dataIndex: 'categoryFocusCode', width: 160, render: (v: any) => <DictTag typeCode="asset_category_focus" value={v} /> },
    { title: '资产名称', dataIndex: 'name', width: 140 },
    { title: '规格型号', dataIndex: 'spec', width: 150 },
    { title: '单位', dataIndex: 'unit', width: 70, render: (v: any) => units.find((u) => u.value === v)?.label || v || '-' },
    { title: '进/出场数量', dataIndex: 'qty', width: 110, align: 'right' as const, render: qty },
    { title: '进/出场单价', dataIndex: 'price', width: 110, align: 'right' as const, render: money },
    { title: '进/出场总额（现值）', dataIndex: 'totalAmount', width: 160, align: 'right' as const, render: money },
    { title: '供应单位', dataIndex: 'supplierId', width: 160, render: (v: any) => suppliers.find((s) => s.id === v)?.name || '-' },
    { title: '领用单位/部门', dataIndex: 'receiveUnit', width: 140 },
    { title: '责任人', dataIndex: 'responsible', width: 90 },
    ...STATUS_QTY_KEYS.flatMap(([k, label]) => [
      { title: label, dataIndex: k, width: 80, align: 'right' as const, render: qty },
      { title: `${label}金额`, dataIndex: `${k.slice(0, -3)}Amount`, width: 110, align: 'right' as const, render: money },
    ]),
    { title: '备注', dataIndex: 'remark', width: 150 },
    { title: '周转次数', dataIndex: 'turnoverCount', width: 90, align: 'right' as const, render: qty },
    { title: '原值单价', dataIndex: 'originalPrice', width: 100, align: 'right' as const, render: money },
    { title: '原值总额', dataIndex: 'originalTotal', width: 110, align: 'right' as const, render: money },
    { title: '调出进场单价', dataIndex: 'transferOutPrice', width: 130, align: 'right' as const, render: money },
    { title: '调出进场金额', dataIndex: 'transferOutAmount', width: 130, align: 'right' as const, render: money },
    {
      title: '操作',
      width: 130,
      fixed: 'right' as const,
      render: (_: any, row: any) => (
        <Space size={4}>
          <Button type="link" size="small" onClick={() => openEdit(row)}>编辑</Button>
          <Popconfirm title="确认删除？" onConfirm={async () => { await assetApi.remove(row.id); message.success('已删除'); reload(); }}>
            <Button type="link" size="small" danger>删除</Button>
          </Popconfirm>
        </Space>
      ),
    },
  ];

  const submit = async () => {
    const v = await form.validateFields();
    setSubmitting(true);
    try {
      const payload = {
        ...v,
        date: v.date ? dayjs(v.date).format('YYYY-MM-DD') : null,
      };
      if (editing) await assetApi.update(editing.id, payload);
      else await assetApi.create(payload);
      message.success('保存成功');
      setModal(false);
      setEditing(null);
      form.resetFields();
      reload();
    } finally {
      setSubmitting(false);
    }
  };

  const openEdit = (row: any) => {
    setEditing(row);
    form.setFieldsValue({
      ...row,
      date: row.date ? dayjs(row.date) : null,
    });
    setModal(true);
  };

  const openCreate = () => {
    setEditing(null);
    form.resetFields();
    form.setFieldsValue({ date: dayjs() });
    setModal(true);
  };

  return (
    <Card title="资产管理台账">
      <Alert
        type="info"
        showIcon
        style={{ marginBottom: 16 }}
        message="进/出场总额 = 数量 × 单价 自动计算；在用/闲置/报废/丢失数量之和应等于进/出场数量；「调入费/维保费」行只填单价（金额），不填数量。"
      />
      <Form layout="inline" style={{ marginBottom: 16, rowGap: 8 }} onFinish={(v) => search(v)}>
        <Form.Item name="keyword"><Input placeholder="名称/规格/领用单位" allowClear /></Form.Item>
        <Form.Item name="sourceCode"><DictSelect typeCode="asset_ledger_source" placeholder="来源" /></Form.Item>
        <Form.Item name="categoryL1Code"><DictSelect typeCode="asset_category_l1" placeholder="资产类别（一级）" /></Form.Item>
        <Form.Item name="categoryFocusCode"><DictSelect typeCode="asset_category_focus" placeholder="重点关注类别" /></Form.Item>
        <Form.Item><Button type="primary" htmlType="submit" icon={<SearchOutlined />}>查询</Button></Form.Item>
      </Form>

      <div style={{ marginBottom: 16, textAlign: 'right' }}>
        <Space>
          <ImportButton moduleName="资产管理台账" templateUrl={assetApi.templateUrl()} onUpload={(f) => assetApi.import(f)} onDone={reload} />
          <Button icon={<ExportOutlined />} onClick={() => window.open(withToken(assetApi.exportUrl()))}>导出</Button>
          <Button type="primary" icon={<PlusOutlined />} onClick={openCreate}>新增台账</Button>
        </Space>
      </div>

      <Table
        rowKey="id"
        loading={loading}
        dataSource={list}
        pagination={pagination}
        scroll={{ x: 2600 }}
        columns={columns}
      />

      <Modal
        title={editing ? '编辑资产台账' : '新增资产台账'}
        open={modal}
        onOk={submit}
        confirmLoading={submitting}
        onCancel={() => setModal(false)}
        width={1040}
        destroyOnClose
      >
        <AssetForm form={form} suppliers={suppliers} units={units} />
      </Modal>
    </Card>
  );
}

function AssetForm({ form, suppliers, units }: { form: any; suppliers: any[]; units: any[] }) {
  const sourceCode = Form.useWatch('sourceCode', form);
  const feeMode = isFeeSource(sourceCode);
  // 数量/单价联动展示各项金额
  const qtyV = Form.useWatch('qty', form);
  const priceV = Form.useWatch('price', form);
  const [statusQty, setStatusQty] = useState<Record<string, number>>({});
  const derived = useMemo(() => {
    const q = Number(qtyV);
    const p = Number(priceV);
    const total = qtyV != null && priceV != null ? q * p : null;
    const statusTotal = Object.values(statusQty).reduce((s, n) => s + (Number(n) || 0), 0);
    return {
      total: total != null ? total.toFixed(2) : null,
      mismatch: statusTotal > 0 && q > 0 && Math.abs(statusTotal - q) > 0.0001 ? statusTotal : null,
    };
  }, [qtyV, priceV, statusQty]);

  const qtyRules = feeMode ? [] : [{ required: true, message: '请填写数量' }];

  return (
    <Form form={form} layout="vertical">
      <Row gutter={16}>
        <Col xs={24} md={6}>
          <Form.Item name="date" label="日期" rules={[{ required: true }]}><DatePicker format="YYYY-MM-DD" style={{ width: '100%' }} /></Form.Item>
        </Col>
        <Col xs={24} md={6}>
          <Form.Item name="sourceCode" label="来源" rules={[{ required: true }]}><DictSelect typeCode="asset_ledger_source" /></Form.Item>
        </Col>
        <Col xs={24} md={6}>
          <Form.Item name="categoryL1Code" label="资产类别（一级）" rules={[{ required: true }]}><DictSelect typeCode="asset_category_l1" /></Form.Item>
        </Col>
        <Col xs={24} md={6}>
          <Form.Item name="categoryFocusCode" label="资产类别（重点关注）"><DictSelect typeCode="asset_category_focus" /></Form.Item>
        </Col>
        <Col xs={24} md={6}>
          <Form.Item name="name" label="资产名称" rules={[{ required: true }]}><Input /></Form.Item>
        </Col>
        <Col xs={24} md={6}>
          <Form.Item name="spec" label="规格型号"><Input /></Form.Item>
        </Col>
        <Col xs={24} md={6}>
          <Form.Item name="unit" label="单位">
            <Select showSearch optionFilterProp="label" allowClear placeholder="计量单位" options={units.map((u) => ({ value: u.value, label: u.label }))} />
          </Form.Item>
        </Col>
        <Col xs={24} md={6}>
          <Form.Item name="qty" label={feeMode ? '数量（该来源无需填写）' : '进/出场数量'} rules={qtyRules}>
            <InputNumber style={{ width: '100%' }} min={0} precision={2} disabled={feeMode} />
          </Form.Item>
        </Col>
        <Col xs={24} md={6}>
          <Form.Item name="price" label={feeMode ? '金额' : '进/出场单价'} rules={[{ required: true, message: '请填写金额' }]}>
            <InputNumber style={{ width: '100%' }} min={0} precision={2} />
          </Form.Item>
        </Col>
        <Col xs={24} md={6}>
          <Form.Item label="进/出场总额（自动）">
            <Input value={derived.total != null ? `¥${derived.total}` : ''} disabled placeholder="数量 × 单价" />
          </Form.Item>
        </Col>
        <Col xs={24} md={12}>
          <Form.Item name="supplierId" label="供应单位">
            <Select showSearch optionFilterProp="label" allowClear placeholder="供应商" options={suppliers.map((s) => ({ value: s.id, label: s.name }))} />
          </Form.Item>
        </Col>
        <Col xs={24} md={6}>
          <Form.Item name="receiveUnit" label="领用单位/部门"><Input /></Form.Item>
        </Col>
        <Col xs={24} md={6}>
          <Form.Item name="responsible" label="责任人"><Input /></Form.Item>
        </Col>
        {STATUS_QTY_KEYS.map(([k, label]) => (
          <Col xs={12} md={6} key={k}>
            <Form.Item name={k} label={`${label}数量`} rules={feeMode ? [] : [{ required: true, message: `请填写${label}数量` }]}>
              <InputNumber
                style={{ width: '100%' }}
                min={0}
                precision={2}
                disabled={feeMode}
                onChange={(v) => setStatusQty((s) => ({ ...s, [k]: Number(v) || 0 }))}
              />
            </Form.Item>
          </Col>
        ))}
        {derived.mismatch != null && (
          <Col xs={24}>
            <Alert type="error" showIcon message={`在用/闲置/报废/丢失数量合计（${derived.mismatch}）不等于进/出场数量（${Number(qtyV)}），请核对。`} />
          </Col>
        )}
        <Col xs={24} md={6}>
          <Form.Item name="turnoverCount" label="周转次数（含本次）"><InputNumber style={{ width: '100%' }} min={0} precision={0} /></Form.Item>
        </Col>
        <Col xs={24} md={6}>
          <Form.Item name="originalPrice" label="原值单价"><InputNumber style={{ width: '100%' }} min={0} precision={2} /></Form.Item>
        </Col>
        <Col xs={24} md={6}>
          <Form.Item name="transferOutPrice" label="调出物资本项目进场时单价"><InputNumber style={{ width: '100%' }} min={0} precision={2} /></Form.Item>
        </Col>
        <Col xs={24}>
          <Form.Item name="remark" label="备注"><Input.TextArea rows={2} /></Form.Item>
        </Col>
      </Row>
    </Form>
  );
}
