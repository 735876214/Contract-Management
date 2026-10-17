import { useEffect, useState } from 'react';
import { withToken } from '../utils/download';
import { Card, Table, Button, Form, Input, Space, Modal, Popconfirm, message, InputNumber, DatePicker, Row, Col, Select, AutoComplete } from 'antd';
import { PlusOutlined, SearchOutlined, ExportOutlined, ImportOutlined } from '@ant-design/icons';
import dayjs from 'dayjs';
import { dailyApi, contractApi, supplierApi } from '@/api/business';
import { dictApi } from '@/api/dict';
import { useTable } from '@/hooks/useTable';
import { useEditorTab, useTabRefresh } from '@/hooks/useTabs';
import DictSelect, { DictTag } from '@/components/DictSelect';
import EditorTabPage from '@/components/editor/EditorTabPage';

const money = (v: number) => (v == null ? '-' : `¥${Number(v).toLocaleString('zh-CN', { maximumFractionDigits: 2 })}`);

type Kind = 'text' | 'number' | 'money' | 'date' | 'dict' | 'contractSelect' | 'supplierSelect' | 'unit';

interface F {
  key: string;
  label: string;
  kind: Kind;
  dict?: string;
  width?: number;
  fixed?: 'left' | 'right';
  step?: number;
  precision?: number;
  /** 整数字段：不加千分位（年份、月份等；数量/金额仍需分位符便于读数） */
  noGroup?: boolean;
  /** 需求 2.1.4：来源为物资基础库的字段，总日报只读展示，不允许手工维护 */
  readonly?: boolean;
}

// 列顺序严格按需求，请勿随意增删（无"合规性问题"列）
// ⚠️ key 必须与 DailyReport 模型字段**逐字一致**：本数组同时驱动表格列（dataIndex）与表单字段（name），
//    错一个字就会出现「表格列空白 + 保存 500」（Prisma 拒绝未知字段）。2026-10-14 修正了 10 处历史错名。
const FIELDS: F[] = [
  { key: 'periodYear', label: '账期/年', kind: 'number', noGroup: true, width: 90 },
  { key: 'periodMonth', label: '账期/月', kind: 'number', width: 90 },
  { key: 'entryDate', label: '进场日期', kind: 'date', width: 120 },
  { key: 'contractId', label: '合同编号', kind: 'contractSelect', width: 150, fixed: 'left' },
  // 现场确认状态（口径见 .claude/rules/backend-conventions.md「日报/现场确认」）：决定该行是否计入结算口径
  { key: 'confirmStatusCode', label: '确认状态', kind: 'dict', dict: 'site_confirm_status', width: 110 },
  // 需求 2.1.4：「是否资产」「是否安全物资」由物资基础库带出，日报只读展示
  { key: 'isAsset', label: '是否资产', kind: 'dict', dict: 'yes_no', width: 100, readonly: true },
  { key: 'isSafetyMaterial', label: '是否安全物资', kind: 'dict', dict: 'yes_no', width: 120, readonly: true },
  { key: 'assetSupervision', label: '资产监管', kind: 'text', width: 120 },
  { key: 'department', label: '部门', kind: 'text', width: 110 },
  { key: 'personnel', label: '人员', kind: 'text', width: 110 },
  { key: 'assetStatus', label: '资产状态', kind: 'dict', dict: 'asset_status', width: 120 },
  { key: 'sourceCode', label: '来源', kind: 'dict', dict: 'material_source', width: 120 },
  { key: 'materialCategory', label: '材料类别', kind: 'dict', dict: 'material_category', width: 130 },
  { key: 'materialType', label: '物资种类', kind: 'dict', dict: 'material_type', width: 130 },
  { key: 'materialName', label: '物资名称', kind: 'text', width: 160 },
  { key: 'steelBrand', label: '钢筋品牌', kind: 'text', width: 120 },
  { key: 'steelCount', label: '钢筋件数', kind: 'number', width: 110 },
  { key: 'spec', label: '规格型号', kind: 'text', width: 150 },
  // 需求 2.3.2：默认带出物资基础库单位，允许手输，但必须存在于字典「measurement_unit」
  { key: 'unit', label: '计量单位', kind: 'unit', width: 110 },
  { key: 'weighQty', label: '过磅数量/t', kind: 'number', step: 0.001, precision: 3, width: 120 },
  { key: 'deductQty', label: '扣重/t', kind: 'number', step: 0.001, precision: 3, width: 100 },
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
  { key: 'laborContract', label: '分包合同', kind: 'text', width: 140 },
  { key: 'usePosition', label: '使用部位', kind: 'text', width: 140 },
  { key: 'isProxy', label: '是否代购', kind: 'dict', dict: 'yes_no', width: 100 },
  { key: 'plateNo', label: '车牌号', kind: 'text', width: 120 },
  { key: 'receiptNo', label: '收领单编号', kind: 'text', width: 140 },
  { key: 'remark', label: '备注', kind: 'text', width: 180 },
  { key: 'subcontractPeriod', label: '分包计价账期', kind: 'text', width: 130 },
  { key: 'incomePrice', label: '收入单价', kind: 'number', step: 0.01, precision: 2, width: 120 },
  { key: 'incomeAmount', label: '收入合价', kind: 'money', width: 140 },
  { key: 'stdPrice', label: '标准单价', kind: 'number', step: 0.01, precision: 2, width: 120 },
  { key: 'stdAmount', label: '标准合价', kind: 'money', width: 140 },
];

// ==================== 计量单位输入（需求 2.3.2：默认带出，可手输，但必须存在于字典） ====================

let unitDictCache: { value: string; label: string }[] | null = null;
async function loadUnitDict(): Promise<{ value: string; label: string }[]> {
  if (unitDictCache) return unitDictCache;
  const res: any = await dictApi.options('measurement_unit');
  unitDictCache = (res || []).map((u: any) => ({ value: u.value, label: u.label })).filter((u: any) => u.value);
  return unitDictCache;
}

/** 输入文本 → 字典编码（同时接受编码与名称；不在字典内返回 null） */
function normalizeUnit(raw: string, dict: { value: string; label: string }[]): string | null {
  const v = String(raw ?? '').trim();
  if (!v) return '';
  const hit = dict.find((d) => d.value === v || d.label === v);
  return hit ? hit.value : null;
}

/** 单位输入：下拉选项来自字典，允许手输，非字典值前端拦截 */
function UnitInput({ value, onChange }: { value?: string; onChange?: (v: string) => void }) {
  const [dict, setDict] = useState<{ value: string; label: string }[]>(unitDictCache || []);
  const [text, setText] = useState<string>('');
  const [invalid, setInvalid] = useState(false);

  useEffect(() => {
    loadUnitDict().then(setDict).catch(() => undefined);
  }, []);
  useEffect(() => {
    const hit = dict.find((d) => d.value === value);
    setText(hit ? hit.label : value || '');
    setInvalid(false);
  }, [value, dict]);

  return (
    <div>
      <AutoComplete
        value={text}
        options={dict.map((d) => ({ value: d.label }))}
        style={{ width: '100%' }}
        placeholder="计量单位（字典内）"
        status={invalid ? 'error' : undefined}
        filterOption={(input, option) => String(option?.value || '').includes(input)}
        onChange={(v) => setText(v ?? '')}
        onBlur={() => {
          const code = normalizeUnit(text, dict);
          if (code === null) {
            setInvalid(true);
            message.error('计量单位不在字典范围内，请先在字典管理中添加');
            return;
          }
          setInvalid(false);
          onChange?.(code);
        }}
      />
      <div style={{ fontSize: 12, color: invalid ? 'var(--cms-error)' : 'var(--cms-muted-soft)', marginTop: 2 }}>
        {invalid ? '不在字典范围内，请先在字典管理中添加' : '默认取物资基础库，可输入字典内其他单位'}
      </div>
    </div>
  );
}

/** 列表与「新增/编辑」是同一路由的两种形态（`?editor=new|<id>`），见 `useEditorTab` 的注释 */
const LIST_PATH = '/daily/report';

export default function DailyReports() {
  const [contracts, setContracts] = useState<any[]>([]);
  const [suppliers, setSuppliers] = useState<any[]>([]);
  const [unitDict, setUnitDict] = useState<{ value: string; label: string }[]>(unitDictCache || []);

  useEffect(() => {
    contractApi.options().then((res: any) => setContracts(res || []));
    supplierApi.options().then((res: any) => setSuppliers(res || []));
    loadUnitDict().then(setUnitDict).catch(() => undefined);
  }, []);

  const editorTab = useEditorTab(LIST_PATH);
  if (editorTab.isEditor) {
    return <DailyEditor contracts={contracts} suppliers={suppliers} seed={editorTab.seed} />;
  }
  return <DailyList contracts={contracts} suppliers={suppliers} unitDict={unitDict} />;
}

function DailyList({
  contracts,
  suppliers,
  unitDict,
}: {
  contracts: any[];
  suppliers: any[];
  unitDict: { value: string; label: string }[];
}) {
  const editorTab = useEditorTab(LIST_PATH);
  const tabRefresh = useTabRefresh(LIST_PATH);
  const { loading, list, search, reload, pagination } = useTable<any>((p) => dailyApi.list(p));
  const [selectedKeys, setSelectedKeys] = useState<string[]>([]);

  // 编辑器标签保存后 bump 令牌 → 本（被缓存的）列表标签重新取数
  useEffect(() => {
    if (tabRefresh) reload();
  }, [tabRefresh, reload]);

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

  /** 现场确认：单条或批量（口径见 .claude/rules/backend-conventions.md「日报/现场确认」） */
  const doConfirm = async (action: 'CONFIRM' | 'REJECT', ids: string[]) => {
    if (!ids.length) {
      message.warning('请先勾选要操作的日报行');
      return;
    }
    try {
      const res: any = await dailyApi.confirm({ ids, action });
      message.success(`已${action === 'CONFIRM' ? '确认' : '驳回'} ${res?.updated ?? ids.length} 条`);
      setSelectedKeys([]);
      reload();
    } catch {
      /* 错误提示由 axios 统一拦截器弹出 */
    }
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
        headers: {
          Authorization: `Bearer ${localStorage.getItem('cms_token')}`,
          'x-project-id': localStorage.getItem('cms_project_id') || '',
        },
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
    if (f.kind === 'unit') {
      return { ...base, render: (v: string) => (v ? unitDict.find((u) => u.value === v)?.label || v : '-') };
    }
    if (f.kind === 'money') return { ...base, render: money };
    if (f.kind === 'date') return { ...base, render: (v: string) => (v ? v.slice(0, 10) : '-') };
    if (f.kind === 'number') {
      return {
        ...base,
        render: (v: any) => (v == null ? '-' : f.noGroup ? String(v) : Number(v).toLocaleString('zh-CN')),
      };
    }
    return base;
  });

  columns.push({
    title: '操作',
    width: 150,
    fixed: 'right',
    render: (_: any, row: any) => (
      <Space size={4}>
        {row.confirmStatusCode === 'CONFIRMED' ? (
          <Button type="link" size="small" danger onClick={() => doConfirm('REJECT', [row.id])}>驳回</Button>
        ) : (
          <Button type="link" size="small" onClick={() => doConfirm('CONFIRM', [row.id])}>确认</Button>
        )}
        <Button type="link" size="small" onClick={() => editorTab.openEdit(row.id, row)}>编辑</Button>
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
        <Space wrap>
          <Button onClick={() => doConfirm('CONFIRM', selectedKeys)} disabled={!selectedKeys.length}>批量确认</Button>
          <Button onClick={() => doConfirm('REJECT', selectedKeys)} disabled={!selectedKeys.length}>批量驳回</Button>
          <Button icon={<ImportOutlined />} onClick={importExcel}>导入</Button>
          <Button icon={<ExportOutlined />} onClick={() => window.open(withToken(dailyApi.exportUrl()))}>导出</Button>
          <Button type="primary" icon={<PlusOutlined />} onClick={() => editorTab.openCreate()}>新增日报</Button>
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
        <Form.Item name="confirmStatusCode"><DictSelect typeCode="site_confirm_status" placeholder="确认状态" /></Form.Item>
        <Form.Item name="assetStatus"><DictSelect typeCode="asset_status" placeholder="资产状态" /></Form.Item>
        <Form.Item name="sourceCode"><DictSelect typeCode="material_source" placeholder="来源" /></Form.Item>
        <Form.Item name="entryDate"><DatePicker.RangePicker format="YYYY-MM-DD" placeholder={['进场起', '进场止']} /></Form.Item>
        <Form.Item><Button type="primary" htmlType="submit">查询</Button></Form.Item>
      </Form>

      <Table
        rowKey="id"
        loading={loading}
        dataSource={list}
        pagination={pagination}
        scroll={{ x: 3300 }}
        rowSelection={{
          selectedRowKeys: selectedKeys,
          onChange: (keys) => setSelectedKeys(keys as string[]),
        }}
        columns={columns as any}
      />
    </Card>
  );
}

function DailyEditor({ contracts, suppliers, seed }: { contracts: any[]; suppliers: any[]; seed: unknown }) {
  const [form] = Form.useForm();
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  /** 列表页递过来的整行；`undefined` = 新增 */
  const editing = seed as any | undefined;

  useEffect(() => {
    form.resetFields();
    if (editing) {
      form.setFieldsValue({ ...editing, entryDate: editing.entryDate ? dayjs(editing.entryDate) : null });
    }
    setDirty(false);
    // 仅在换记录时回填（form 实例稳定）
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editing]);

  const submit = async () => {
    const values = await form.validateFields();
    const payload: any = { ...values };
    if (values.entryDate) payload.entryDate = values.entryDate.format('YYYY-MM-DD');
    // 数值字段转 number
    FIELDS.forEach((f) => {
      if ((f.kind === 'number') && payload[f.key] != null) payload[f.key] = Number(payload[f.key]);
    });
    if (payload.taxRate != null) payload.taxRate = Number(payload.taxRate);
    setSaving(true);
    try {
      if (editing) await dailyApi.update(editing.id, payload);
      else await dailyApi.create(payload);
      message.success('保存成功');
    } finally {
      setSaving(false);
    }
  };

  return (
    <EditorTabPage
      listPath={LIST_PATH}
      title={editing ? '编辑日报' : '新增日报'}
      saving={saving}
      dirty={dirty}
      onSave={submit}
    >
      {/* 表单正文（从改造前的弹窗原样搬入，字段仍由 FIELDS 驱动，未增删） */}
      <Form form={form} layout="vertical" onValuesChange={() => setDirty(true)}>
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
                <Form.Item
                  name={f.key}
                  label={f.readonly ? `${f.label}（物资基础库带出）` : f.label}
                  extra={f.readonly ? '由物资基础库自动带出，无需手工填写' : undefined}
                >
                  <DictSelect typeCode={f.dict!} disabled={f.readonly} />
                </Form.Item>
              )}
              {f.kind === 'unit' && (
                <Form.Item name={f.key} label={f.label}>
                  <UnitInput />
                </Form.Item>
              )}
              {f.kind === 'date' && (
                <Form.Item name={f.key} label={f.label}><DatePicker format="YYYY-MM-DD" style={{ width: '100%' }} /></Form.Item>
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
    </EditorTabPage>
  );
}

