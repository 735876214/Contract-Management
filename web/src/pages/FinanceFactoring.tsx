import { useCallback, useEffect, useState } from 'react';
import { withToken } from '../utils/download';
import {
  Button,
  Card,
  Form,
  Input,
  InputNumber,
  Select,
  Space,
  Modal,
  message,
  DatePicker,
  Table,
  Row,
  Col,
  Statistic,
} from 'antd';
import { PlusOutlined, ExportOutlined } from '@ant-design/icons';
import dayjs from 'dayjs';
import { financeApi } from '@/api/modules';
import { contractApi } from '@/api/business';
import ModuleListPage, { type ModuleListFilterField, type ModuleListRow } from '@/components/procurement/ModuleListPage';
import EditorTabPage from '@/components/editor/EditorTabPage';
import ContractFundParams from '@/components/finance/ContractFundParams';
import { useEditorTab, useTabRefresh } from '@/hooks/useTabs';
import Can from '@/components/Can';

/** 金额口径与「结算台账」一致：`¥` 前缀 + 千分位（最多两位小数），空值显示 `-` */
const money = (v: any) =>
  v === null || v === undefined || v === '' ? '-' : `¥${Number(v).toLocaleString('zh-CN', { maximumFractionDigits: 2 })}`;

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
    // 新增态的 seed 只是「从列表带过来的预填值」（如已筛选的合同），不是整行记录 ——
    // 靠 editorId 而不是 seed 的真假来分新增/编辑，否则带预填值的新增会被当成编辑。
    return (
      <FactoringEditor
        contractOptions={contractOptions}
        seed={editorTab.seed}
        isCreate={editorTab.editorId === 'new'}
      />
    );
  }
  return <FactoringList contractOptions={contractOptions} />;
}

function FactoringList({ contractOptions }: { contractOptions: any[] }) {
  const editorTab = useEditorTab(LIST_PATH);
  const tabRefresh = useTabRefresh(LIST_PATH);
  const [contractId, setContractId] = useState('');
  const [totals, setTotals] = useState<any>({});
  const [rowCount, setRowCount] = useState(0);
  const [listRefresh, setListRefresh] = useState(0);
  const refreshList = () => setListRefresh((k) => k + 1);

  /**
   * 不选合同也取数：后端不传 `contractId` 时返回**本项目全部合同**的保理费用行
   * （与结算台账一致，打开即看全量）；选中合同则只取该合同。
   *
   * 结算月份筛选是 `DatePicker`（picker="month"），值是 dayjs 对象；
   * 后端按 `canonicalMonthKey` 归集，这里统一压成 `YYYY-MM` 再发，避免 axios 把 dayjs
   * 序列化成完整 ISO 时间戳。
   */
  const fetcher = useCallback(async (params: Record<string, any>) => {
    const month = params.settlementMonth;
    return financeApi.factoring(params.contractId || undefined, {
      ...params,
      settlementMonth: month ? dayjs(month).format('YYYY-MM') : undefined,
    });
  }, []);

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
    { key: 'contractId', label: '合同（供应商）', control: 'select', options: contractOptions, placeholder: '请选择合同' },
    {
      // 原先是一个纯文本框，要手打 `YYYY-MM`（写 `2026-4` 后端直接 400）——换成月份选择器
      key: 'settlementMonth',
      label: '结算月份',
      control: 'input',
      render: () => <DatePicker picker="month" format="YYYY-MM" style={{ width: '100%' }} placeholder="选择月份" />,
    },
    { key: 'keyword', label: '关键词', control: 'input', placeholder: '备注' },
  ];

  /** 未选合同 = 跨合同视图：必须带上「供应商 / 合同」，否则看不出某行属于哪个合同 */
  const showContractCols = !contractId;
  const extraColumns: any[] = [
    ...(showContractCols
      ? [
          { title: '供应商', dataIndex: 'supplierName', width: 180, fixed: 'left' as const, ellipsis: true, render: (v: any) => v || '-' },
          { title: '合同', dataIndex: 'contractName', width: 240, fixed: 'left' as const, ellipsis: true, render: (v: any, row: any) => (v ? `${row.contractCode ?? ''} ${v}`.trim() : '-') },
        ]
      : []),
    { title: '序号', dataIndex: 'seqNo', width: 60, fixed: 'left' as const },
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

  /**
   * 合计行的列偏移：跨合同视图在「序号」前多了「供应商 / 合同」两列，
   * 合计行每个 Cell 的 index 都要跟着右移，否则整行错位。
   */
  const off = showContractCols ? 2 : 0;

  return (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      {/* 合同资金参数条已挪进「新增/编辑保理费用」编辑器：列表页只做浏览与筛选，
          参数属于录入时的上下文，放在表头会占掉首屏且与录入动作脱节 */}

      {/* 汇总卡：与「结算台账/合同台账」顶部统计卡同款式（Card.stat-card + Statistic），
          数据取自后端 `totals`（覆盖筛选后的全部行，不受分页影响）。不选合同时是项目合计。 */}
      <Row gutter={16}>
        <Col xs={12} md={8} lg={4}>
          <Card size="small" className="stat-card"><Statistic title="记录数" value={rowCount} /></Card>
        </Col>
        <Col xs={12} md={8} lg={4}>
          <Card size="small" className="stat-card"><Statistic title="融资金额合计" value={money(totals.financingAmount)} /></Card>
        </Col>
        <Col xs={12} md={8} lg={4}>
          <Card size="small" className="stat-card"><Statistic title="实际到账合计" value={money(totals.actualReceipt)} /></Card>
        </Col>
        <Col xs={12} md={8} lg={4}>
          <Card size="small" className="stat-card"><Statistic title="融资利息合计" value={money(totals.financingInterest)} /></Card>
        </Col>
        <Col xs={12} md={8} lg={4}>
          <Card size="small" className="stat-card"><Statistic title="手续费合计" value={money(totals.handlingFee)} /></Card>
        </Col>
        <Col xs={12} md={8} lg={4}>
          <Card size="small" className="stat-card"><Statistic title="费用合计（含税）" value={money(totals.totalCost)} /></Card>
        </Col>
      </Row>

      <ModuleListPage
        mode="generic"
        columnConfigKey="finance.factoring"
        fetcher={fetcher}
        extraFilters={extraFilters}
        extraColumns={extraColumns}
        refreshKey={listRefresh + tabRefresh}
        emptyText="暂无保理费用记录"
        autoSearchOnChange={['contractId']}
        onFilterChange={(values, changed) => {
          if ('contractId' in changed) setContractId(values.contractId ?? '');
        }}
        mobileDefaultKeys={
          showContractCols
            ? ['contractName', 'financingDate', 'financingAmount', 'totalCost']
            : ['financingDate', 'financingAmount', 'actualReceipt', 'totalCost']
        }
        onFetched={(res: any) => {
          setTotals(res?.totals ?? {});
          setRowCount(Number(res?.total ?? 0));
        }}
        tableSummary={
          <Table.Summary fixed>
            <Table.Summary.Row style={{ fontWeight: 600 }}>
              {/* 跨合同视图多了「供应商 / 合同」两列：合计格的 colSpan 必须跟着算，
                  否则合计行会整体错位一格 */}
              <Table.Summary.Cell index={0} colSpan={2 + off}>合计</Table.Summary.Cell>
              <Table.Summary.Cell index={2 + off} align="right">{money(totals.financingAmount)}</Table.Summary.Cell>
              <Table.Summary.Cell index={3 + off} align="right">{money(totals.actualReceipt)}</Table.Summary.Cell>
              <Table.Summary.Cell index={4 + off} align="right">{money(totals.financingInterest)}</Table.Summary.Cell>
              <Table.Summary.Cell index={5 + off} align="right">{money(totals.handlingFee)}</Table.Summary.Cell>
              <Table.Summary.Cell index={6 + off} align="right">{money(totals.totalCost)}</Table.Summary.Cell>
              {/* 余下「结算月份 / 备注」两列，colSpan 必须等于剩余列数，否则合计行会多出一格错位 */}
              <Table.Summary.Cell index={7 + off} colSpan={2} />
            </Table.Summary.Row>
          </Table.Summary>
        }
        editPermission="finance:edit"
        onEdit={(row) => editorTab.openEdit(row.id, row)}
        onDelete={handleRemove}
        toolbarLeft={
          <Space wrap size={8}>
            <Can code="finance:edit">
              <Button type="primary" icon={<PlusOutlined />} onClick={() => editorTab.openCreate(contractId ? { contractId } : undefined)}>
                新增记录
              </Button>
            </Can>
            <Button
              icon={<ExportOutlined />}
              onClick={() => window.open(withToken(financeApi.exportFactoringUrl(contractId || undefined)))}
            >
              {contractId ? '导出 Excel' : '导出全部 Excel'}
            </Button>
          </Space>
        }
      />
    </Space>
  );
}

/**
 * 保理「新增/编辑」（表单正文从改造前的弹窗原样搬入，字段与校验规则未动）。
 *
 * 录入体验调整（2026-11-20）：
 * - 「结算月份」由手打文本框换成月份选择器（原文本要求 `YYYY-MM`，写 `2026-4` 后端 400）；
 * - 「费用合计」由恒空的只读框改成**实时显示** 融资利息 + 手续费；
 * - 新增时若列表已筛选合同，合同自动带入，不必再选一遍。
 */
function FactoringEditor({
  contractOptions,
  seed,
  isCreate,
}: {
  contractOptions: any[];
  seed: unknown;
  isCreate: boolean;
}) {
  const [form] = Form.useForm();
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  /** 编辑态 = seed 是整行记录；新增态 seed 只有预填值（可能为 undefined） */
  const editing = isCreate ? undefined : (seed as any | undefined);
  // 资金参数条跟随所选的合同（新增态选完合同即可核对/调整，不用回列表页看）
  const selectedContractId = Form.useWatch('contractId', form);

  // 费用合计实时回显：融资利息 + 手续费（与后端 `totalCost` 同口径）
  const interest = Form.useWatch('financingInterest', form) as number | null | undefined;
  const fee = Form.useWatch('handlingFee', form) as number | null | undefined;
  const hasCost = interest != null || fee != null;
  const totalCost = Math.round(((Number(interest) || 0) + (Number(fee) || 0)) * 100) / 100;

  useEffect(() => {
    form.resetFields();
    const init: any = editing ?? (seed as any) ?? null;
    if (init) {
      const month = init.settlementMonth ? dayjs(init.settlementMonth) : null;
      form.setFieldsValue({
        ...init,
        financingDate: init.financingDate ? dayjs(init.financingDate) : null,
        settlementMonth: month && month.isValid() ? month.startOf('month') : null,
      });
    }
    setDirty(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editing, seed]);

  const submit = async () => {
    const values = await form.validateFields();
    const data = {
      ...values,
      financingDate: values.financingDate ? values.financingDate.format('YYYY-MM-DD') : null,
      // 月份选择器的值是 dayjs，落库口径仍是 `YYYY-MM` 字符串（结算台账的归集键）
      settlementMonth: values.settlementMonth ? values.settlementMonth.format('YYYY-MM') : null,
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
          {selectedContractId && (
            <Col xs={24}>
              {/* 合同资金参数（供应商/付款模式/利率/宽限期），紧跟合同信息、可就地调整 */}
              <ContractFundParams contractId={selectedContractId} variant="inline" />
            </Col>
          )}
          <Col xs={24} md={12}>
            <Form.Item name="settlementMonth" label="结算月份" tooltip="该笔费用归集到的结算月份（结算台账「保理贴息」列按此月份抓取）">
              <DatePicker picker="month" format="YYYY-MM" style={{ width: '100%' }} placeholder="选择月份" />
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
            <Form.Item label="费用合计（含税）" tooltip="融资利息 + 手续费，系统自动计算（保存时后端按同口径落库）">
              <InputNumber
                style={{ width: '100%' }}
                disabled
                precision={2}
                value={hasCost ? totalCost : undefined}
                placeholder="自动计算"
              />
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
