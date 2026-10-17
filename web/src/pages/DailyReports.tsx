import { useEffect, useState } from 'react';
import { withToken } from '../utils/download';
import { Card, Table, Button, Form, InputNumber, DatePicker, Select, Space } from 'antd';
import { ExportOutlined } from '@ant-design/icons';
import { dailyApi, contractApi, supplierApi } from '@/api/business';
import { dictApi } from '@/api/dict';
import { useTable } from '@/hooks/useTable';
import { useTabRefresh } from '@/hooks/useTabs';
import DictSelect, { DictTag } from '@/components/DictSelect';

const money = (v: number) => (v == null ? '-' : `¥${Number(v).toLocaleString('zh-CN', { maximumFractionDigits: 2 })}`);

type Kind = 'text' | 'number' | 'money' | 'date' | 'dict' | 'contractSelect' | 'supplierSelect' | 'unit';

interface F {
  key: string;
  label: string;
  kind: Kind;
  dict?: string;
  width?: number;
  fixed?: 'left' | 'right';
  /** 整数字段：不加千分位（年份、月份等；数量/金额仍需分位符便于读数） */
  noGroup?: boolean;
}

// 列顺序严格按需求，请勿随意增删（无"合规性问题"列）
// ⚠️ key 必须与 DailyReport 模型字段**逐字一致**（dataIndex 取数）。
//    总日报为纯展示页（数据全部来自收领单推送），本数组只驱动表格列，不再驱动表单。
const FIELDS: F[] = [
  { key: 'periodYear', label: '账期/年', kind: 'number', noGroup: true, width: 90 },
  { key: 'periodMonth', label: '账期/月', kind: 'number', width: 90 },
  { key: 'entryDate', label: '进场日期', kind: 'date', width: 120 },
  { key: 'contractId', label: '合同编号', kind: 'contractSelect', width: 150, fixed: 'left' },
  // 现场确认状态（口径见 .claude/rules/backend-conventions.md「日报/现场确认」）：决定该行是否计入结算口径。
  // 总日报页只读展示；确认/驳回在收领单推送侧完成（receipt-order.service 直接置已确认）
  { key: 'confirmStatusCode', label: '确认状态', kind: 'dict', dict: 'site_confirm_status', width: 110 },
  // 需求 2.1.4：「是否资产」「是否安全物资」由物资基础库带出，总日报只读展示
  { key: 'isAsset', label: '是否资产', kind: 'dict', dict: 'yes_no', width: 100 },
  { key: 'isSafetyMaterial', label: '是否安全物资', kind: 'dict', dict: 'yes_no', width: 120 },
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
  { key: 'unit', label: '计量单位', kind: 'unit', width: 110 },
  { key: 'weighQty', label: '过磅数量/t', kind: 'number', width: 120 },
  { key: 'deductQty', label: '扣重/t', kind: 'number', width: 100 },
  { key: 'settleQty', label: '结算数量', kind: 'number', width: 110 },
  { key: 'isWeighed', label: '是否过磅', kind: 'dict', dict: 'yes_no', width: 100 },
  { key: 'priceBeforeTax', label: '单价/元(税前)', kind: 'number', width: 130 },
  { key: 'taxRate', label: '税率', kind: 'number', width: 90 },
  { key: 'priceAfterTax', label: '单价/元(税后)', kind: 'number', width: 130 },
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
  { key: 'incomePrice', label: '收入单价', kind: 'number', width: 120 },
  { key: 'incomeAmount', label: '收入合价', kind: 'money', width: 140 },
  { key: 'stdPrice', label: '标准单价', kind: 'number', width: 120 },
  { key: 'stdAmount', label: '标准合价', kind: 'money', width: 140 },
];

// ==================== 计量单位（展示用：编码 → 字典名称） ====================

let unitDictCache: { value: string; label: string }[] | null = null;
async function loadUnitDict(): Promise<{ value: string; label: string }[]> {
  if (unitDictCache) return unitDictCache;
  const res: any = await dictApi.options('measurement_unit');
  unitDictCache = (res || []).map((u: any) => ({ value: u.value, label: u.label })).filter((u: any) => u.value);
  return unitDictCache;
}

/**
 * 总日报（纯展示页，2026-10-17 业务口径）：
 * **所有数据来自收领单推送**，本页无新增/修改/删除/导入/现场确认入口，只保留查询与**导出**。
 * （确认状态由收领单推送侧直接置「已确认」，结算闸门仍读该状态；后端接口保留，仅前端收口。）
 */
export default function DailyReports() {
  const [contracts, setContracts] = useState<any[]>([]);
  const [suppliers, setSuppliers] = useState<any[]>([]);
  const [unitDict, setUnitDict] = useState<{ value: string; label: string }[]>(unitDictCache || []);
  const tabRefresh = useTabRefresh('/daily/report');
  const { loading, list, search, reload, pagination } = useTable<any>((p) => dailyApi.list(p));

  useEffect(() => {
    contractApi.options().then((res: any) => setContracts(res || []));
    supplierApi.options().then((res: any) => setSuppliers(res || []));
    loadUnitDict().then(setUnitDict).catch(() => undefined);
  }, []);

  // 收领单等关联页保存后 bump 令牌 → 本（被缓存的）列表标签重新取数
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

  return (
    <Card
      title="总日报"
      extra={
        <Space wrap>
          <Button icon={<ExportOutlined />} onClick={() => window.open(withToken(dailyApi.exportUrl()))}>导出</Button>
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
        columns={columns as any}
      />
    </Card>
  );
}
