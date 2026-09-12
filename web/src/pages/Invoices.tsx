import { useEffect, useState } from 'react';
import { withToken } from '../utils/download';
import {
  Button,
  Form,
  Input,
  Select,
  Space,
  Modal,
  message,
  Row,
  Col,
  InputNumber,
  DatePicker,
  Upload,
  Alert,
  Table,
} from 'antd';
import { PlusOutlined, ExportOutlined, ScanOutlined, InboxOutlined } from '@ant-design/icons';
import dayjs from 'dayjs';
import { dictApi, type DictOption } from '@/api/dict';
import { invoiceApi } from '@/api/modules';
import { contractApi } from '@/api/business';
import ModuleListPage, { type ModuleListFilterField, type ModuleListRow } from '@/components/procurement/ModuleListPage';
import DictSelect, { DictTag } from '@/components/DictSelect';
import Uploader, { UploadFile } from '@/components/Uploader';
import ImportButton from '@/components/ImportButton';

const money = (v: number) =>
  v == null ? '-' : `¥${Number(v).toLocaleString('zh-CN', { maximumFractionDigits: 2 })}`;

/** 发票管理（问题四：统一标准列表页规约） */
export default function Invoices() {
  const [contracts, setContracts] = useState<any[]>([]);
  /** 筛选用字典选项 */
  const [dicts, setDicts] = useState<Record<string, DictOption[]>>({});
  useEffect(() => {
    contractApi.list({ pageSize: 1000 }).then((res: any) => setContracts(res?.list || []));
    const types = ['goods_category', 'invoice_type', 'invoice_status', 'invoice_review_status'];
    Promise.all(types.map((t) => dictApi.options(t).catch(() => []))).then((lists) => {
      const map: Record<string, DictOption[]> = {};
      types.forEach((t, i) => (map[t] = lists[i] || []));
      setDicts(map);
    });
  }, []);
  const contractOptions = contracts.map((c) => ({ value: c.id, label: `${c.code} ${c.name}` }));

  return <InvoiceTab contractOptions={contractOptions} dicts={dicts} />;
}

function InvoiceTab({
  contractOptions,
  dicts,
}: {
  contractOptions: any[];
  dicts: Record<string, DictOption[]>;
}) {
  const [form] = Form.useForm();
  const [modal, setModal] = useState(false);
  const [editing, setEditing] = useState<any>(null);
  const [images, setImages] = useState<UploadFile[]>([]);
  const [noStatus, setNoStatus] = useState<'' | 'error' | 'success'>('');
  const [noMsg, setNoMsg] = useState('');
  const [noTimer, setNoTimer] = useState<any>(null);
  const [batchOpen, setBatchOpen] = useState(false);
  const [listRefresh, setListRefresh] = useState(0);
  const refreshList = () => setListRefresh((k) => k + 1);

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
      receiveDate: v.receiveDate ? dayjs(v.receiveDate).format('YYYY-MM-DD') : null,
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
    refreshList();
  };

  const openEdit = (row: any) => {
    setEditing(row);
    form.setFieldsValue({
      ...row,
      invoiceDate: row.invoiceDate ? dayjs(row.invoiceDate) : null,
      receiveDate: row.receiveDate ? dayjs(row.receiveDate) : null,
    });
    setImages(row.images || []);
    setNoStatus('');
    setNoMsg('');
    setModal(true);
  };

  const doVerify = async (id: string) => {
    await invoiceApi.verify(id);
    message.success('已发起查验');
    refreshList();
  };

  const handleRemove = (row: ModuleListRow) => {
    Modal.confirm({
      title: '确认删除该发票记录？',
      okText: '确认删除',
      okType: 'danger',
      onOk: async () => {
        await invoiceApi.remove(row.id);
        message.success('已删除');
        refreshList();
      },
    });
  };

  /** 筛选项（问题四：标准筛选区） */
  const extraFilters: ModuleListFilterField[] = [
    { key: 'contractId', label: '合同', control: 'select', options: contractOptions },
    { key: 'goodsCategory', label: '商品类别', control: 'select', options: dicts.goods_category ?? [] },
    { key: 'typeCode', label: '发票类型', control: 'select', options: dicts.invoice_type ?? [] },
    { key: 'status', label: '状态', control: 'select', options: dicts.invoice_status ?? [] },
    { key: 'reviewStatus', label: '审核状态', control: 'select', options: dicts.invoice_review_status ?? [] },
    { key: 'invoiceNo', label: '发票号码', control: 'input' },
  ];

  /** 表格列（问题四：generic 模式完整列定义） */
  const extraColumns: any[] = [
    { title: '序号', width: 70, fixed: 'left', render: (_v: any, _r: any, i: number) => i + 1 },
    { title: '商品类别', dataIndex: 'goodsCategory', width: 120, render: (v: any) => <DictTag typeCode="goods_category" value={v} /> },
    { title: '结算账期', dataIndex: 'settlePeriod', width: 120 },
    { title: '开票单位', dataIndex: 'issuer', width: 200, ellipsis: true },
    { title: '开票日期', dataIndex: 'invoiceDate', width: 120, render: (v: any) => v?.slice(0, 10) },
    { title: '发票代码', dataIndex: 'invoiceCode', width: 140 },
    { title: '发票号码', dataIndex: 'invoiceNo', width: 160 },
    { title: '税前金额', dataIndex: 'amountBeforeTax', width: 140, align: 'right', render: money },
    { title: '税率', dataIndex: 'taxRate', width: 90, align: 'right', render: (v: any) => (v == null ? '-' : `${(Number(v) * 100).toFixed(2)}%`) },
    { title: '含税金额', dataIndex: 'amountWithTax', width: 140, align: 'right', render: money },
    { title: '发票收取时间', dataIndex: 'receiveDate', width: 130, render: (v: any) => v?.slice(0, 10) },
    { title: '发票信息审核', dataIndex: 'reviewStatus', width: 130, render: (v: any) => <DictTag typeCode="invoice_review_status" value={v} /> },
    { title: '责任人', dataIndex: 'responsiblePerson', width: 120 },
    { title: '财务移交情况', dataIndex: 'financeTransferStatus', width: 130, render: (v: any) => <DictTag typeCode="finance_transfer_status" value={v} /> },
    { title: '状态', dataIndex: 'statusCode', width: 110, render: (v: any) => <DictTag typeCode="invoice_status" value={v} /> },
    { title: '备注', dataIndex: 'remark', width: 160, ellipsis: true },
  ];

  return (
    <>
      <ModuleListPage
        mode="generic"
        fetcher={(params) => invoiceApi.list(params)}
        extraFilters={extraFilters}
        extraColumns={extraColumns}
        refreshKey={listRefresh}
        onEdit={(row) => openEdit(row)}
        onDelete={handleRemove}
        rowMenuItems={(row) => [
          { key: 'verify', label: '查验', onClick: () => doVerify(row.id) },
        ]}
        toolbarLeft={
          <Space wrap size={8}>
            <Button icon={<ScanOutlined />} type="primary" ghost onClick={() => setBatchOpen(true)}>
              批量识别
            </Button>
            <ImportButton
              moduleName="发票台账"
              templateUrl={invoiceApi.templateUrl()}
              uploadUrl={invoiceApi.importUrl()}
              onDone={refreshList}
            />
            <Button icon={<ExportOutlined />} onClick={() => window.open(withToken(invoiceApi.exportUrl()))}>
              导出
            </Button>
            <Button
              type="primary"
              icon={<PlusOutlined />}
              onClick={() => {
                setEditing(null);
                form.resetFields();
                setImages([]);
                setNoStatus('');
                setNoMsg('');
                setModal(true);
              }}
            >
              收票登记
            </Button>
          </Space>
        }
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
              <Form.Item name="contractId" label="关联合同" rules={[{ required: true }]}>
                <Select
                  showSearch
                  optionFilterProp="label"
                  allowClear
                  placeholder="请选择合同"
                  options={contractOptions}
                />
              </Form.Item>
            </Col>
            <Col xs={24} md={12}>
              <Form.Item name="goodsCategory" label="商品类别"><DictSelect typeCode="goods_category" /></Form.Item>
            </Col>
            <Col xs={24} md={12}><Form.Item name="settlePeriod" label="结算账期"><Input /></Form.Item></Col>
            <Col xs={24} md={12}><Form.Item name="issuer" label="开票单位"><Input /></Form.Item></Col>
            <Col xs={24} md={12}><Form.Item name="invoiceDate" label="开票日期"><DatePicker format="YYYY-MM-DD" style={{ width: '100%' }} /></Form.Item></Col>
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
            <Col xs={24} md={8}><Form.Item name="amountBeforeTax" label="税前金额"><InputNumber style={{ width: '100%' }} min={0} precision={2} /></Form.Item></Col>
            <Col xs={24} md={8}><Form.Item name="taxRate" label="税率"><InputNumber style={{ width: '100%' }} min={0} max={1} step={0.01} precision={4} /></Form.Item></Col>
            <Col xs={24} md={8}><Form.Item name="amountWithTax" label="含税金额"><InputNumber style={{ width: '100%' }} min={0} precision={2} /></Form.Item></Col>
            <Col xs={24} md={12}><Form.Item name="receiveDate" label="发票收取时间"><DatePicker format="YYYY-MM-DD" style={{ width: '100%' }} /></Form.Item></Col>
            <Col xs={24} md={12}><Form.Item name="reviewStatus" label="发票信息审核"><DictSelect typeCode="invoice_review_status" /></Form.Item></Col>
            <Col xs={24} md={12}><Form.Item name="responsiblePerson" label="责任人"><Input /></Form.Item></Col>
            <Col xs={24} md={12}><Form.Item name="financeTransferStatus" label="财务移交情况"><DictSelect typeCode="finance_transfer_status" /></Form.Item></Col>
            <Col xs={24} md={12}><Form.Item name="statusCode" label="状态"><DictSelect typeCode="invoice_status" /></Form.Item></Col>
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

      <BatchRecognizeModal
        open={batchOpen}
        contractOptions={contractOptions}
        onClose={() => setBatchOpen(false)}
        onDone={() => {
          setBatchOpen(false);
          refreshList();
        }}
      />
    </>
  );
}

/**
 * 批量识别发票：上传发票照片 → 服务端解码二维码（发票代码/号码/金额/日期）
 * → 用户逐行选择关联合同、确认税率 → 批量写入发票台账。
 */
function BatchRecognizeModal({ open, contractOptions, onClose, onDone }: {
  open: boolean;
  contractOptions: any[];
  onClose: () => void;
  onDone: () => void;
}) {
  const [files, setFiles] = useState<File[]>([]);
  const [recognizing, setRecognizing] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [items, setItems] = useState<any[]>([]);
  const [done, setDone] = useState(false);

  const reset = () => {
    setFiles([]);
    setItems([]);
    setDone(false);
  };

  const handleUpload = (fileList: any[]) => {
    setFiles(fileList.map((f: any) => (f.originFileObj as File) || f).filter(Boolean));
    setItems([]); // 重新选图后清空上次识别结果
    setDone(false);
  };

  const doRecognize = async () => {
    if (!files.length) {
      message.warning('请先选择发票图片');
      return;
    }
    const fd = new FormData();
    files.forEach((f) => fd.append('files', f));
    setRecognizing(true);
    try {
      const res: any[] = await invoiceApi.recognize(fd);
      setItems(
        res.map((r, i) => ({
          key: String(i),
          filename: r.filename,
          ok: r.ok,
          error: r.error,
          ...(r.ok ? r.data : {}),
          contractId: undefined,
          taxRate: 0.13,
          goodsCategory: undefined,
        })),
      );
      setDone(false);
      const okCount = res.filter((r) => r.ok).length;
      if (okCount === 0) message.error('没有识别到有效的发票二维码');
      else if (okCount < res.length) message.warning(`识别完成：成功 ${okCount} 张，失败 ${res.length - okCount} 张`);
      else message.success(`识别完成：成功 ${okCount} 张`);
    } finally {
      setRecognizing(false);
    }
  };

  const patch = (key: string, data: any) =>
    setItems((list) => list.map((it) => (it.key === key ? { ...it, ...data } : it)));

  const doSubmit = async () => {
    const okItems = items.filter((it) => it.ok);
    if (!okItems.length) return;
    const missing = okItems.filter((it) => !it.contractId);
    if (missing.length) {
      message.warning(`还有 ${missing.length} 条未选择关联合同`);
      return;
    }
    setSubmitting(true);
    try {
      const res: any = await invoiceApi.batchCreate(
        okItems.map((it) => ({
          contractId: it.contractId,
          goodsCategory: it.goodsCategory,
          invoiceCode: it.invoiceCode,
          invoiceNo: it.invoiceNo,
          amountBeforeTax: it.amountBeforeTax,
          taxRate: it.taxRate,
          invoiceDate: it.invoiceDate,
          remark: '批量识别导入',
        })),
      );
      const errs = res?.errors || [];
      message.success(`已添加 ${res?.created ?? 0} 条到发票台账${errs.length ? `，失败 ${errs.length} 条` : ''}`);
      if (errs.length) {
        Modal.warning({
          title: '部分发票未入库',
          width: 520,
          content: (
            <ul style={{ paddingLeft: 20, margin: 0 }}>
              {errs.map((e: string, i: number) => (
                <li key={i} style={{ color: '#d4380d' }}>{e}</li>
              ))}
            </ul>
          ),
        });
      }
      setDone(true);
      onDone();
    } finally {
      setSubmitting(false);
    }
  };

  const okCount = items.filter((it) => it.ok).length;

  return (
    <Modal
      title="批量识别发票"
      open={open}
      onCancel={() => { onClose(); reset(); }}
      width={1080}
      destroyOnClose
      footer={
        done
          ? [<Button key="close" type="primary" onClick={() => { onClose(); reset(); }}>完成</Button>]
          : [
              <Button key="cancel" onClick={() => { onClose(); reset(); }}>取消</Button>,
              <Button key="rec" loading={recognizing} onClick={doRecognize}>开始识别</Button>,
              <Button key="ok" type="primary" loading={submitting} disabled={!okCount} onClick={doSubmit}>
                添加到台账（{okCount}）
              </Button>,
            ]
      }
    >
      <Alert
        type="info"
        showIcon
        style={{ marginBottom: 16 }}
        message="上传发票照片（支持 PNG/JPG，单次最多 20 张），系统自动识别发票左上角二维码中的发票代码、号码、不含税金额与开票日期；识别后请为每张发票选择对应合同再入台账。"
      />
      <Upload.Dragger
        multiple
        accept="image/png,image/jpeg"
        fileList={[] as any}
        beforeUpload={() => false}
        onChange={({ fileList }) => handleUpload(fileList)}
        style={{ marginBottom: 16 }}
        disabled={recognizing}
      >
        <p className="ant-upload-drag-icon"><InboxOutlined /></p>
        <p className="ant-upload-text">点击或拖拽发票图片到此处（可多选）</p>
        <p className="ant-upload-hint">{files.length ? `已选择 ${files.length} 张图片` : '仅支持 PNG / JPG 图片'}</p>
      </Upload.Dragger>

      {items.length > 0 && (
        <Table
          rowKey="key"
          size="small"
          dataSource={items}
          pagination={false}
          scroll={{ x: 1200 }}
          columns={[
            { title: '图片', dataIndex: 'filename', width: 180, ellipsis: true },
            {
              title: '识别结果',
              width: 420,
              render: (_, it) =>
                it.ok ? (
                  <span>
                    代码：{it.invoiceCode || '（全电票）'}｜号码：<b>{it.invoiceNo}</b>
                    <br />
                    金额：¥{it.amountBeforeTax ?? '-'}｜日期：{it.invoiceDate || '-'}
                  </span>
                ) : (
                  <span style={{ color: '#d4380d' }}>{it.error}</span>
                ),
            },
            {
              title: '关联合同',
              width: 260,
              render: (_, it) =>
                it.ok ? (
                  <Select
                    showSearch
                    optionFilterProp="label"
                    allowClear
                    style={{ width: '100%' }}
                    placeholder="请选择合同"
                    value={it.contractId}
                    options={contractOptions}
                    onChange={(v: string) => patch(it.key, { contractId: v })}
                  />
                ) : null,
            },
            {
              title: '税率',
              width: 120,
              render: (_, it) =>
                it.ok ? (
                  <InputNumber
                    style={{ width: '100%' }}
                    min={0}
                    max={1}
                    step={0.01}
                    precision={4}
                    value={it.taxRate}
                    onChange={(v) => patch(it.key, { taxRate: v })}
                  />
                ) : null,
            },
            {
              title: '商品类别',
              width: 160,
              render: (_, it) =>
                it.ok ? <DictSelect typeCode="goods_category" value={it.goodsCategory} onChange={(v: string) => patch(it.key, { goodsCategory: v })} /> : null,
            },
          ]}
        />
      )}
    </Modal>
  );
}
