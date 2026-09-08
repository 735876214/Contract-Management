import { useEffect, useState } from 'react';
import {
  Card, Table, Button, Form, Input, Space, Modal, Popconfirm, message, Tag, Drawer, Tabs,
  Descriptions, InputNumber, DatePicker, Row, Col, Alert, Spin, Select,
} from 'antd';
import { PlusOutlined, SearchOutlined, ExportOutlined, ImportOutlined } from '@ant-design/icons';
import dayjs from 'dayjs';
import { contractApi, supplierApi } from '@/api/business';
import { useTable } from '@/hooks/useTable';
import DictSelect, { DictTag } from '@/components/DictSelect';
import Uploader, { UploadFile } from '@/components/Uploader';

const money = (v: number) => (v == null ? '-' : `¥${Number(v).toLocaleString('zh-CN', { maximumFractionDigits: 2 })}`);

export default function Contracts() {
  const { loading, list, total, params, search, reload, pagination } = useTable<any>((p) => contractApi.list(p));
  const [form] = Form.useForm();
  const [extForm] = Form.useForm();
  const [modal, setModal] = useState(false);
  const [editing, setEditing] = useState<any>(null);
  const [suppliers, setSuppliers] = useState<any[]>([]);
  const [supplier, setSupplier] = useState<any>(null);
  const [attachments, setAttachments] = useState<UploadFile[]>([]);
  const [codeStatus, setCodeStatus] = useState<'' | 'error' | 'success'>('');
  const [codeMsg, setCodeMsg] = useState('');
  const [detail, setDetail] = useState<any>(null);
  const [changes, setChanges] = useState<any[]>([]);
  const [codeTimer, setCodeTimer] = useState<any>(null);

  useEffect(() => {
    supplierApi.options().then((res: any) => setSuppliers(res || []));
  }, []);

  // 合同编号实时查重
  const checkCode = (code: string) => {
    if (!code) {
      setCodeStatus('');
      setCodeMsg('');
      return;
    }
    if (codeTimer) clearTimeout(codeTimer);
    setCodeTimer(
      setTimeout(async () => {
        if (editing && editing.code === code) {
          setCodeStatus('success');
          setCodeMsg('当前编号');
          return;
        }
        const res: any = await contractApi.checkCode(code, editing?.id);
        if (res?.exists) {
          setCodeStatus('error');
          setCodeMsg(`合同编号已存在（${res.scope === 'GLOBAL' ? '全局唯一' : '项目内唯一'}）`);
        } else {
          setCodeStatus('success');
          setCodeMsg('编号可用');
        }
      }, 400),
    );
  };

  const onSupplierChange = (id: string) => {
    const hit = suppliers.find((s) => s.id === id);
    setSupplier(hit || null);
  };

  const submit = async () => {
    const values = await form.validateFields();
    if (codeStatus === 'error') {
      message.error('合同编号已存在，请修改');
      return;
    }
    const payload = {
      ...values,
      signDate: values.signDate ? values.signDate.format('YYYY-MM-DD') : null,
      attachments,
      ext: extForm.getFieldsValue(),
    };
    if (editing) await contractApi.update(editing.id, payload);
    else await contractApi.create(payload);
    message.success('保存成功');
    setModal(false);
    form.resetFields();
    extForm.resetFields();
    setEditing(null);
    setSupplier(null);
    setAttachments([]);
    reload();
  };

  const openEdit = (row: any) => {
    setEditing(row);
    form.setFieldsValue({
      ...row,
      signDate: row.signDate ? dayjs(row.signDate) : null,
    });
    extForm.setFieldsValue({
      ...(row.ext || {}),
      bidStartDate: row.ext?.bidStartDate ? dayjs(row.ext.bidStartDate) : null,
      bidWinDate: row.ext?.bidWinDate ? dayjs(row.ext.bidWinDate) : null,
      disclosureDate: row.ext?.disclosureDate ? dayjs(row.ext.disclosureDate) : null,
    });
    setSupplier(row.supplier || null);
    setAttachments(row.attachments || []);
    setCodeStatus('');
    setCodeMsg('');
    setModal(true);
  };

  const openDetail = async (row: any) => {
    const res: any = await contractApi.detail(row.id);
    setDetail(res);
    const ch: any = await contractApi.changes(row.id);
    setChanges(ch || []);
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
      const res = await fetch(contractApi.importUrl(), {
        method: 'POST',
        headers: { Authorization: `Bearer ${localStorage.getItem('cms_token')}` },
        body: fd,
      });
      const body = await res.json();
      if (body.code === 0) {
        message.success(`导入完成：新增 ${body.data.created} 条${body.data.errors?.length ? `，${body.data.errors.length} 条失败` : ''}`);
        reload();
      } else message.error(body.message);
    };
    input.click();
  };

  return (
    <Card
      title="合同管理"
      extra={
        <Space>
          <Button icon={<ImportOutlined />} onClick={importExcel}>导入</Button>
          <Button icon={<ExportOutlined />} onClick={() => window.open(contractApi.exportUrl())}>导出</Button>
          <Button type="primary" icon={<PlusOutlined />} onClick={() => { setEditing(null); form.resetFields(); extForm.resetFields(); setSupplier(null); setAttachments([]); setModal(true); }}>
            新建合同
          </Button>
        </Space>
      }
    >
      <Form layout="inline" style={{ marginBottom: 16, rowGap: 8 }} onFinish={(v) => search(v)}>
        <Form.Item name="keyword"><Input placeholder="合同编号/名称" allowClear prefix={<SearchOutlined />} /></Form.Item>
        <Form.Item name="typeCode"><DictSelect typeCode="contract_type" placeholder="合同类型" /></Form.Item>
        <Form.Item name="execStatus"><DictSelect typeCode="contract_execution_status" placeholder="执行情况" /></Form.Item>
        <Form.Item><Button type="primary" htmlType="submit">查询</Button></Form.Item>
      </Form>

      <Table
        rowKey="id"
        loading={loading}
        dataSource={list}
        pagination={pagination}
        scroll={{ x: 1500 }}
        columns={[
          { title: '合同编号', dataIndex: 'code', width: 160, fixed: 'left' },
          { title: '合同名称', dataIndex: 'name', width: 240 },
          { title: '合同类型', dataIndex: 'typeCode', width: 130, render: (v) => <DictTag typeCode="contract_type" value={v} /> },
          { title: '供应商', width: 220, render: (_, row) => row.supplier?.name || '-' },
          { title: '合同额', dataIndex: 'amount', width: 140, render: money },
          { title: '税率', dataIndex: 'taxRate', width: 90, render: (v) => (v == null ? '-' : `${(Number(v) * 100).toFixed(2)}%`) },
          { title: '签订日期', dataIndex: 'signDate', width: 120, render: (v) => v?.slice(0, 10) },
          { title: '执行情况', dataIndex: 'execStatus', width: 120, render: (v) => <DictTag typeCode="contract_execution_status" value={v} /> },
          {
            title: '操作',
            width: 200,
            fixed: 'right',
            render: (_, row) => (
              <Space size={4}>
                <Button type="link" size="small" onClick={() => openDetail(row)}>详情</Button>
                <Button type="link" size="small" onClick={() => openEdit(row)}>编辑</Button>
                <Popconfirm title="确认删除该合同？关联的清单、结算、付款等数据将一并删除。" onConfirm={async () => { await contractApi.remove(row.id); message.success('已删除'); reload(); }}>
                  <Button type="link" size="small" danger>删除</Button>
                </Popconfirm>
              </Space>
            ),
          },
        ]}
      />

      <Modal
        title={editing ? '编辑合同' : '新建合同'}
        open={modal}
        onOk={submit}
        onCancel={() => setModal(false)}
        width={960}
        destroyOnClose
      >
        <Tabs
          items={[
            {
              key: 'base',
              label: '基础信息',
              children: (
                <Form form={form} layout="vertical">
                  <Row gutter={16}>
                    <Col xs={24} md={12}>
                      <Form.Item
                        name="code"
                        label="合同编号"
                        rules={[{ required: true }]}
                        validateStatus={codeStatus}
                        help={codeMsg}
                        hasFeedback
                      >
                        <Input onChange={(e) => checkCode(e.target.value)} placeholder="如 HT-2026-0001" />
                      </Form.Item>
                    </Col>
                    <Col xs={24} md={12}>
                      <Form.Item name="name" label="合同名称" rules={[{ required: true }]}><Input /></Form.Item>
                    </Col>
                    <Col xs={24} md={12}>
                      <Form.Item name="typeCode" label="合同类型" rules={[{ required: true }]}>
                        <DictSelect typeCode="contract_type" />
                      </Form.Item>
                    </Col>
                    <Col xs={24} md={12}>
                      <Form.Item name="supplierId" label="供应商" rules={[{ required: true }]}>
                        <Select
                          showSearch
                          optionFilterProp="label"
                          placeholder="请选择供应商（选择后自动带出法人/授权人/银行等信息）"
                          onChange={onSupplierChange}
                          options={suppliers.map((s) => ({ value: s.id, label: s.name }))}
                        />
                      </Form.Item>
                    </Col>
                    <Col xs={24} md={8}>
                      <Form.Item name="signDate" label="签订日期"><DatePicker style={{ width: '100%' }} /></Form.Item>
                    </Col>
                    <Col xs={24} md={8}>
                      <Form.Item name="amount" label="合同额"><InputNumber style={{ width: '100%' }} min={0} precision={2} /></Form.Item>
                    </Col>
                    <Col xs={24} md={8}>
                      <Form.Item name="taxRate" label="税率"><InputNumber style={{ width: '100%' }} min={0} max={1} step={0.01} precision={4} /></Form.Item>
                    </Col>
                    <Col xs={24} md={8}>
                      <Form.Item name="paymentMethodCode" label="合同约定付款方式"><DictSelect typeCode="payment_method" /></Form.Item>
                    </Col>
                    <Col xs={24} md={8}>
                      <Form.Item name="isFramework" label="是否框架协议"><DictSelect typeCode="yes_no" /></Form.Item>
                    </Col>
                    <Col xs={24} md={8}>
                      <Form.Item name="isSupplement" label="是否补充协议"><DictSelect typeCode="yes_no" /></Form.Item>
                    </Col>
                    <Col xs={24} md={12}>
                      <Form.Item
                        noStyle
                        shouldUpdate={(prev, cur) => prev.isSupplement !== cur.isSupplement}
                      >
                        {({ getFieldValue }) =>
                          getFieldValue('isSupplement') === 'Y' ? (
                            <Form.Item name="supplementTypeCode" label="补充协议类型" rules={[{ required: true, message: '请选择补充协议类型' }]}>
                              <DictSelect typeCode="supplement_agreement_type" />
                            </Form.Item>
                          ) : null
                        }
                      </Form.Item>
                    </Col>
                    <Col xs={24} md={12}>
                      <Form.Item name="execStatus" label="合同执行情况"><DictSelect typeCode="contract_execution_status" /></Form.Item>
                    </Col>
                    <Col xs={24}>
                      <Form.Item name="remark" label="备注"><Input.TextArea rows={2} /></Form.Item>
                    </Col>
                    <Col xs={24}>
                      <Form.Item label="附件"><Uploader value={attachments} onChange={setAttachments} /></Form.Item>
                    </Col>
                  </Row>

                  {supplier && (
                    <>
                      <Alert
                        type="info"
                        showIcon
                        style={{ marginBottom: 12 }}
                        message="以下信息由供应商库自动带出，只读展示；修改请在【供应商库】维护"
                      />
                      <Descriptions bordered size="small" column={2} style={{ marginBottom: 16 }}>
                        <Descriptions.Item label="法人姓名">{supplier.legalPerson || '-'}</Descriptions.Item>
                        <Descriptions.Item label="法人电话">{supplier.legalPhone || '-'}</Descriptions.Item>
                        <Descriptions.Item label="合同授权人姓名">{supplier.contractAuthPerson || '-'}</Descriptions.Item>
                        <Descriptions.Item label="合同授权人电话">{supplier.contractAuthPhone || '-'}</Descriptions.Item>
                        <Descriptions.Item label="授权人身份证号">{supplier.contractAuthIdNo || '-'}</Descriptions.Item>
                        <Descriptions.Item label="联系人姓名">{supplier.contactName || '-'}</Descriptions.Item>
                        <Descriptions.Item label="联系人电话">{supplier.contactPhone || '-'}</Descriptions.Item>
                        <Descriptions.Item label="联系人邮箱">{supplier.contactEmail || '-'}</Descriptions.Item>
                        <Descriptions.Item label="银行名称">{supplier.bankName || '-'}</Descriptions.Item>
                        <Descriptions.Item label="银行账号">{supplier.bankAccount || '-'}</Descriptions.Item>
                        <Descriptions.Item label="公司地址" span={2}>{supplier.address || '-'}</Descriptions.Item>
                      </Descriptions>
                    </>
                  )}
                </Form>
              ),
            },
            {
              key: 'ext',
              label: '台账补充信息',
              children: (
                <Form form={extForm} layout="vertical">
                  <Row gutter={16}>
                    <Col xs={24} md={12}>
                      <Form.Item name="financeCode" label="财务一体化合同编号"><Input /></Form.Item>
                    </Col>
                    <Col xs={24} md={12}>
                      <Form.Item name="bidName" label="招标名称"><Input /></Form.Item>
                    </Col>
                    <Col xs={24} md={12}>
                      <Form.Item name="procurementSrc" label="采购来源"><DictSelect typeCode="procurement_source" /></Form.Item>
                    </Col>
                    <Col xs={24} md={12}>
                      <Form.Item name="isDirectPurchase" label="是否厂家直采"><DictSelect typeCode="is_direct_purchase" /></Form.Item>
                    </Col>
                    <Col xs={24} md={12}>
                      <Form.Item name="supplierCategory" label="分供方类别"><DictSelect typeCode="supplier_category" /></Form.Item>
                    </Col>
                    <Col xs={24} md={12}>
                      <Form.Item name="currentPayRatio" label="当前合同付款比例"><InputNumber style={{ width: '100%' }} min={0} max={1} step={0.01} precision={4} /></Form.Item>
                    </Col>
                    <Col xs={24} md={8}>
                      <Form.Item name="bidStartDate" label="开始招标时间"><DatePicker style={{ width: '100%' }} /></Form.Item>
                    </Col>
                    <Col xs={24} md={8}>
                      <Form.Item name="bidWinDate" label="定标时间"><DatePicker style={{ width: '100%' }} /></Form.Item>
                    </Col>
                    <Col xs={24} md={8}>
                      <Form.Item name="disclosureDate" label="合同交底时间"><DatePicker style={{ width: '100%' }} /></Form.Item>
                    </Col>
                    <Col xs={24}>
                      <Form.Item name="complaint" label="投诉情况"><Input.TextArea rows={2} /></Form.Item>
                    </Col>
                  </Row>
                </Form>
              ),
            },
          ]}
        />
      </Modal>

      <Drawer title="合同详情" width={720} open={!!detail} onClose={() => setDetail(null)}>
        {detail ? (
          <Tabs
            items={[
              {
                key: 'info',
                label: '合同信息',
                children: (
                  <Descriptions column={2} size="small" bordered>
                    <Descriptions.Item label="合同编号">{detail.code}</Descriptions.Item>
                    <Descriptions.Item label="合同名称">{detail.name}</Descriptions.Item>
                    <Descriptions.Item label="合同类型"><DictTag typeCode="contract_type" value={detail.typeCode} /></Descriptions.Item>
                    <Descriptions.Item label="供应商">{detail.supplier?.name || '-'}</Descriptions.Item>
                    <Descriptions.Item label="法人">{detail.supplier?.legalPerson || '-'}</Descriptions.Item>
                    <Descriptions.Item label="授权人">{detail.supplier?.contractAuthPerson || '-'}</Descriptions.Item>
                    <Descriptions.Item label="联系人">{detail.supplier?.contactName || '-'}</Descriptions.Item>
                    <Descriptions.Item label="联系人电话">{detail.supplier?.contactPhone || '-'}</Descriptions.Item>
                    <Descriptions.Item label="合同额">{money(detail.amount)}</Descriptions.Item>
                    <Descriptions.Item label="税率">{detail.taxRate != null ? `${(Number(detail.taxRate) * 100).toFixed(2)}%` : '-'}</Descriptions.Item>
                    <Descriptions.Item label="签订日期">{detail.signDate?.slice(0, 10)}</Descriptions.Item>
                    <Descriptions.Item label="执行情况"><DictTag typeCode="contract_execution_status" value={detail.execStatus} /></Descriptions.Item>
                    <Descriptions.Item label="备注" span={2}>{detail.remark || '-'}</Descriptions.Item>
                    {detail.attachments?.length ? (
                      <Descriptions.Item label="附件" span={2}>
                        {detail.attachments.map((a: any) => (
                          <Tag key={a.id}><a href={a.url} target="_blank" rel="noreferrer">{a.fileName}</a></Tag>
                        ))}
                      </Descriptions.Item>
                    ) : null}
                  </Descriptions>
                ),
              },
              {
                key: 'changes',
                label: `变更记录（${changes.length}）`,
                children: (
                  <Table
                    rowKey="id"
                    size="small"
                    dataSource={changes}
                    pagination={false}
                    columns={[
                      { title: '字段', dataIndex: 'fieldLabel' },
                      { title: '变更前', dataIndex: 'beforeValue' },
                      { title: '变更后', dataIndex: 'afterValue' },
                      { title: '操作人', dataIndex: 'operator' },
                      { title: '时间', dataIndex: 'createdAt', render: (v) => v?.slice(0, 19).replace('T', ' ') },
                    ]}
                  />
                ),
              },
            ]}
          />
        ) : (
          <Spin />
        )}
      </Drawer>
    </Card>
  );
}
