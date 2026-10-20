import { useEffect, useMemo, useState } from 'react';
import { withToken } from '../utils/download';
import {
  Button,
  DatePicker,
  Form,
  Input,
  Select,
  Space,
  Modal,
  message,
  Row,
  Col,
  InputNumber,
} from 'antd';
import { PlusOutlined, ExportOutlined } from '@ant-design/icons';
import { fileApi } from '@/api/auth';
import { paymentApi } from '@/api/modules';
import DictSelect from '@/components/DictSelect';
import { contractApi } from '@/api/business';
import ModuleListPage, { type ModuleListFilterField, type ModuleListRow } from '@/components/procurement/ModuleListPage';
import EditorTabPage from '@/components/editor/EditorTabPage';
import ImportButton from '@/components/ImportButton';
import { useEditorTab, useTabRefresh } from '@/hooks/useTabs';
import dayjs from 'dayjs';

const money = (v: number) =>
  v == null ? '-' : `¥${Number(v).toLocaleString('zh-CN', { maximumFractionDigits: 2 })}`;

/**
 * 付款管理。
 *
 * 列表与「新增/编辑」是**同一个路由的两种形态**：`/settlement/payment`（列表）与
 * `/settlement/payment?editor=new|<id>`（编辑器页签）。表单原样来自改造前的弹窗，
 * 字段与校验未动 —— 只有"外壳"从 Modal 换成了 `EditorTabPage`（见 `useEditorTab` 的注释）。
 */
const LIST_PATH = '/settlement/payment';

export default function Payments() {
  const [contracts, setContracts] = useState<any[]>([]);
  useEffect(() => {
    contractApi.list({ pageSize: 1000 }).then((res: any) => setContracts(res?.list || []));
  }, []);
  const contractOptions = useMemo(
    () => contracts.map((c) => ({ value: c.id, label: `${c.code} ${c.name}` })),
    [contracts],
  );

  const editorTab = useEditorTab(LIST_PATH);
  if (editorTab.isEditor) {
    return <PaymentEditor contractOptions={contractOptions} seed={editorTab.seed} />;
  }
  return <RecordList contractOptions={contractOptions} />;
}

function RecordList({ contractOptions }: { contractOptions: any[] }) {
  const editorTab = useEditorTab(LIST_PATH);
  /** 编辑器标签保存后会 bump 这个令牌 → 本（被缓存的）列表标签重新取数 */
  const tabRefresh = useTabRefresh(LIST_PATH);
  const [listRefresh, setListRefresh] = useState(0);
  const refreshList = () => setListRefresh((k) => k + 1);

  const handleRemove = (row: ModuleListRow) => {
    Modal.confirm({
      title: '确认删除该台账记录？',
      okText: '确认删除',
      okType: 'danger',
      onOk: async () => {
        await paymentApi.removeRecord(row.id);
        message.success('已删除');
        refreshList();
      },
    });
  };

  /** 筛选项（问题四：标准筛选区） */
  const extraFilters: ModuleListFilterField[] = [
    { key: 'contractId', label: '合同', control: 'select', options: contractOptions },
    { key: 'payMonth', label: '付款月份', control: 'input', placeholder: 'YYYY-MM' },
  ];

  /** 表格列（问题四：generic 模式完整列定义） */
  const extraColumns: any[] = [
    { title: '供应商名称', width: 220, fixed: 'left', render: (_v: any, r: any) => r.contract?.supplier?.name || '-' },
    { title: '合同名称', width: 260, render: (_v: any, r: any) => r.contract?.name || '-' },
    { title: '合同编号', width: 160, render: (_v: any, r: any) => r.contract?.code || '-' },
    { title: '付款月份', dataIndex: 'payMonth', width: 110 },
    { title: '本月付款额', dataIndex: 'amount', width: 140, align: 'right', render: money },
    {
      title: '银行回单',
      width: 100,
      render: (_v: any, r: any) =>
        r.receiptUrl ? (
          <a onClick={() => window.open(withToken(r.receiptUrl))}>查看回单</a>
        ) : (
          <span className="cms-hint">未上传</span>
        ),
    },
  ];

  return (
    <ModuleListPage
      mode="generic"
      columnConfigKey="payment.list"
      fetcher={(params) => paymentApi.records(params)}
      extraFilters={extraFilters}
      extraColumns={extraColumns}
      refreshKey={listRefresh + tabRefresh}
      onEdit={(row) => editorTab.openEdit(row.id, row)}
      onDelete={handleRemove}
      toolbarLeft={
        <Space wrap size={8}>
          <ImportButton
            moduleName="付款台账"
            templateUrl={paymentApi.recordsTemplateUrl()}
            uploadUrl={paymentApi.recordsImportUrl()}
            validateUrl={paymentApi.recordsValidateUrl()}
            onDone={refreshList}
          />
          <Button icon={<ExportOutlined />} onClick={() => window.open(withToken(paymentApi.exportRecordsUrl()))}>
            导出台账
          </Button>
          <Button type="primary" icon={<PlusOutlined />} onClick={() => editorTab.openCreate()}>
            新增台账
          </Button>
        </Space>
      }
    />
  );
}

function PaymentEditor({ contractOptions, seed }: { contractOptions: any[]; seed: unknown }) {
  const [form] = Form.useForm();
  const [receiptName, setReceiptName] = useState<string>('');
  /** 回单 URL 用 state 跟踪（而非 render 期读 form.getFieldValue），保证上传后链接立即出现 */
  const [receiptUrl, setReceiptUrl] = useState<string>('');
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  /** 列表页打开编辑器时递过来的整行；`undefined` = 新增 */
  const editing = seed as any | undefined;

  useEffect(() => {
    if (editing) {
      // payDate 后端返回 ISO 字符串，DatePicker 需要 dayjs 对象
      form.setFieldsValue({
        ...editing,
        payDate: editing.payDate ? dayjs(editing.payDate) : undefined,
      });
      // 回单展示名：从 URL 提取文件名
      const url = editing.receiptUrl || '';
      setReceiptName(url ? decodeURIComponent(url.split('/').pop() || '') : '');
      setReceiptUrl(url);
    }
    setDirty(false);
    // 仅在换记录时回填（form 实例稳定，不需要进依赖）
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editing]);

  const submit = async () => {
    const values = await form.validateFields();
    const payload = {
      ...values,
      payDate: values.payDate ? values.payDate.format('YYYY-MM-DD') : null,
    };
    setSaving(true);
    try {
      if (editing) await paymentApi.updateRecord(editing.id, { ...payload, version: editing.version });
      else await paymentApi.createRecord(payload);
      message.success('保存成功');
    } finally {
      setSaving(false);
    }
  };

  return (
    <EditorTabPage
      listPath={LIST_PATH}
      title={editing ? '编辑付款台账' : '新增付款台账'}
      saving={saving}
      dirty={dirty}
      onSave={submit}
    >
      <Form form={form} layout="vertical" onValuesChange={() => setDirty(true)}>
        <Row gutter={16}>
          <Col xs={24} md={12}>
            <Form.Item name="contractId" label="合同" rules={[{ required: true }]}>
              <Select showSearch optionFilterProp="label" allowClear placeholder="请选择合同" options={contractOptions} />
            </Form.Item>
          </Col>
          <Col xs={24} md={12}>
            <Form.Item
              name="payMonth"
              label="付款月份(YYYY-MM)"
              // 台账/看板按字符串精确匹配该字段，写成 2026-9 或 2026/09 会让当月付款静默漏算
              rules={[{ required: true }, { pattern: /^\d{4}-\d{2}$/, message: '格式须为 YYYY-MM，如 2026-09' }]}
            >
              <Input placeholder="如 2026-09" />
            </Form.Item>
          </Col>
          <Col xs={24} md={12}>
            <Form.Item name="amount" label="本月付款额" rules={[{ required: true }]}>
              <InputNumber style={{ width: '100%' }} min={0} precision={2} />
            </Form.Item>
          </Col>
          <Col xs={24} md={12}>
            <Form.Item name="methodCode" label="付款方式">
              <DictSelect typeCode="payment_method" placeholder="请选择付款方式" />
            </Form.Item>
          </Col>
          <Col xs={24} md={12}>
            <Form.Item name="payDate" label="付款日期">
              <DatePicker style={{ width: '100%' }} />
            </Form.Item>
          </Col>
          <Col xs={24} md={12}>
            <Form.Item name="statusCode" label="付款状态" initialValue="PAID">
              <DictSelect typeCode="payment_status" placeholder="请选择付款状态" />
            </Form.Item>
          </Col>
          <Col xs={24} md={12}>
            {/* hidden 注册字段：validateFields 只返回已注册字段，漏掉它回单 URL 永远不入库 */}
            <Form.Item name="receiptUrl" hidden>
              <Input />
            </Form.Item>
            <Form.Item label="银行回单" extra="支持 pdf/jpg/png；上传后保存即关联到本条付款记录">
              <Input
                value={receiptName || undefined}
                placeholder="未上传"
                readOnly
                addonAfter={
                  <label style={{ cursor: 'pointer' }}>
                    上传
                    <input
                      type="file"
                      accept=".pdf,.jpg,.jpeg,.png"
                      style={{ display: 'none' }}
                      onChange={async (e) => {
                        const f = e.target.files?.[0];
                        if (!f) return;
                        try {
                          const files = await fileApi.upload([f]);
                          form.setFieldsValue({ receiptUrl: files[0].url });
                          setReceiptUrl(files[0].url);
                          setReceiptName(files[0].fileName);
                          setDirty(true);
                          message.success('回单已上传，保存后生效');
                        } catch (err: any) {
                          message.error(err?.message || '上传失败');
                        }
                      }}
                    />
                  </label>
                }
              />
            </Form.Item>
            {receiptUrl && (
              <a style={{ display: 'block', marginBottom: 12 }} onClick={() => window.open(withToken(receiptUrl))}>
                下载银行回单
              </a>
            )}
          </Col>
          <Col xs={24}>
            <Form.Item name="remark" label="备注">
              <Input.TextArea rows={2} placeholder="备注" />
            </Form.Item>
          </Col>
        </Row>
      </Form>
    </EditorTabPage>
  );
}
