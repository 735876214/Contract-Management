import { useEffect, useState } from 'react';
import {
  Card,
  Table,
  Button,
  Form,
  Input,
  InputNumber,
  Select,
  DatePicker,
  Space,
  Modal,
  Popconfirm,
  message,
  Tag,
} from 'antd';
import { PlusOutlined, ExportOutlined, SearchOutlined, DeleteOutlined } from '@ant-design/icons';
import dayjs from 'dayjs';
import { repaymentApi } from '@/api/modules';
import { supplierApi, contractApi } from '@/api/business';
import { useTable } from '@/hooks/useTable';

const money = (v: any) =>
  v == null || v === '' ? '-' : '¥' + Number(v).toLocaleString('zh-CN', { maximumFractionDigits: 2 });

const fmtDate = (v: any) => (v ? String(v).slice(0, 10) : '-');

export default function Repayments() {
  const [suppliers, setSuppliers] = useState<any[]>([]);
  const [contracts, setContracts] = useState<any[]>([]);
  const [modal, setModal] = useState(false);
  const [editing, setEditing] = useState<any>(null);
  const [codeStatus, setCodeStatus] = useState<'' | 'error' | 'success'>('');
  const [codeHelp, setCodeHelp] = useState<string>('');
  const [form] = Form.useForm();
  const [queryForm] = Form.useForm();

  const { loading, list, pagination, search, reload } = useTable<any>((p) => repaymentApi.list(p));

  useEffect(() => {
    supplierApi.options().then((res: any) => setSuppliers(res || []));
    contractApi.options().then((res: any) => setContracts(res || []));
  }, []);

  const openCreate = () => {
    setEditing(null);
    setCodeStatus('');
    setCodeHelp('');
    form.resetFields();
    form.setFieldsValue({ details: [{}] });
    setModal(true);
  };

  const openEdit = async (row: any) => {
    setEditing(row);
    setCodeStatus('');
    setCodeHelp('');
    const detail: any = await repaymentApi.detail(row.id);
    form.resetFields();
    // 注意：表单字段名必须与后端 RepaymentAgreement / RepaymentDetail 保持一致
    form.setFieldsValue({
      ...detail,
      signDate: detail.signDate ? dayjs(detail.signDate) : undefined,
      details: (detail.details && detail.details.length ? detail.details : [{}]).map((d: any) => ({
        ...d,
        dueDate: d.dueDate ? dayjs(d.dueDate) : undefined,
      })),
    });
    setModal(true);
  };

  const checkCode = async () => {
    const code = form.getFieldValue('code');
    if (!code) {
      setCodeStatus('');
      setCodeHelp('');
      return;
    }
    const res: any = await repaymentApi.checkCode(code, editing?.id);
    if (res?.exists) {
      setCodeStatus('error');
      setCodeHelp(res?.message || '该协议编号已被占用');
    } else {
      setCodeStatus('success');
      setCodeHelp('');
    }
  };

  const generateCode = async () => {
    const res: any = await repaymentApi.suggestCode();
    if (res?.code) {
      form.setFieldsValue({ code: res.code });
      setCodeStatus('success');
      setCodeHelp('');
    }
  };

  const onSupplierChange = (id: string) => {
    const hit = suppliers.find((s) => s.id === id);
    if (hit?.material) form.setFieldsValue({ material: hit.material });
  };

  const onContractChange = (id: string) => {
    const hit = contracts.find((c) => c.id === id);
    if (hit?.material) form.setFieldsValue({ material: hit.material });
  };

  const submit = async () => {
    const values: any = await form.validateFields();
    const payload = {
      ...values,
      signDate: values.signDate ? dayjs(values.signDate).format('YYYY-MM-DD') : undefined,
      details: (values.details || []).map((d: any) => ({
        ...d,
        dueDate: d.dueDate ? dayjs(d.dueDate).format('YYYY-MM-DD') : undefined,
      })),
    };
    if (editing) await repaymentApi.update(editing.id, payload);
    else await repaymentApi.create(payload);
    message.success('保存成功');
    setModal(false);
    reload();
  };

  return (
    <Card
      title="还款协议管理"
      extra={
        <Space>
          <Button icon={<ExportOutlined />} onClick={() => window.open(repaymentApi.exportUrl())}>导出</Button>
          <Button type="primary" icon={<PlusOutlined />} onClick={openCreate}>新增协议</Button>
        </Space>
      }
    >
      <Form
        layout="inline"
        style={{ marginBottom: 16, rowGap: 8 }}
        form={queryForm}
        onFinish={(v: any) => {
          const { signRange, ...rest } = v || {};
          search({
            ...rest,
            startDate: signRange?.[0] ? dayjs(signRange[0]).format('YYYY-MM-DD') : undefined,
            endDate: signRange?.[1] ? dayjs(signRange[1]).format('YYYY-MM-DD') : undefined,
          });
        }}
      >
        <Form.Item name="code"><Input placeholder="协议编号" allowClear prefix={<SearchOutlined />} /></Form.Item>
        <Form.Item name="supplierId">
          <Select
            placeholder="供应商"
            allowClear
            showSearch
            optionFilterProp="label"
            style={{ minWidth: 180 }}
            options={suppliers.map((s) => ({ value: s.id, label: s.name }))}
          />
        </Form.Item>
        <Form.Item name="signRange">
          <DatePicker.RangePicker placeholder={['签订日期起', '签订日期止']} />
        </Form.Item>
        <Form.Item><Button type="primary" htmlType="submit">查询</Button></Form.Item>
        <Form.Item><Button onClick={() => { queryForm.resetFields(); search({}); }}>重置</Button></Form.Item>
      </Form>

      <Table
        rowKey="id"
        loading={loading}
        dataSource={list}
        pagination={pagination}
        scroll={{ x: 1800 }}
        columns={[
          { title: '协议编号', dataIndex: 'code', width: 180, fixed: 'left' },
          { title: '供应商名称', dataIndex: ['supplier', 'name'], width: 200, render: (v) => v || '-' },
          { title: '供应材料', dataIndex: 'material', width: 160, render: (v) => v || '-' },
          { title: '签订日期', dataIndex: 'signDate', width: 120, render: fmtDate },
          { title: '结算金额', dataIndex: 'settleAmount', width: 140, render: money },
          { title: '协议约定欠款金额', dataIndex: 'agreedDebtAmount', width: 160, render: money },
          { title: '截至签订已付款', dataIndex: 'paidBeforeSign', width: 140, render: money },
          { title: '签订后付款', dataIndex: 'paidAfterSign', width: 130, render: money },
          { title: '到期未付款', dataIndex: 'overdueUnpaid', width: 130, render: money },
          { title: '备注', dataIndex: 'remark', width: 180, ellipsis: true, render: (v) => v || '-' },
          {
            title: '明细条数',
            dataIndex: 'details',
            width: 90,
            render: (v) => (Array.isArray(v) ? v.length : 0),
          },
          {
            title: '操作',
            width: 160,
            fixed: 'right',
            render: (_, row) => (
              <Space size={4}>
                <Button type="link" size="small" onClick={() => openEdit(row)}>编辑</Button>
                <Popconfirm title="确认删除该协议？" onConfirm={async () => { await repaymentApi.remove(row.id); message.success('已删除'); reload(); }}>
                  <Button type="link" size="small" danger>删除</Button>
                </Popconfirm>
              </Space>
            ),
          },
        ]}
      />

      <Modal
        title={editing ? '编辑还款协议' : '新增还款协议'}
        open={modal}
        onOk={submit}
        onCancel={() => setModal(false)}
        width={900}
        destroyOnClose
      >
        <Form form={form} layout="vertical">
          <Form.Item
            label="签订协议编号"
            name="code"
            required
            validateStatus={codeStatus || undefined}
            help={codeHelp || undefined}
            extra={<Button size="small" onClick={generateCode}>生成编号</Button>}
          >
            <Input onChange={checkCode} onBlur={checkCode} placeholder="输入或生成协议编号" />
          </Form.Item>
          <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap' }}>
            <Form.Item label="供应商" name="supplierId" style={{ flex: 1, minWidth: 220 }}>
              <Select
                placeholder="请选择供应商"
                showSearch
                optionFilterProp="label"
                options={suppliers.map((s) => ({ value: s.id, label: s.name }))}
                onChange={onSupplierChange}
              />
            </Form.Item>
            <Form.Item label="关联合同" name="contractId" style={{ flex: 1, minWidth: 220 }}>
              <Select
                placeholder="请选择关联合同"
                showSearch
                optionFilterProp="label"
                options={contracts.map((c) => ({ value: c.id, label: c.name || c.code || c.id }))}
                onChange={onContractChange}
              />
            </Form.Item>
          </div>
          <Form.Item label="供应材料（可修改）" name="material">
            <Input placeholder="自动带出，可修改" />
          </Form.Item>
          <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap' }}>
            <Form.Item label="签订日期" name="signDate" style={{ flex: 1, minWidth: 200 }}>
              <DatePicker style={{ width: '100%' }} />
            </Form.Item>
            <Form.Item label="结算金额" name="settleAmount" style={{ flex: 1, minWidth: 200 }}>
              <InputNumber style={{ width: '100%' }} min={0} precision={2} />
            </Form.Item>
          </div>
          <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap' }}>
            <Form.Item label="协议约定欠款金额" name="agreedDebtAmount" style={{ flex: 1, minWidth: 200 }}>
              <InputNumber style={{ width: '100%' }} min={0} precision={2} />
            </Form.Item>
            <Form.Item label="截至签订已付款" name="paidBeforeSign" style={{ flex: 1, minWidth: 200 }}>
              <InputNumber style={{ width: '100%' }} min={0} precision={2} />
            </Form.Item>
          </div>
          <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap' }}>
            <Form.Item label="签订后付款" name="paidAfterSign" style={{ flex: 1, minWidth: 200 }}>
              <InputNumber style={{ width: '100%' }} min={0} precision={2} />
            </Form.Item>
            <Form.Item label="到期未付款" name="overdueUnpaid" style={{ flex: 1, minWidth: 200 }}>
              <InputNumber style={{ width: '100%' }} min={0} precision={2} />
            </Form.Item>
          </div>
          <Form.Item label="备注" name="remark">
            <Input.TextArea rows={2} />
          </Form.Item>

          <Form.List name="details">
            {(fields, { add, remove }) => (
              <>
                <div style={{ fontWeight: 600, marginBottom: 8 }}>还款明细</div>
                {fields.map((field) => (
                  <Space key={field.key} align="baseline" style={{ display: 'flex', marginBottom: 8 }}>
                    <Form.Item
                      label="约定还款金额"
                      name={[field.name, 'amount']}
                      rules={[{ required: true, message: '请输入金额' }]}
                    >
                      <InputNumber min={0} precision={2} placeholder="金额" style={{ width: 180 }} />
                    </Form.Item>
                    <Form.Item
                      label="约定还款日期"
                      name={[field.name, 'dueDate']}
                      rules={[{ required: true, message: '请选择日期' }]}
                    >
                      <DatePicker style={{ width: 180 }} />
                    </Form.Item>
                    <Form.Item label="期数（可空）" name={[field.name, 'period']}>
                      <InputNumber min={0} placeholder="自动编号" style={{ width: 120 }} />
                    </Form.Item>
                    <Button
                      danger
                      type="text"
                      icon={<DeleteOutlined />}
                      disabled={fields.length <= 1}
                      onClick={() => remove(field.name)}
                    />
                  </Space>
                ))}
                <Button type="dashed" onClick={() => add()} block icon={<PlusOutlined />}>
                  添加明细
                </Button>
              </>
            )}
          </Form.List>
        </Form>
      </Modal>
    </Card>
  );
}
