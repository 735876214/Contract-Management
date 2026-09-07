import { useEffect, useMemo, useState } from 'react';
import {
  Card,
  Table,
  Button,
  Form,
  Input,
  Select,
  Space,
  Modal,
  Checkbox,
  Row,
  Col,
  Statistic,
  Tag,
  message,
} from 'antd';
import { SettingOutlined, ExportOutlined, SearchOutlined } from '@ant-design/icons';
import { ledgerApi } from '@/api/modules';
import { supplierApi } from '@/api/business';
import DictSelect from '@/components/DictSelect';
import { useTable } from '@/hooks/useTable';
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
  if (!v || v === '无问题') return <Tag color="green">无问题</Tag>;
  if (v === '时间数据不完整') return <Tag color="gold">时间数据不完整</Tag>;
  return <Tag color="red">{v}</Tag>;
};

const renderCell = (key: string, v: any) => {
  if (key === 'taxRate') return v == null ? '-' : `${v}%`;
  if (/amount$/i.test(key) || /debt/i.test(key) || key === 'amount') return money(v);
  if (key === 'yearSettle' || key === 'yearPaid') return renderYearMap(v);
  if (key === 'compliance') return renderCompliance(v);
  return v == null || v === '' ? '-' : v;
};

export default function Ledger() {
  const ensure = useDictStore((s) => s.ensure);
  const [suppliers, setSuppliers] = useState<any[]>([]);
  const [columns, setColumns] = useState<any[]>([]);
  const [summary, setSummary] = useState<any>(null);
  const [colModal, setColModal] = useState(false);
  const [colChecked, setColChecked] = useState<string[]>([]);
  const [queryForm] = Form.useForm();

  const { loading, list, pagination, search, reload } = useTable<any>(async (p) => {
    const res: any = await ledgerApi.contracts(p);
    if (res?.columns) setColumns(res.columns);
    return res;
  });

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
    reload();
  };

  return (
    <Card
      title="合同台账"
      extra={
        <Space>
          <Button icon={<ExportOutlined />} onClick={() => window.open(ledgerApi.exportUrl())}>
            导出
          </Button>
          <Button icon={<SettingOutlined />} onClick={openColModal}>
            列设置
          </Button>
        </Space>
      }
    >
      {summary && (
        <Row gutter={16} style={{ marginBottom: 16 }}>
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

      <Form layout="inline" style={{ marginBottom: 16, rowGap: 8 }} form={queryForm} onFinish={(v) => search(v)}>
        <Form.Item name="code"><Input placeholder="合同编号" allowClear prefix={<SearchOutlined />} /></Form.Item>
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
        <Form.Item name="type"><DictSelect typeCode="contract_type" placeholder="合同类型" /></Form.Item>
        <Form.Item name="executionStatus">
          <DictSelect typeCode="contract_execution_status" placeholder="合同执行情况" />
        </Form.Item>
        <Form.Item name="compliance">
          <Select
            placeholder="合规性问题"
            allowClear
            style={{ minWidth: 180 }}
            options={COMPLIANCE_OPTIONS.map((o) => ({ value: o, label: o }))}
          />
        </Form.Item>
        <Form.Item name="category">
          <DictSelect typeCode="supplier_category" placeholder="分供方类别" />
        </Form.Item>
        <Form.Item name="keyword"><Input placeholder="关键词" allowClear /></Form.Item>
        <Form.Item><Button type="primary" htmlType="submit">查询</Button></Form.Item>
        <Form.Item><Button onClick={() => { queryForm.resetFields(); search({}); }}>重置</Button></Form.Item>
      </Form>

      <Table
        rowKey="id"
        loading={loading}
        dataSource={list}
        pagination={pagination}
        scroll={{ x: 4000 }}
        columns={tableColumns}
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
    </Card>
  );
}
