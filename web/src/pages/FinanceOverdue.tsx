import { useCallback, useEffect, useState } from 'react';
import { withToken } from '../utils/download';
import {
  Button, Card, Form, Input, InputNumber, Select, Space, Modal, message, Statistic, DatePicker, Switch, Alert, Table, Tag, Row, Col,
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
 * 逾期利息台账（业务口径 2026-10-16 由「资金费用台账」拆出的独立模块）。
 *
 * 逾期利息按**月**只增不减，故列表带分页（后端 `listOverdue` 的页面对齐见
 * `finance.service.ts` 的 `pageSlice`：分页在内存里做，汇总 `stats` 仍覆盖全量行）。
 *
 * 列表与「新增/编辑」是同一路由的两种形态（`?editor=new|<id>`），见 `useEditorTab` 的注释。
 */
const LIST_PATH = '/settlement/overdue';

export default function FinanceOverdue() {
  const [contracts, setContracts] = useState<any[]>([]);
  useEffect(() => {
    contractApi.options().then((res: any) => setContracts(res || []));
  }, []);
  const contractOptions = contracts.map((c) => ({ value: c.id, label: `${c.code} ${c.name}` }));

  const editorTab = useEditorTab(LIST_PATH);
  if (editorTab.isEditor) {
    return <OverdueEditor contractOptions={contractOptions} seed={editorTab.seed} />;
  }
  return <OverdueList contractOptions={contractOptions} />;
}

function OverdueList({ contractOptions }: { contractOptions: any[] }) {
  const editorTab = useEditorTab(LIST_PATH);
  const tabRefresh = useTabRefresh(LIST_PATH);
  const [contractId, setContractId] = useState('');
  const [stats, setStats] = useState<any>({});
  const [generateOpen, setGenerateOpen] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [generateForm] = Form.useForm();
  const [listRefresh, setListRefresh] = useState(0);
  const refreshList = () => setListRefresh((k) => k + 1);

  /**
   * 不选合同也取数：后端不传 `contractId` 时返回**本项目全部合同**的逾期利息行，
   * 每个合同用它自己的月利率/宽限期/上限比例重算（与结算台账一致，打开即看全量）。
   */
  const fetcher = useCallback(
    async (params: Record<string, any>) => financeApi.overdue(params.contractId || undefined, params),
    [],
  );

  const handleRemove = (row: ModuleListRow) => {
    Modal.confirm({
      title: '确认删除该行？',
      okText: '确认删除',
      okType: 'danger',
      onOk: async () => {
        await financeApi.removeOverdue(row.id);
        message.success('已删除，已自动重算');
        refreshList();
      },
    });
  };

  const submitGenerate = async () => {
    const values = await generateForm.validateFields();
    setGenerating(true);
    try {
      await financeApi.generateOverdue({
        contractId,
        settlementMonth: values.settlementMonth.format('YYYY-MM'),
        materialAmount: values.materialAmount,
      });
      message.success('已按付款模式生成应付款行');
      setGenerateOpen(false);
      refreshList();
    } finally {
      setGenerating(false);
    }
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
  ];

  /** 未选合同 = 跨合同视图：必须带上「供应商 / 合同」，否则看不出某行属于哪个合同 */
  const showContractCols = !contractId;
  /** 合计行列偏移：跨合同视图在「结算月份」前多了「供应商 / 合同」两列 */
  const off = showContractCols ? 2 : 0;

  const extraColumns: any[] = [
    ...(showContractCols
      ? [
          { title: '供应商', dataIndex: 'supplierName', width: 180, fixed: 'left' as const, ellipsis: true, render: (v: any) => v || '-' },
          { title: '合同', dataIndex: 'contractName', width: 240, fixed: 'left' as const, ellipsis: true, render: (v: any, row: any) => (v ? `${row.contractCode ?? ''} ${v}`.trim() : '-') },
        ]
      : []),
    { title: '结算月份', dataIndex: 'settlementMonth', width: 100, fixed: 'left' as const },
    { title: '材料款金额', dataIndex: 'materialAmount', width: 120, align: 'right' as const, render: money },
    {
      title: '付款比例',
      dataIndex: 'paymentRatio',
      width: 90,
      align: 'right' as const,
      render: (v: any) => (v === null || v === undefined ? '-' : `${(Number(v) * 100).toFixed(0)}%`),
    },
    { title: '应付款金额', dataIndex: 'payableAmount', width: 120, align: 'right' as const, render: money },
    { title: '应付款日期', dataIndex: 'payableDate', width: 115, render: dateStr },
    { title: '逾期起始日期', dataIndex: 'overdueStartDate', width: 120, render: dateStr },
    { title: '付款日期', dataIndex: 'paymentDate', width: 115, render: dateStr },
    { title: '付款金额', dataIndex: 'paymentAmount', width: 115, align: 'right' as const, render: money },
    { title: '计息金额', dataIndex: 'interestAmount', width: 115, align: 'right' as const, render: money },
    {
      title: '逾期天数',
      dataIndex: 'overdueDays',
      width: 90,
      align: 'right' as const,
      render: (v: any, row: any) => (row.waived ? <Tag>减免</Tag> : (v ?? '-')),
    },
    {
      title: '延期月利率',
      dataIndex: 'monthlyRate',
      width: 105,
      align: 'right' as const,
      render: (v: any) => (v === null || v === undefined ? '-' : `${(Number(v) * 100).toFixed(2)}%`),
    },
    {
      title: '逾期利息（含税）',
      dataIndex: 'overdueInterest',
      width: 140,
      align: 'right' as const,
      render: (v: any, row: any) => <b>{money(row.waived ? 0 : v)}</b>,
    },
    { title: '备注', dataIndex: 'remark', width: 180, ellipsis: true, render: (v: any) => v || '-' },
  ];

  return (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      {contractId && <ContractFundParams contractId={contractId} />}

      {/* 统计卡：与「结算台账/合同台账」同款式；不选合同时是**项目全量**口径
          （跨合同各用自己的利率重算后相加，上限金额取各合同上限之和） */}
      <Row gutter={16}>
        <Col xs={12} md={8} lg={6}>
          <Card size="small" className="stat-card">
            <Statistic title="材料款金额合计" value={money(stats.totalMaterial)} />
          </Card>
        </Col>
        <Col xs={12} md={8} lg={6}>
          <Card size="small" className="stat-card">
            <Statistic title="付款金额合计" value={money(stats.totalPayment)} />
          </Card>
        </Col>
        <Col xs={12} md={8} lg={6}>
          <Card size="small" className="stat-card">
            <Statistic title="本期开累逾期利息" value={money(stats.currentCumulative)} />
          </Card>
        </Col>
        <Col xs={12} md={8} lg={6}>
          <Card size="small" className="stat-card">
            <Statistic
              title={showContractCols ? '上限金额合计（各合同加权）' : `上限金额（${((stats.capRatio || 0) * 100).toFixed(1)}%）`}
              value={money(stats.capAmount)}
            />
          </Card>
        </Col>
        <Col xs={12} md={8} lg={6}>
          <Card size="small" className="stat-card">
            <Statistic title="开累利息占材料款比例" value={stats.interestRatio || 0} precision={2} suffix="%" />
          </Card>
        </Col>
        <Col xs={12} md={8} lg={6}>
          <Card size="small" className="stat-card">
            <Statistic title="上期开累逾期利息" value={money(stats.prevCumulative)} />
          </Card>
        </Col>
        <Col xs={12} md={8} lg={6}>
          <Card size="small" className="stat-card">
            <Statistic title="本月结算逾期利息" value={money(stats.currentSettlement)} />
          </Card>
        </Col>
      </Row>

      <ModuleListPage
        mode="generic"
        columnConfigKey="finance.overdue"
        fetcher={fetcher}
        extraFilters={extraFilters}
        extraColumns={extraColumns}
        refreshKey={listRefresh + tabRefresh}
        emptyText="暂无逾期利息记录"
        autoSearchOnChange={['contractId']}
        onFilterChange={(values, changed) => {
          if ('contractId' in changed) setContractId(values.contractId ?? '');
        }}
        mobileDefaultKeys={
          showContractCols
            ? ['contractName', 'settlementMonth', 'materialAmount', 'overdueInterest']
            : ['settlementMonth', 'materialAmount', 'payableAmount', 'overdueInterest']
        }
        onFetched={(res: any) => setStats(res?.stats ?? {})}
        tableSummary={
          <Table.Summary fixed>
            <Table.Summary.Row style={{ fontWeight: 600 }}>
              {/* 跨合同视图多了「供应商 / 合同」两列，合计行 index 全部右移 `off` */}
              <Table.Summary.Cell index={0} colSpan={1 + off}>合计</Table.Summary.Cell>
              <Table.Summary.Cell index={1 + off} align="right">{money(stats.totalMaterial)}</Table.Summary.Cell>
              {/* 付款比例 / 应付款金额 / 应付款日期 / 逾期起始日期 / 付款日期 */}
              <Table.Summary.Cell index={2 + off} colSpan={5} />
              <Table.Summary.Cell index={7 + off} align="right">{money(stats.totalPayment)}</Table.Summary.Cell>
              {/* 计息金额 / 逾期天数 / 延期月利率 */}
              <Table.Summary.Cell index={8 + off} colSpan={3} />
              <Table.Summary.Cell index={11 + off} align="right">{money(stats.currentCumulative)}</Table.Summary.Cell>
              <Table.Summary.Cell index={12 + off} />
            </Table.Summary.Row>
          </Table.Summary>
        }
        editPermission="finance:edit"
        onEdit={(row) => editorTab.openEdit(row.id, row)}
        onDelete={handleRemove}
        toolbarLeft={
          <Space wrap size={8}>
            <Can code="finance:edit">
              <>
                {/* 「按付款模式生成应付款行」是**合同级**动作（要读该合同的付款模式/应付款日），
                    必须先在筛选区选定合同；手动新增行不受限（表单里自己选合同） */}
                <Button
                  type="primary"
                  disabled={!contractId}
                  onClick={() => {
                    generateForm.resetFields();
                    setGenerateOpen(true);
                  }}
                >
                  按付款模式生成应付款行
                </Button>
                <Button icon={<PlusOutlined />} onClick={() => editorTab.openCreate()}>
                  手动新增行
                </Button>
              </>
            </Can>
            {/* 计算表带统计区/签字区/合同付款条件，是合同级单据，不能跨合同导出 */}
            <Button
              icon={<ExportOutlined />}
              disabled={!contractId}
              onClick={() => window.open(withToken(financeApi.exportOverdueUrl(contractId)))}
            >
              导出计算表
            </Button>
          </Space>
        }
      />

      {contractId && (
        <Card size="small" style={{ background: 'var(--cms-surface-soft)' }}>
          <div style={{ display: 'flex', gap: 48, flexWrap: 'wrap', color: 'var(--cms-muted)' }}>
            <span>经办人：____________</span>
            <span>物资经理：____________</span>
            <span>商务经理：____________</span>
            <span>项目经理：____________</span>
          </div>
        </Card>
      )}

      {/* 按付款模式生成应付款行 */}
      <Modal
        title="按付款模式生成应付款行"
        open={generateOpen}
        onOk={submitGenerate}
        onCancel={() => setGenerateOpen(false)}
        confirmLoading={generating}
        destroyOnHidden
      >
        <Alert
          style={{ marginBottom: 12 }}
          type="info"
          showIcon
          message="将按该合同的付款模式推导应付款日期并生成应付款行；逾期起始日期 = 应付款日期 + 宽限期 + 1 天。"
        />
        <Form form={generateForm} layout="vertical">
          <Form.Item name="settlementMonth" label="结算月份" rules={[{ required: true, message: '请选择结算月份' }]}>
            <DatePicker picker="month" style={{ width: '100%' }} />
          </Form.Item>
          <Form.Item
            name="materialAmount"
            label="本月材料款金额（不含资金费用）"
            rules={[{ required: true, message: '请输入材料款金额' }]}
          >
            <InputNumber style={{ width: '100%' }} min={0.01} precision={2} />
          </Form.Item>
        </Form>
      </Modal>
    </Space>
  );
}

/** 逾期利息「手动新增/编辑」（表单正文从改造前的弹窗原样搬入，字段与校验规则未动） */
function OverdueEditor({ contractOptions, seed }: { contractOptions: any[]; seed: unknown }) {
  const [form] = Form.useForm();
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  const editing = seed as any | undefined;

  useEffect(() => {
    form.resetFields();
    if (editing) {
      form.setFieldsValue({
        ...editing,
        payableDate: editing.payableDate ? dayjs(editing.payableDate) : null,
        paymentDate: editing.paymentDate ? dayjs(editing.paymentDate) : null,
      });
    }
    setDirty(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editing]);

  const submit = async () => {
    const values = await form.validateFields();
    const data = {
      ...values,
      payableDate: values.payableDate ? values.payableDate.format('YYYY-MM-DD') : null,
      paymentDate: values.paymentDate ? values.paymentDate.format('YYYY-MM-DD') : null,
      // 乐观锁：编辑态必须回传 version，否则后端 assertVersion 抛 409
      version: editing ? (editing as any).version : undefined,
    };
    setSaving(true);
    try {
      if (editing) await financeApi.updateOverdue(editing.id, data);
      else await financeApi.createOverdue(data);
      message.success('保存成功，已自动重算台账');
    } finally {
      setSaving(false);
    }
  };

  return (
    <EditorTabPage
      listPath={LIST_PATH}
      title={editing ? '编辑逾期利息行' : '手动新增逾期利息行'}
      saving={saving}
      dirty={dirty}
      onSave={submit}
    >
      <Alert
        style={{ marginBottom: 12 }}
        type="info"
        showIcon
        message="应付款金额、逾期起始日期、计息金额、逾期天数、逾期利息均由系统按公式自动计算；付款金额填 0 表示对该笔剩余未付金额计息一次。"
      />
      <Form form={form} layout="vertical" onValuesChange={() => setDirty(true)}>
        <Row gutter={16}>
          <Col xs={24} md={12}>
            <Form.Item name="contractId" label="合同" rules={[{ required: true, message: '请选择合同' }]}>
              <Select showSearch optionFilterProp="label" placeholder="请选择合同" options={contractOptions} />
            </Form.Item>
          </Col>
          <Col xs={24} md={12}>
            <Form.Item name="settlementMonth" label="结算月份" rules={[{ required: true, message: '如 2026-04' }]}>
              <Input placeholder="如 2026-04" />
            </Form.Item>
          </Col>
          <Col xs={24} md={12}>
            <Form.Item name="periodSeq" label="行序号（同月多笔付款时）">
              <InputNumber min={1} precision={0} style={{ width: '100%' }} />
            </Form.Item>
          </Col>
          <Col xs={24} md={12}>
            <Form.Item name="materialAmount" label="材料款金额">
              <InputNumber style={{ width: '100%' }} min={0} precision={2} />
            </Form.Item>
          </Col>
          <Col xs={24} md={12}>
            <Form.Item name="paymentRatio" label="付款比例" tooltip="0.8 表示 80%；留空按 100%">
              <InputNumber style={{ width: '100%' }} min={0} max={1} step={0.05} />
            </Form.Item>
          </Col>
          <Col xs={24} md={12}>
            <Form.Item name="payableDate" label="应付款日期" tooltip="留空时由系统按付款模式推导">
              <DatePicker format="YYYY-MM-DD" style={{ width: '100%' }} />
            </Form.Item>
          </Col>
          <Col xs={24} md={12}>
            <Form.Item name="paymentDate" label="实际付款日期">
              <DatePicker format="YYYY-MM-DD" style={{ width: '100%' }} />
            </Form.Item>
          </Col>
          <Col xs={24} md={12}>
            <Form.Item name="paymentAmount" label="付款金额">
              <InputNumber style={{ width: '100%' }} min={0} precision={2} />
            </Form.Item>
          </Col>
          <Col xs={24} md={12}>
            <Form.Item name="prevCumulative" label="上期开累逾期利息（期初，可留空自动结转）">
              <InputNumber style={{ width: '100%' }} min={0} precision={2} />
            </Form.Item>
          </Col>
          <Col xs={24} md={12}>
            <Form.Item name="waived" label="谈判减免（利息记 0）" valuePropName="checked">
              <Switch />
            </Form.Item>
          </Col>
          <Col xs={24}>
            <Form.Item name="remark" label="备注">
              <Input.TextArea rows={2} placeholder="减免等特殊情况请注明" />
            </Form.Item>
          </Col>
        </Row>
      </Form>
    </EditorTabPage>
  );
}
