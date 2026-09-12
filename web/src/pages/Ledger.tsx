import { useEffect, useMemo, useState } from 'react';
import { withToken } from '../utils/download';
import {
  Button,
  Card,
  Checkbox,
  Col,
  Input,
  Modal,
  Row,
  Space,
  Statistic,
  message,
} from 'antd';
import { ExportOutlined, SettingOutlined } from '@ant-design/icons';
import { ledgerApi } from '@/api/modules';
import { supplierApi } from '@/api/business';
import DictSelect from '@/components/DictSelect';
import ModuleListPage, { type ModuleListFilterField, type ModuleListRow } from '@/components/procurement/ModuleListPage';
import { useDictStore } from '@/store/dict';

const money = (v: any) =>
  v == null ? '-' : '¥' + Number(v).toLocaleString('zh-CN', { maximumFractionDigits: 2 });

const COMPLIANCE_OPTIONS = [
  '无问题',
  '未招标进场',
  '未定标进场',
  '未签合同进场',
  '未签合同先进场',
  '时间数据不完整',
];

const renderYearMap = (v: any) => {
  if (!v || typeof v !== 'object') return '-';
  return Object.entries(v)
    .map(([y, a]) => `${y}: ${money(a as any)}`)
    .join('  ');
};

const renderCompliance = (v: any) => {
  if (!v || v === '无问题') return <span style={{ color: '#52c41a' }}>无问题</span>;
  if (v === '时间数据不完整') return <span style={{ color: '#faad14' }}>时间数据不完整</span>;
  return <span style={{ color: '#ff4d4f' }}>{v}</span>;
};

const renderCell = (key: string, v: any) => {
  if (key === 'taxRate') return v == null ? '-' : `${v}%`;
  if (/amount$/i.test(key) || /debt/i.test(key) || key === 'amount') return money(v);
  if (key === 'yearSettle' || key === 'yearPaid') return renderYearMap(v);
  if (key === 'compliance') return renderCompliance(v);
  return v == null || v === '' ? '-' : v;
};

/**
 * 合同台账（问题四：统一标准列表页规约）
 * - 顶部统计卡片 + 标准筛选区/工具栏/表格/分页
 * - 动态列由服务端返回（含列可见性配置），「列设置」保存后刷新
 * - 台账为只读查询页，不展示行操作列
 */
export default function Ledger() {
  const ensure = useDictStore((s) => s.ensure);
  const [suppliers, setSuppliers] = useState<any[]>([]);
  const [columns, setColumns] = useState<any[]>([]);
  const [summary, setSummary] = useState<any>(null);
  const [colModal, setColModal] = useState(false);
  const [colChecked, setColChecked] = useState<string[]>([]);
  const [listRefresh, setListRefresh] = useState(0);

  /** 标准列表数据源：台账接口返回 { list, total, columns }，columns 用于动态列渲染 */
  const fetcher = useMemo(
    () => async (params: Record<string, any>) => {
      const res: any = await ledgerApi.contracts(params);
      if (res?.columns) setColumns(res.columns);
      return res;
    },
    [],
  );

  useEffect(() => {
    ensure(['contract_type', 'contract_execution_status', 'supplier_category']);
    supplierApi.options().then((res: any) => setSuppliers(res || []));
    ledgerApi.summary().then((res: any) => setSummary(res)).catch(() => setSummary(null));
  }, []);

  const buildColumns = (cols: any[]) =>
    cols
      .filter((c) => c.visible)
      .map((c) => ({
        title: c.title,
        dataIndex: c.key,
        key: c.key,
        width: c.width || 140,
        render: (v: any) => renderCell(c.key, v),
      }));

  const tableColumns = useMemo(() => buildColumns(columns), [columns]);

  const openColModal = () => {
    setColChecked(columns.filter((c) => c.visible).map((c) => c.key));
    setColModal(true);
  };

  const saveCols = async () => {
    const config: Record<string, boolean> = {};
    columns.forEach((c) => {
      config[c.key] = colChecked.includes(c.key);
    });
    await ledgerApi.saveColumns(config);
    message.success('列设置已保存');
    setColModal(false);
    setListRefresh((k) => k + 1);
  };

  /** 筛选项（问题四：标准筛选区） */
  const extraFilters: ModuleListFilterField[] = [
    { key: 'code', label: '合同编号', control: 'input' },
    {
      key: 'supplierId',
      label: '供应商',
      control: 'select',
      options: suppliers.map((s) => ({ value: s.id, label: s.name })),
      placeholder: '全部',
    },
    { key: 'type', label: '合同类型', control: 'input', render: () => <DictSelect typeCode="contract_type" placeholder="全部" /> },
    { key: 'executionStatus', label: '合同执行情况', control: 'input', render: () => <DictSelect typeCode="contract_execution_status" placeholder="全部" /> },
    { key: 'compliance', label: '合规性问题', control: 'select', options: COMPLIANCE_OPTIONS.map((o) => ({ value: o, label: o })) },
    { key: 'category', label: '分供方类别', control: 'input', render: () => <DictSelect typeCode="supplier_category" placeholder="全部" /> },
    { key: 'keyword', label: '关键词', control: 'input' },
  ];

  return (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      {summary && (
        <Row gutter={16}>
          <Col xs={12} md={8} lg={4}>
            <Card size="small"><Statistic title="合同数量" value={summary.contractCount ?? 0} /></Card>
          </Col>
          <Col xs={12} md={8} lg={4}>
            <Card size="small"><Statistic title="合同总额" value={money(summary.contractAmount)} /></Card>
          </Col>
          <Col xs={12} md={8} lg={4}>
            <Card size="small"><Statistic title="开累结算" value={money(summary.settleAmount)} /></Card>
          </Col>
          <Col xs={12} md={8} lg={4}>
            <Card size="small"><Statistic title="开累付款" value={money(summary.paidAmount)} /></Card>
          </Col>
          <Col xs={12} md={8} lg={4}>
            <Card size="small"><Statistic title="应付款" value={money(summary.payableAmount)} /></Card>
          </Col>
          <Col xs={12} md={8} lg={4}>
            <Card size="small"><Statistic title="100%欠款" value={money(summary.debt100)} /></Card>
          </Col>
          <Col xs={12} md={8} lg={4}>
            <Card size="small"><Statistic title="合规问题数" value={summary.complianceIssues ?? 0} /></Card>
          </Col>
        </Row>
      )}

      <ModuleListPage
        mode="generic"
        fetcher={fetcher}
        extraFilters={extraFilters}
        extraColumns={tableColumns as any}
        refreshKey={listRefresh}
        showOpColumn={false}
        emptyText="暂无合同台账数据"
        toolbarLeft={
          <Space wrap size={8}>
            <Button icon={<ExportOutlined />} onClick={() => window.open(withToken(ledgerApi.exportUrl()))}>
              导出
            </Button>
            <Button icon={<SettingOutlined />} onClick={openColModal}>
              列设置
            </Button>
          </Space>
        }
      />

      <Modal
        title="列设置"
        open={colModal}
        onOk={saveCols}
        onCancel={() => setColModal(false)}
        destroyOnClose
      >
        <Checkbox.Group
          value={colChecked}
          onChange={(vals) => setColChecked(vals as string[])}
          style={{ display: 'flex', flexDirection: 'column', gap: 8 }}
        >
          {columns.map((c) => (
            <Checkbox key={c.key} value={c.key}>
              {c.title}
            </Checkbox>
          ))}
        </Checkbox.Group>
      </Modal>
    </Space>
  );
}
