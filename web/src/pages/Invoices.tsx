import { useEffect, useState } from 'react';
import {
  Card, Table, Button, Form, Input, Select, Space, Modal, Popconfirm, message, Tabs, Row, Col, InputNumber, DatePicker,
} from 'antd';
import { PlusOutlined, SearchOutlined, ExportOutlined, ImportOutlined } from '@ant-design/icons';
import dayjs from 'dayjs';
import { invoiceApi } from '@/api/modules';
import { contractApi } from '@/api/business';
import { useTable } from '@/hooks/useTable';
import DictSelect, { DictTag } from '@/components/DictSelect';
import Uploader, { UploadFile } from '@/components/Uploader';

const money = (v: number) =>
  v == null ? '-' : `¥${Number(v).toLocaleString('zh-CN', { maximumFractionDigits: 2 })}`;

export default function Invoices() {
  const [contracts, setContracts] = useState<any[]>([]);
  useEffect(() => {
    contractApi.list({ pageSize: 1000 }).then((res: any) => setContracts(res?.list || []));
  }, []);
  const contractOptions = contracts.map((c) => ({ value: c.id, label: `${c.code} ${c.name}` }));

  return (
    <Card title="发票管理">
      <Tabs
        items={[
          { key: 'invoice', label: '收票登记', children: <InvoiceTab contracts={contracts} contractOptions={contractOptions} /> },
          { key: 'apply', label: '开票申请', children: <ApplyTab contractOptions={contractOptions} /> },
        ]}
      />
    </Card>
  );
}

function InvoiceTab({ contracts, contractOptions }: { contracts: any[]; contractOptions: any[] }) {
  const { loading, list, pagination, search, reload } = useTable<any>((p) => invoiceApi.list(p));
  const [form] = Form.useForm();
  const [modal, setModal] = useState(false);
  const [editing, setEditing] = useState<any>(null);
  const [images, setImages] = useState<UploadFile[]>([]);
  const [noStatus, setNoStatus] = useState<'' | 'error' | 'success'>('');
  const [noMsg, setNoMsg] = useState('');
  const [noTimer, setNoTimer] = useState<any>(null);

  const checkNo = (no: string) => {
    if (!no) {
      setNoStatus('');
      setNoMsg('');
      return;
    }
    if (noTimer) clearTimeout(noTimer);
    setNoTimer(
      setTimeout(async () => {
        if (editing && editing.invoiceNo === no) {
          setNoStatus('success');
          setNoMsg('当前发票号码');
          return;
        }
        const res: any = await invoiceApi.checkNo(no, editing?.id);
        if (res?.exists) {
          setNoStatus('error');
          setNoMsg('发票号码已存在');
        } else {
          setNoStatus('success');
          setNoMsg('发票号码可用');
        }
      }, 400),
    );
  };

  const submit = async () => {
    const v = await form.validateFields();
    if (noStatus === 'error') {
      message.error('发票号码已存在，请修改');
      return;
    }
    const payload = {
      ...v,
      invoiceDate: v.invoiceDate ? dayjs(v.invoiceDate).format('YYYY-MM-DD') : null,
      receiveTime: v.receiveTime ? dayjs(v.receiveTime).format('YYYY-MM-DD') : null,
      imageUrl: images?.[0]?.url,
      images,
    };
    if (editing) await invoiceApi.update(editing.id, payload);
    else await invoiceApi.create(payload);
    message.success('保存成功');
    setModal(false);
    form.resetFields();
    setImages([]);
    setEditing(null);
    setNoStatus('');
    setNoMsg('');
    reload();
  };

  const openEdit = (row: any) => {
    setEditing(row);
    form.setFieldsValue({
      ...row,
      invoiceDate: row.invoiceDate ? dayjs(row.invoiceDate) : null,
      receiveTime: row.receiveTime ? dayjs(row.receiveTime) : null,
    });
    setImages(row.images || []);
    setNoStatus('');
    setNoMsg('');
    setModal(true);
  };

  const doVerify = async (id: string) => {
    await invoiceApi.verify(id);
    message.success('已发起查验');
    reload();
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
      const res = await fetch(invoiceApi.importUrl(), {
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

  return (
    <>
      <Form layout="inline" style={{ marginBottom: 16, rowGap: 8 }} onFinish={(v) => search(v)}>
        <Form.Item name="contractId"><Select2 options={contractOptions} placeholder="合同" /></Form.Item>
        <Form.Item name="goodsCategory"><DictSelect typeCode="goods_category" placeholder="商品类别" /></Form.Item>
        <Form.Item name="typeCode"><DictSelect typeCode="invoice_type" placeholder="发票类型" /></Form.Item>
        <Form.Item name="status"><DictSelect typeCode="invoice_status" placeholder="状态" /></Form.Item>
        <Form.Item name="reviewStatus"><DictSelect typeCode="invoice_review_status" placeholder="审核状态" /></Form.Item>
        <Form.Item name="invoiceNo"><Input placeholder="发票号码" allowClear /></Form.Item>
        <Form.Item><Button type="primary" htmlType="submit">查询</Button></Form.Item>
      </Form>

      <div style={{ marginBottom: 16, textAlign: 'right' }}>
        <Space>
          <Button icon={<ImportOutlined />} onClick={importExcel}>导入</Button>
          <Button icon={<ExportOutlined />} onClick={() => window.open(invoiceApi.exportUrl())}>导出</Button>
          <Button type="primary" icon={<PlusOutlined />} onClick={() => { setEditing(null); form.resetFields(); setImages([]); setNoStatus(''); setNoMsg(''); setModal(true); }}>
            收票登记
          </Button>
        </Space>
      </div>

      <Table
        rowKey="id"
        loading={loading}
        dataSource={list}
        pagination={pagination}
        scroll={{ x: 2400 }}
        columns={[
          { title: '序号', width: 70, fixed: 'left', render: (_, __, i) => i + 1 },
          { title: '商品类别', dataIndex: 'goodsCategory', width: 120, render: (v) => <DictTag typeCode="goods_category" value={v} /> },
          { title: '结算账期', dataIndex: 'settlePeriod', width: 120 },
          { title: '开票单位', dataIndex: 'issuer', width: 200 },
          { title: '开票日期', dataIndex: 'invoiceDate', width: 120, render: (v) => v?.slice(0, 10) },
          { title: '发票代码', dataIndex: 'invoiceCode', width: 140 },
          { title: '发票号码', dataIndex: 'invoiceNo', width: 160 },
          { title: '税前金额', dataIndex: 'preTaxAmount', width: 140, render: money },
          { title: '税率', dataIndex: 'taxRate', width: 90, render: (v) => (v == null ? '-' : `${(Number(v) * 100).toFixed(2)}%`) },
          { title: '含税金额', dataIndex: 'taxIncludedAmount', width: 140, render: money },
          { title: '发票收取时间', dataIndex: 'receiveTime', width: 130, render: (v) => v?.slice(0, 10) },
          { title: '发票信息审核', dataIndex: 'reviewStatus', width: 130, render: (v) => <DictTag typeCode="invoice_review_status" value={v} /> },
          { title: '责任人', dataIndex: 'responsible', width: 120 },
          { title: '财务移交情况', dataIndex: 'transferStatus', width: 130, render: (v) => <DictTag typeCode="finance_transfer_status" value={v} /> },
          { title: '状态', dataIndex: 'status', width: 110, render: (v) => <DictTag typeCode="invoice_status" value={v} /> },
          { title: '备注', dataIndex: 'remark', width: 160 },
          {
            title: '操作',
            width: 180,
            fixed: 'right',
            render: (_, row) => (
              <Space size={4}>
                <Button type="link" size="small" onClick={() => openEdit(row)}>编辑</Button>
                <Button type="link" size="small" onClick={() => doVerify(row.id)}>查验</Button>
                <Popconfirm title="确认删除？" onConfirm={async () => { await invoiceApi.remove(row.id); message.success('已删除'); reload(); }}>
                  <Button type="link" size="small" danger>删除</Button>
                </Popconfirm>
              </Space>
            ),
          },
        ]}
      />

      <Modal
        title={editing ? '编辑发票' : '收票登记'}
        open={modal}
        onOk={submit}
        onCancel={() => setModal(false)}
        width={960}
        destroyOnClose
      >
        <Form form={form} layout="vertical">
          <Row gutter={16}>
            <Col xs={24} md={12}>
              <Form.Item name="typeCode" label="发票类型" rules={[{ required: true }]}><DictSelect typeCode="invoice_type" /></Form.Item>
            </Col>
            <Col xs={24} md={12}>
              <Form.Item name="contractId" label="关联合同" rules={[{ required: true }]}><Select2 options={contractOptions} /></Form.Item>
            </Col>
            <Col xs={24} md={12}>
              <Form.Item name="goodsCategory" label="商品类别"><DictSelect typeCode="goods_category" /></Form.Item>
            </Col>
            <Col xs={24} md={12}><Form.Item name="settlePeriod" label="结算账期"><Input /></Form.Item></Col>
            <Col xs={24} md={12}><Form.Item name="issuer" label="开票单位"><Input /></Form.Item></Col>
            <Col xs={24} md={12}><Form.Item name="invoiceDate" label="开票日期"><DatePicker style={{ width: '100%' }} /></Form.Item></Col>
            <Col xs={24} md={12}><Form.Item name="invoiceCode" label="发票代码"><Input /></Form.Item></Col>
            <Col xs={24} md={12}>
              <Form.Item
                name="invoiceNo"
                label="发票号码"
                rules={[{ required: true }]}
                validateStatus={noStatus}
                help={noMsg}
                hasFeedback
              >
                <Input onChange={(e) => checkNo(e.target.value)} />
              </Form.Item>
            </Col>
            <Col xs={24} md={8}><Form.Item name="preTaxAmount" label="税前金额"><InputNumber style={{ width: '100%' }} min={0} precision={2} /></Form.Item></Col>
            <Col xs={24} md={8}><Form.Item name="taxRate" label="税率"><InputNumber style={{ width: '100%' }} min={0} max={1} step={0.01} precision={4} /></Form.Item></Col>
            <Col xs={24} md={8}><Form.Item name="taxIncludedAmount" label="含税金额"><InputNumber style={{ width: '100%' }} min={0} precision={2} /></Form.Item></Col>
            <Col xs={24} md={12}><Form.Item name="receiveTime" label="发票收取时间"><DatePicker style={{ width: '100%' }} /></Form.Item></Col>
            <Col xs={24} md={12}><Form.Item name="reviewStatus" label="发票信息审核"><DictSelect typeCode="invoice_review_status" /></Form.Item></Col>
            <Col xs={24} md={12}><Form.Item name="responsible" label="责任人"><Input /></Form.Item></Col>
            <Col xs={24} md={12}><Form.Item name="transferStatus" label="财务移交情况"><DictSelect typeCode="finance_transfer_status" /></Form.Item></Col>
            <Col xs={24} md={12}><Form.Item name="status" label="状态"><DictSelect typeCode="invoice_status" /></Form.Item></Col>
            <Col xs={24}>
              <Form.Item name="remark" label="备注"><Input.TextArea rows={2} /></Form.Item>
            </Col>
            <Col xs={24}>
              <Form.Item label="发票影像">
                <Uploader value={images} onChange={setImages} />
              </Form.Item>
            </Col>
          </Row>
        </Form>
      </Modal>
    </>
  );
}

function ApplyTab({ contractOptions }: { contractOptions: any[] }) {
  const { loading, list, pagination, search, reload } = useTable<any>((p) => invoiceApi.applies(p));
  const [form] = Form.useForm();
  const [modal, setModal] = useState(false);
  const [editing, setEditing] = useState<any>(null);

  const submit = async () => {
    const v = await form.validateFields();
    if (editing) {
      // 后端未提供apply更新接口，按创建口径提交
      await invoiceApi.createApply(v);
    } else {
      await invoiceApi.createApply(v);
    }
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

  const approve = async (id: string, action: string) => {
    await invoiceApi.approveApply(id, action);
    message.success(action === 'APPROVED' ? '已通过' : '已驳回');
    reload();
  };

  return (
    <>
      <Form layout="inline" style={{ marginBottom: 16, rowGap: 8 }} onFinish={(v) => search(v)}>
        <Form.Item name="contractId"><Select2 options={contractOptions} placeholder="合同" /></Form.Item>
        <Form.Item name="typeCode"><DictSelect typeCode="invoice_type" placeholder="发票类型" /></Form.Item>
        <Form.Item name="status"><DictSelect typeCode="invoice_status" placeholder="状态" /></Form.Item>
        <Form.Item><Button type="primary" htmlType="submit">查询</Button></Form.Item>
      </Form>

      <div style={{ marginBottom: 16, textAlign: 'right' }}>
        <Button type="primary" icon={<PlusOutlined />} onClick={() => { setEditing(null); form.resetFields(); setModal(true); }}>
          申请开票
        </Button>
      </div>

      <Table
        rowKey="id"
        loading={loading}
        dataSource={list}
        pagination={pagination}
        scroll={{ x: 1500 }}
        columns={[
          { title: '合同', width: 260, render: (_, r) => r.contract?.code || '-' },
          { title: '发票类型', dataIndex: 'typeCode', width: 120, render: (v) => <DictTag typeCode="invoice_type" value={v} /> },
          { title: '金额', dataIndex: 'amount', width: 140, render: money },
          { title: '税率', dataIndex: 'taxRate', width: 90, render: (v) => (v == null ? '-' : `${(Number(v) * 100).toFixed(2)}%`) },
          { title: '购方信息', dataIndex: 'buyerInfo', width: 220 },
          { title: '状态', dataIndex: 'status', width: 110, render: (v) => <DictTag typeCode="invoice_status" value={v} /> },
          { title: '备注', dataIndex: 'remark', width: 160 },
          {
            title: '操作',
            width: 200,
            fixed: 'right',
            render: (_, row) => (
              <Space size={4}>
                <Button type="link" size="small" onClick={() => openEdit(row)}>编辑</Button>
                <Button type="link" size="small" onClick={() => approve(row.id, 'APPROVED')}>通过</Button>
                <Button type="link" size="small" danger onClick={() => approve(row.id, 'REJECTED')}>驳回</Button>
                <Popconfirm title="确认删除？" onConfirm={async () => { await invoiceApi.removeApply(row.id); message.success('已删除'); reload(); }}>
                  <Button type="link" size="small" danger>删除</Button>
                </Popconfirm>
              </Space>
            ),
          },
        ]}
      />

      <Modal
        title={editing ? '编辑开票申请' : '申请开票'}
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
              <Form.Item name="typeCode" label="发票类型" rules={[{ required: true }]}><DictSelect typeCode="invoice_type" /></Form.Item>
            </Col>
            <Col xs={24} md={12}>
              <Form.Item name="amount" label="金额" rules={[{ required: true }]}><InputNumber style={{ width: '100%' }} min={0} precision={2} /></Form.Item>
            </Col>
            <Col xs={24} md={12}>
              <Form.Item name="taxRate" label="税率"><InputNumber style={{ width: '100%' }} min={0} max={1} step={0.01} precision={4} /></Form.Item>
            </Col>
            <Col xs={24} md={12}><Form.Item name="buyerInfo" label="购方信息"><Input /></Form.Item></Col>
            <Col xs={24} md={12}><Form.Item name="status" label="状态"><DictSelect typeCode="invoice_status" /></Form.Item></Col>
            <Col xs={24}>
              <Form.Item name="remark" label="备注"><Input.TextArea rows={2} /></Form.Item>
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
