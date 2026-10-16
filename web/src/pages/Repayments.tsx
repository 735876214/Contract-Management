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
  Popconfirm,
  message,
} from 'antd';
import { PlusOutlined, ExportOutlined, SearchOutlined, DeleteOutlined } from '@ant-design/icons';
import dayjs from 'dayjs';
import { withToken } from '../utils/download';
import { repaymentApi } from '@/api/modules';
import { supplierApi, contractApi } from '@/api/business';
import { useTable } from '@/hooks/useTable';
import EditorTabPage from '@/components/editor/EditorTabPage';
import { useEditorTab, useTabRefresh } from '@/hooks/useTabs';

const money = (v: any) =>
  v == null || v === '' ? '-' : '¥' + Number(v).toLocaleString('zh-CN', { maximumFractionDigits: 2 });

const fmtDate = (v: any) => (v ? String(v).slice(0, 10) : '-');

/** 列表与「新增/编辑」是同一路由的两种形态（`?editor=new|<id>`），见 `useEditorTab` 的注释 */
const LIST_PATH = '/repayment';

export default function Repayments() {
  const [suppliers, setSuppliers] = useState<any[]>([]);
  const [contracts, setContracts] = useState<any[]>([]);
  useEffect(() => {
    supplierApi.options().then((res: any) => setSuppliers(res || []));
    contractApi.options().then((res: any) => setContracts(res || []));
  }, []);

  const editorTab = useEditorTab(LIST_PATH);
  if (editorTab.isEditor) {
    return <RepaymentEditor suppliers={suppliers} contracts={contracts} seed={editorTab.seed} />;
  }
  return <RepaymentList suppliers={suppliers} />;
}

function RepaymentList({ suppliers }: { suppliers: any[] }) {
  const editorTab = useEditorTab(LIST_PATH);
  const tabRefresh = useTabRefresh(LIST_PATH);
  const [queryForm] = Form.useForm();
  const { loading, list, pagination, search, reload } = useTable<any>((p) => repaymentApi.list(p));

  // 编辑器标签保存后 bump 令牌 → 本（被缓存的）列表标签重新取数
  useEffect(() => {
    if (tabRefresh) reload();
  }, [tabRefresh, reload]);

  return (
    <Card
      title="还款协议管理"
      extra={
        <Space>
          <Button icon={<ExportOutlined />} onClick={() => window.open(withToken(repaymentApi.exportUrl()))}>
            导出
          </Button>
          <Button type="primary" icon={<PlusOutlined />} onClick={() => editorTab.openCreate()}>
            新增协议
          </Button>
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
          <DatePicker.RangePicker format="YYYY-MM-DD" placeholder={['签订日期起', '签订日期止']} />
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
                <Button type="link" size="small" onClick={() => editorTab.openEdit(row.id)}>编辑</Button>
                <Popconfirm
                  title="确认删除该协议？"
                  onConfirm={async () => {
                    await repaymentApi.remove(row.id);
                    message.success('已删除');
                    reload();
                  }}
                >
                  <Button type="link" size="small" danger>删除</Button>
                </Popconfirm>
              </Space>
            ),
          },
        ]}
      />
    </Card>
  );
}

function RepaymentEditor({
  suppliers,
  contracts,
  seed,
}: {
  suppliers: any[];
  contracts: any[];
  seed: unknown;
}) {
  const [form] = Form.useForm();
  const [saving, setSaving] = useState(false);
  const [loading, setLoading] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [codeStatus, setCodeStatus] = useState<'' | 'error' | 'success'>('');
  const [codeHelp, setCodeHelp] = useState<string>('');
  /** 列表页递过来的整行；有 id 时按 id 拉详情（编辑器标签与列表是两个独立实例，拿不到列表的 state） */
  const editingId = (seed as any)?.id as string | undefined;

  useEffect(() => {
    const load = async () => {
      form.resetFields();
      if (!editingId) {
        form.setFieldsValue({ details: [{}] });
        return;
      }
      setLoading(true);
      try {
        const detail: any = await repaymentApi.detail(editingId);
        // 注意：表单字段名必须与后端 RepaymentAgreement / RepaymentDetail 保持一致
        form.setFieldsValue({
          ...detail,
          signDate: detail.signDate ? dayjs(detail.signDate) : undefined,
          details: (detail.details && detail.details.length ? detail.details : [{}]).map((d: any) => ({
            ...d,
            dueDate: d.dueDate ? dayjs(d.dueDate) : undefined,
          })),
        });
      } finally {
        setLoading(false);
      }
    };
    load();
    setDirty(false);
    setCodeStatus('');
    setCodeHelp('');
    // 仅在换记录时回填（form 实例稳定）
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editingId]);

  const checkCode = async () => {
    const code = form.getFieldValue('code');
    if (!code) {
      setCodeStatus('');
      setCodeHelp('');
      return;
    }
    const res: any = await repaymentApi.checkCode(code, editingId);
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
    setSaving(true);
    try {
      if (editingId) await repaymentApi.update(editingId, payload);
      else await repaymentApi.create(payload);
      message.success('保存成功');
    } finally {
      setSaving(false);
    }
  };

  return (
    <EditorTabPage
      listPath={LIST_PATH}
      title={editingId ? '编辑还款协议' : '新增还款协议'}
      saving={saving}
      dirty={dirty}
      onSave={submit}
    >
      <EditorBody
        form={form}
        loading={loading}
        codeStatus={codeStatus}
        codeHelp={codeHelp}
        suppliers={suppliers}
        contracts={contracts}
        onCheckCode={checkCode}
        onGenerateCode={generateCode}
        onSupplierChange={onSupplierChange}
        onContractChange={onContractChange}
        onDirty={() => setDirty(true)}
      />
    </EditorTabPage>
  );
}

/** 表单正文（从改造前的弹窗原样搬入，字段与校验规则未动） */
function EditorBody({
  form,
  loading,
  codeStatus,
  codeHelp,
  suppliers,
  contracts,
  onCheckCode,
  onGenerateCode,
  onSupplierChange,
  onContractChange,
  onDirty,
}: any) {
  return (
    <Form form={form} layout="vertical" disabled={loading} onValuesChange={onDirty}>
      <Form.Item
        label="签订协议编号"
        name="code"
        required
        validateStatus={codeStatus || undefined}
        help={codeHelp || undefined}
        extra={<Button size="small" onClick={onGenerateCode}>生成编号</Button>}
      >
        <Input onChange={onCheckCode} onBlur={onCheckCode} placeholder="输入或生成协议编号" />
      </Form.Item>
      <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap' }}>
        <Form.Item label="供应商" name="supplierId" style={{ flex: 1, minWidth: 220 }}>
          <Select
            placeholder="请选择供应商"
            showSearch
            optionFilterProp="label"
            options={suppliers.map((s: any) => ({ value: s.id, label: s.name }))}
            onChange={onSupplierChange}
          />
        </Form.Item>
        <Form.Item label="关联合同" name="contractId" style={{ flex: 1, minWidth: 220 }}>
          <Select
            placeholder="请选择关联合同"
            showSearch
            optionFilterProp="label"
            options={contracts.map((c: any) => ({ value: c.id, label: c.name || c.code || c.id }))}
            onChange={onContractChange}
          />
        </Form.Item>
      </div>
      <Form.Item label="供应材料（可修改）" name="material">
        <Input placeholder="自动带出，可修改" />
      </Form.Item>
      <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap' }}>
        <Form.Item label="签订日期" name="signDate" style={{ flex: 1, minWidth: 200 }}>
          <DatePicker format="YYYY-MM-DD" style={{ width: '100%' }} />
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
                  <DatePicker format="YYYY-MM-DD" style={{ width: 180 }} />
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
  );
}
