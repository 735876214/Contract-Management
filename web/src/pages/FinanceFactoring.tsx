import { useCallback, useEffect, useState } from 'react';
import { withToken } from '../utils/download';
import { Button, Form, Input, InputNumber, Select, Space, Modal, message, DatePicker, Table, Row, Col } from 'antd';
import { PlusOutlined, ExportOutlined } from '@ant-design/icons';
import dayjs from 'dayjs';
import { financeApi } from '@/api/modules';
import { contractApi } from '@/api/business';
import ModuleListPage, { type ModuleListFilterField, type ModuleListRow } from '@/components/procurement/ModuleListPage';
import EditorTabPage from '@/components/editor/EditorTabPage';
import ContractFundParams from '@/components/finance/ContractFundParams';
import { useEditorTab, useTabRefresh } from '@/hooks/useTabs';

const money = (v: any) =>
  v === null || v === undefined || v === '' ? '-' : Number(v).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

const dateStr = (v: any) => (v ? dayjs(v).format('YYYY-MM-DD') : '-');

/**
 * 保理费用台账（业务口径 2026-10-16 由「资金费用台账」拆出的独立模块）。
 *
 * 拆分的理由：原页面是「选合同 → 双 Tab（保理 / 逾期）」，两张表结构完全不同，
 * 挤在一个页面里既不好对照结算台账的样式，也没法分别给菜单与权限。
 * 现在两页共用 `ModuleListPage` 标准骨架（筛选卡 + 工具条 + 合计行 + 分页 + 列设置），
 * 与结算台账/合同台账观感一致。
 *
 * 列表与「新增/编辑」是同一路由的两种形态（`?editor=new|<id>`），见 `useEditorTab` 的注释。
 */
const LIST_PATH = '/settlement/factoring';

export default function FinanceFactoring() {
  const [contracts, setContracts] = useState<any[]>([]);
  useEffect(() => {
    contractApi.options().then((res: any) => setContracts(res || []));
  }, []);
  const contractOptions = contracts.map((c) => ({ value: c.id, label: `${c.code} ${c.name}` }));

  const editorTab = useEditorTab(LIST_PATH);
  if (editorTab.isEditor) {
    return <FactoringEditor contractOptions={contractOptions} seed={editorTab.seed} />;
  }
  return <FactoringList contractOptions={contractOptions} />;
}

function FactoringList({ contractOptions }: { contractOptions: any[] }) {
  const editorTab = useEditorTab(LIST_PATH);
  const tabRefresh = useTabRefresh(LIST_PATH);
  const [contractId, setContractId] = useState('');
  const [totals, setTotals] = useState<any>({});
  const [listRefresh, setListRefresh] = useState(0);
  const refreshList = () => setListRefresh((k) => k + 1);

  /** 未选合同时不去打接口（后端按合同取数，没有合同可查），直接给空结果 */
  const fetcher = useCallback(
    async (params: Record<string, any>) => {
      if (!params.contractId) return { list: [], total: 0 };
      return financeApi.factoring(params.contractId, params);
    },
    [],
  );

  const handleRemove = (row: ModuleListRow) => {
    Modal.confirm({
      title: '确认删除该保理费用记录？',
      okText: '确认删除',
      okType: 'danger',
      onOk: async () => {
        await financeApi.removeFactoring(row.id);
        message.success('已删除');
        refreshList();
      },
    });
  };

  const extraFilters: ModuleListFilterField[] = [
    {
      key: 'contractId',
      label: '合同（供应商）',
      control: 'select',
      options: contractOptions,
      placeholder: '请选择合同',
    },
    { key: 'settlementMonth', label: '结算月份', control: 'input', placeholder: 'YYYY-MM' },
    { key: 'keyword', label: '关键词', control: 'input', placeholder: '备注' },
  ];

  const extraColumns: any[] = [
    { title: '序号', dataIndex: 'seqNo', width: 60, fixed: 'left' },
    { title: '融资到账时间', dataIndex: 'financingDate', width: 120, render: dateStr },
    { title: '融资金额', dataIndex: 'financingAmount', width: 120, align: 'right' as const, render: money },
    { title: '实际到账金额', dataIndex: 'actualReceipt', width: 130, align: 'right' as const, render: money },
    { title: '融资利息', dataIndex: 'financingInterest', width: 110, align: 'right' as const, render: money },
    { title: '手续费', dataIndex: 'handlingFee', width: 100, align: 'right' as const, render: money },
    {
      title: '费用合计（含税）',
      dataIndex: 'totalCost',
      width: 140,
      align: 'right' as const,
      render: (v: any) => <b>{money(v)}</b>,
    },
    { title: '结算月份', dataIndex: 'settlementMonth', width: 110 },
    { title: '备注', dataIndex: 'remark', width: 200, ellipsis: true, render: (v: any) => v || '-' },
  ];

  return (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      {contractId && <ContractFundParams contractId={contractId} />}

      <ModuleListPage
        mode="generic"
        columnConfigKey="finance.factoring"
        fetcher={fetcher}
        extraFilters={extraFilters}
        extraColumns={extraColumns}
        refreshKey={listRefresh + tabRefresh}
        emptyText={contractId ? '暂无保理费用记录' : '请先在筛选区选择合同'}
        autoSearchOnChange={['contractId']}
        onFilterChange={(values, changed) => {
          if ('contractId' in changed) setContractId(values.contractId ?? '');
        }}
        onFetched={(res: any) => setTotals(res?.totals ?? {})}
        tableSummary={
          <Table.Summary fixed>
            <Table.Summary.Row style={{ fontWeight: 600 }}>
              <Table.Summary.Cell index={0}>合计</Table.Summary.Cell>
              <Table.Summary.Cell index={1} />
              <Table.Summary.Cell index={2} align="right">{money(totals.financingAmount)}</Table.Summary.Cell>
              <Table.Summary.Cell index={3} align="right">{money(totals.actualReceipt)}</Table.Summary.Cell>
              <Table.Summary.Cell index={4} align="right">{money(totals.financingInterest)}</Table.Summary.Cell>
              <Table.Summary.Cell index={5} align="right">{money(totals.handlingFee)}</Table.Summary.Cell>
              <Table.Summary.Cell index={6} align="right">{money(totals.totalCost)}</Table.Summary.Cell>
              <Table.Summary.Cell index={7} colSpan={3} />
            </Table.Summary.Row>
          </Table.Summary>
        }
        onEdit={(row) => editorTab.openEdit(row.id, row)}
        onDelete={handleRemove}
        toolbarLeft={
          <Space wrap size={8}>
            <Button
              type="primary"
              icon={<PlusOutlined />}
              disabled={!contractId}
              onClick={() => editorTab.openCreate()}
            >
              新增记录
            </Button>
            <Button
              icon={<ExportOutlined />}
              disabled={!contractId}
              onClick={() => window.open(withToken(financeApi.exportFactoringUrl(contractId)))}
            >
              导出 Excel
            </Button>
          </Space>
        }
      />
    </Space>
  );
}

/** 保理「新增/编辑」（表单正文从改造前的弹窗原样搬入，字段与校验规则未动） */
function FactoringEditor({ contractOptions, seed }: { contractOptions: any[]; seed: unknown }) {
  const [form] = Form.useForm();
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  const editing = seed as any | undefined;

  useEffect(() => {
    form.resetFields();
    if (editing) {
      form.setFieldsValue({ ...editing, financingDate: editing.financingDate ? dayjs(editing.financingDate) : null });
    }
    setDirty(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editing]);

  const submit = async () => {
    const values = await form.validateFields();
    const data = {
      ...values,
      financingDate: values.financingDate ? values.financingDate.format('YYYY-MM-DD') : null,
      // 乐观锁：编辑态必须回传 version，否则后端 assertVersion 抛 409
      version: editing ? (editing as any).version : undefined,
    };
    setSaving(true);
    try {
      if (editing) await financeApi.updateFactoring(editing.id, data);
      else await financeApi.createFactoring(data);
      message.success('保存成功');
    } finally {
      setSaving(false);
    }
  };

  return (
    <EditorTabPage
      listPath={LIST_PATH}
      title={editing ? '编辑保理费用' : '新增保理费用'}
      saving={saving}
      dirty={dirty}
      onSave={submit}
    >
      <Form form={form} layout="vertical" onValuesChange={() => setDirty(true)}>
        <Row gutter={16}>
          <Col xs={24} md={12}>
            <Form.Item name="contractId" label="合同" rules={[{ required: true, message: '请选择合同' }]}>
              <Select showSearch optionFilterProp="label" placeholder="请选择合同" options={contractOptions} />
            </Form.Item>
          </Col>
          <Col xs={24} md={12}>
            <Form.Item name="financingDate" label="融资到账时间" rules={[{ required: true, message: '请选择融资到账时间' }]}>
              <DatePicker format="YYYY-MM-DD" style={{ width: '100%' }} />
            </Form.Item>
          </Col>
          <Col xs={24} md={12}>
            <Form.Item name="settlementMonth" label="结算月份">
              <Input placeholder="如 2026-04（已办结算月份）" />
            </Form.Item>
          </Col>
          <Col xs={24} md={12}>
            <Form.Item name="financingAmount" label="融资金额">
              <InputNumber style={{ width: '100%' }} min={0} precision={2} />
            </Form.Item>
          </Col>
          <Col xs={24} md={12}>
            <Form.Item name="actualReceipt" label="实际到账金额">
              <InputNumber style={{ width: '100%' }} min={0} precision={2} />
            </Form.Item>
          </Col>
          <Col xs={24} md={12}>
            <Form.Item name="financingInterest" label="融资利息" rules={[{ required: true, message: '请输入融资利息' }]}>
              <InputNumber style={{ width: '100%' }} min={0} precision={2} />
            </Form.Item>
          </Col>
          <Col xs={24} md={12}>
            <Form.Item name="handlingFee" label="手续费（如有）">
              <InputNumber style={{ width: '100%' }} min={0} precision={2} />
            </Form.Item>
          </Col>
          <Col xs={24} md={12}>
            <Form.Item label="费用合计（含税）" tooltip="融资利息 + 手续费，系统自动计算">
              <InputNumber style={{ width: '100%' }} disabled value={undefined} placeholder="自动计算" />
            </Form.Item>
          </Col>
          <Col xs={24}>
            <Form.Item name="remark" label="备注"><Input.TextArea rows={2} /></Form.Item>
          </Col>
        </Row>
      </Form>
    </EditorTabPage>
  );
}
