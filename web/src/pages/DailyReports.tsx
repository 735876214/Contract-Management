import { useEffect, useState } from 'react';
import { withToken } from '../utils/download';
import { Card, Table, Button, Form, Input, Space, Modal, Popconfirm, message, InputNumber, DatePicker, Row, Col, Select } from 'antd';
import { PlusOutlined, SearchOutlined, ExportOutlined, ImportOutlined } from '@ant-design/icons';
import dayjs from 'dayjs';
import { dailyApi, contractApi, supplierApi } from '@/api/business';
import { useTable } from '@/hooks/useTable';
import DictSelect, { DictTag } from '@/components/DictSelect';

const money = (v: number) => (v == null ? '-' : `¥${Number(v).toLocaleString('zh-CN', { maximumFractionDigits: 2 })}`);

type Kind = 'text' | 'number' | 'money' | 'date' | 'dict' | 'contractSelect' | 'supplierSelect';

interface F {
  key: string;
  label: string;
  kind: Kind;
  dict?: string;
  width?: number;
  fixed?: 'left' | 'right';
  step?: number;
  precision?: number;
}

// 列顺序严格按需求，请勿随意增删（无"合规性问题"列）
const FIELDS: F[] = [
  { key: 'periodYear', label: '账期/年', kind: 'number', width: 90 },
  { key: 'periodMonth', label: '账期/月', kind: 'number', width: 90 },
  { key: 'entryDate', label: '进场日期', kind: 'date', width: 120 },
  { key: 'contractId', label: '合同编号', kind: 'contractSelect', width: 150, fixed: 'left' },
  { key: 'isAsset', label: '是否资产', kind: 'dict', dict: 'yes_no', width: 100 },
  { key: 'assetSupervision', label: '资产监管', kind: 'text', width: 120 },
  { key: 'dept', label: '部门', kind: 'text', width: 110 },
  { key: 'person', label: '人员', kind: 'text', width: 110 },
  { key: 'assetStatus', label: '资产状态', kind: 'dict', dict: 'asset_status', width: 120 },
  { key: 'source', label: '来源', kind: 'dict', dict: 'material_source', width: 120 },
  { key: 'materialCategory', label: '材料类别', kind: 'dict', dict: 'material_category', width: 130 },
  { key: 'materialType', label: '物资种类', kind: 'dict', dict: 'material_type', width: 130 },
  { key: 'materialName', label: '物资名称', kind: 'text', width: 160 },
  { key: 'steelBrand', label: '钢筋品牌', kind: 'text', width: 120 },
  { key: 'steelPieces', label: '钢筋件数', kind: 'number', width: 110 },
  { key: 'spec', label: '规格型号', kind: 'text', width: 150 },
  { key: 'unit', label: '计量单位', kind: 'dict', dict: 'measurement_unit', width: 110 },
  { key: 'weighQty', label: '过磅数量/t', kind: 'number', step: 0.001, precision: 3, width: 120 },
  { key: 'deductWeight', label: '扣重/t', kind: 'number', step: 0.001, precision: 3, width: 100 },
  { key: 'settleQty', label: '结算数量', kind: 'number', step: 0.001, precision: 3, width: 110 },
  { key: 'isWeighed', label: '是否过磅', kind: 'dict', dict: 'yes_no', width: 100 },
  { key: 'priceBeforeTax', label: '单价/元(税前)', kind: 'number', step: 0.01, precision: 2, width: 130 },
  { key: 'taxRate', label: '税率', kind: 'number', step: 0.01, precision: 4, width: 90 },
  { key: 'priceAfterTax', label: '单价/元(税后)', kind: 'number', step: 0.01, precision: 2, width: 130 },
  { key: 'amountBeforeTax', label: '金额/元(税前)', kind: 'money', width: 140 },
  { key: 'amountAfterTax', label: '金额/元(税后)', kind: 'money', width: 140 },
  { key: 'supplierId', label: '供应单位', kind: 'supplierSelect', width: 180 },
  { key: 'receiveUnit', label: '领用单位', kind: 'text', width: 140 },
  { key: 'receiver', label: '领料人', kind: 'text', width: 110 },
  { key: 'laborContract', label: '劳务合同', kind: 'text', width: 140 },
  { key: 'usePart', label: '使用部位', kind: 'text', width: 140 },
  { key: 'isProxy', label: '是否代购', kind: 'dict', dict: 'yes_no', width: 100 },
  { key: 'plateNo', label: '车牌号', kind: 'text', width: 120 },
  { key: 'receiptNo', label: '收领单编号', kind: 'text', width: 140 },
  { key: 'remark', label: '备注', kind: 'text', width: 180 },
  { key: 'subPackagePeriod', label: '分包计价账期', kind: 'text', width: 130 },
  { key: 'incomePrice', label: '收入单价', kind: 'number', step: 0.01, precision: 2, width: 120 },
  { key: 'incomeTotal', label: '收入合价', kind: 'money', width: 140 },
  { key: 'standardPrice', label: '标准单价', kind: 'number', step: 0.01, precision: 2, width: 120 },
  { key: 'standardTotal', label: '标准合价', kind: 'money', width: 140 },
];

export default function DailyReports() {
  const { loading, list, params, search, reload, pagination } = useTable<any>((p) => dailyApi.list(p));
  const [form] = Form.useForm();
  const [modal, setModal] = useState(false);
  const [editing, setEditing] = useState<any>(null);

  const [contracts, setContracts] = useState<any[]>([]);
  const [suppliers, setSuppliers] = useState<any[]>([]);

  useEffect(() => {
    contractApi.options().then((res: any) => setContracts(res || []));
    supplierApi.options().then((res: any) => setSuppliers(res || []));
  }, []);

  const openEdit = (row?: any) => {
    setEditing(row || null);
    form.resetFields();
    if (row) {
      const v = { ...row, entryDate: row.entryDate ? dayjs(row.entryDate) : null };
      form.setFieldsValue(v);
    }
    setModal(true);
  };

  const submit = async () => {
    const values = await form.validateFields();
    const payload: any = { ...values };
    if (values.entryDate) payload.entryDate = values.entryDate.format('YYYY-MM-DD');
    // 数值字段转 number
    FIELDS.forEach((f) => {
      if ((f.kind === 'number') && payload[f.key] != null) payload[f.key] = Number(payload[f.key]);
    });
    if (payload.taxRate != null) payload.taxRate = Number(payload.taxRate);
    if (editing) await dailyApi.update(editing.id, payload);
    else await dailyApi.create(payload);
    message.success('保存成功');
    setModal(false);
    setEditing(null);
    reload();
  };

  const onSearch = (v: any) => {
    const p: any = { ...v };
    if (p.entryDate && p.entryDate.length === 2) {
      p.entryDateStart = p.entryDate[0].format('YYYY-MM-DD');
      p.entryDateEnd = p.entryDate[1].format('YYYY-MM-DD');
      delete p.entryDate;
    }
    if (p.materialType === undefined) delete p.materialType;
    search(p);
  };

  const importExcel = () => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.xlsx,.xls';
    input.onchange = async () => {
      const file = input.files?.[0];
      if (!file) return;
      const fd = new FormData();
      fd.append('file', file);
      const res = await fetch(dailyApi.importUrl(), {
        method: 'POST',
        headers: { Authorization: `Bearer ${localStorage.getItem('cms_token')}` },
        body: fd,
      });
      const body = await res.json();
      if (body.code === 0) {
        message.success(`导入完成：新增 ${body.data.created}，更新 ${body.data.updated}`);
        reload();
      } else message.error(body.message);
    };
    input.click();
  };

  const columns = FIELDS.map((f) => {
    if (f.kind === 'contractSelect') {
      return { title: f.label, dataIndex: f.key, width: f.width, fixed: f.fixed, render: (_: any, row: any) => row.contract?.code || '-' };
    }
    if (f.kind === 'supplierSelect') {
      return { title: f.label, dataIndex: f.key, width: f.width, render: (_: any, row: any) => row.supplier?.name || '-' };
    }
    const base: any = { title: f.label, dataIndex: f.key, width: f.width };
    if (f.kind === 'dict') return { ...base, render: (v: string) => <DictTag typeCode={f.dict!} value={v} /> };
    if (f.kind === 'money') return { ...base, render: money };
    if (f.kind === 'date') return { ...base, render: (v: string) => (v ? v.slice(0, 10) : '-') };
    if (f.kind === 'number') return { ...base, render: (v: any) => (v == null ? '-' : Number(v).toLocaleString('zh-CN')) };
    return base;
  });

  columns.push({
    title: '操作',
    width: 150,
    fixed: 'right',
    render: (_: any, row: any) => (
      <Space size={4}>
        <Button type="link" size="small" onClick={() => openEdit(row)}>编辑</Button>
        <Popconfirm title="确认删除该日报？" onConfirm={async () => { await dailyApi.remove(row.id); message.success('已删除'); reload(); }}>
          <Button type="link" size="small" danger>删除</Button>
        </Popconfirm>
      </Space>
    ),
  } as any);

  return (
    <Card
      title="日报管理"
      extra={
        <Space>
          <Button icon={<ImportOutlined />} onClick={importExcel}>导入</Button>
          <Button icon={<ExportOutlined />} onClick={() => window.open(withToken(dailyApi.exportUrl()))}>导出</Button>
          <Button type="primary" icon={<PlusOutlined />} onClick={() => openEdit()}>新增日报</Button>
        </Space>
      }
    >
      <Form layout="inline" style={{ marginBottom: 16, rowGap: 8 }} onFinish={onSearch}>
        <Form.Item name="periodYear" label="账期年"><InputNumber style={{ width: 110 }} min={2000} max={2100} placeholder="年" /></Form.Item>
        <Form.Item name="periodMonth" label="账期月"><InputNumber style={{ width: 100 }} min={1} max={12} placeholder="月" /></Form.Item>
        <Form.Item name="contractId">
          <Select showSearch optionFilterProp="label" placeholder="合同" allowClear style={{ minWidth: 200 }}
            options={contracts.map((c) => ({ value: c.id, label: `${c.code || ''} ${c.name || ''}`.trim() }))} />
        </Form.Item>
        <Form.Item name="supplierId">
          <Select showSearch optionFilterProp="label" placeholder="供应单位" allowClear style={{ minWidth: 180 }}
            options={suppliers.map((s) => ({ value: s.id, label: s.name }))} />
        </Form.Item>
        <Form.Item name="materialCategory"><DictSelect typeCode="material_category" placeholder="材料类别" /></Form.Item>
        <Form.Item noStyle shouldUpdate={(prev, cur) => prev.materialCategory !== cur.materialCategory}>
          {({ getFieldValue }: any) => (
            <Form.Item name="materialType" label="物资种类">
              <DictSelect typeCode="material_type" extValue={getFieldValue('materialCategory')} placeholder="物资种类" />
            </Form.Item>
          )}
        </Form.Item>
        <Form.Item name="assetStatus"><DictSelect typeCode="asset_status" placeholder="资产状态" /></Form.Item>
        <Form.Item name="source"><DictSelect typeCode="material_source" placeholder="来源" /></Form.Item>
        <Form.Item name="entryDate"><DatePicker.RangePicker placeholder={['进场起', '进场止']} /></Form.Item>
        <Form.Item><Button type="primary" htmlType="submit">查询</Button></Form.Item>
      </Form>

      <Table
        rowKey="id"
        loading={loading}
        dataSource={list}
        pagination={pagination}
        scroll={{ x: 3200 }}
        columns={columns as any}
      />

      <Modal
        title={editing ? '编辑日报' : '新增日报'}
        open={modal}
        onOk={submit}
        onCancel={() => setModal(false)}
        width={1080}
        destroyOnClose
      >
        <Form form={form} layout="vertical">
          <Row gutter={16}>
            {FIELDS.map((f) => (
              <Col xs={24} md={8} key={f.key}>
                {f.kind === 'contractSelect' && (
                  <Form.Item name="contractId" label="合同" rules={[{ required: true }]}>
                    <Select showSearch optionFilterProp="label" placeholder="请选择合同"
                      options={contracts.map((c) => ({ value: c.id, label: `${c.code || ''} ${c.name || ''}`.trim() }))} />
                  </Form.Item>
                )}
                {f.kind === 'supplierSelect' && (
                  <Form.Item name="supplierId" label="供应单位" rules={[{ required: true }]}>
                    <Select showSearch optionFilterProp="label" placeholder="请选择供应单位"
                      options={suppliers.map((s) => ({ value: s.id, label: s.name }))} />
                  </Form.Item>
                )}
                {f.kind === 'dict' && (
                  <Form.Item name={f.key} label={f.label}>
                    <DictSelect typeCode={f.dict!} />
                  </Form.Item>
                )}
                {f.kind === 'date' && (
                  <Form.Item name={f.key} label={f.label}><DatePicker style={{ width: '100%' }} /></Form.Item>
                )}
                {f.kind === 'number' && (
                  <Form.Item name={f.key} label={f.label}>
                    <InputNumber style={{ width: '100%' }} min={0} step={f.step} precision={f.precision} />
                  </Form.Item>
                )}
                {f.kind === 'text' && (
                  <Form.Item name={f.key} label={f.label}><Input /></Form.Item>
                )}
                {(f.kind === 'money') && (
                  <Form.Item name={f.key} label={f.label}>
                    <InputNumber style={{ width: '100%' }} min={0} step={0.01} precision={2} />
                  </Form.Item>
                )}
              </Col>
            ))}
          </Row>
        </Form>
      </Modal>
    </Card>
  );
}
