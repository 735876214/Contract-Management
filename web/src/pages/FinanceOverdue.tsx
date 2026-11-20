import { useCallback, useEffect, useMemo, useState } from 'react';
import { withToken } from '../utils/download';
import {
  Button, Card, Form, Input, InputNumber, Select, Space, Modal, message, Statistic, DatePicker, Switch, Alert, Table, Tag, Row, Col, Empty,
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

/** 比例 0-1 小数 → 百分数展示（80% / 66.67%，去掉多余的 .00） */
const pct = (v: any) =>
  v === null || v === undefined || v === '' ? '-' : `${(Number(v) * 100).toFixed(2).replace(/\.?0+$/, '')}%`;

const round2 = (v: number) => Math.round((Number(v) || 0) * 100) / 100;

/**
 * 逾期利息台账（业务口径 2026-10-16 由「资金费用台账」拆出的独立模块）。
 *
 * **主子结构（2026-11-20 重构）**：一行 = 一个「应付款项」（某结算月的某一期），
 * 付款流水是合同级的子表，引擎把每笔钱**跨期自动分配**（先抵已逾期、再抵未到期），
 * 所以列表一行不再混着「材料款主行 + 付款行 + 计息承载行」，展开行就看得到该期被哪些付款抵过。
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
  const contractOptions = contractOptionsOf(contracts);

  const editorTab = useEditorTab(LIST_PATH);
  if (editorTab.isEditor) {
    // 不能再用 seed 真假判断新增/编辑：新增也可能带预填（如先在列表选了合同）
    return (
      <OverdueEditor
        contractOptions={contractOptions}
        seed={editorTab.seed}
        isCreate={editorTab.editorId === 'new'}
      />
    );
  }
  return <OverdueList contractOptions={contractOptions} />;
}

const contractOptionsOf = (contracts: any[]) =>
  contracts.map((c) => ({ value: c.id, label: `${c.code} ${c.name}` }));

function OverdueList({ contractOptions }: { contractOptions: any[] }) {
  const editorTab = useEditorTab(LIST_PATH);
  const tabRefresh = useTabRefresh(LIST_PATH);
  const [contractId, setContractId] = useState('');
  const [stats, setStats] = useState<any>({});
  const [payOpen, setPayOpen] = useState(false);
  const [listRefresh, setListRefresh] = useState(0);
  const refreshList = () => setListRefresh((k) => k + 1);

  /**
   * 不选合同也取数：后端不传 `contractId` 时返回**本项目全部合同**的应付款项，
   * 每个合同用它自己的月利率/宽限期/上限比例重算（与结算台账一致，打开即看全量）。
   * 结算月份是月份选择器，落参前统一成 `YYYY-MM`（否则 dayjs 会被序列化成完整 ISO）。
   */
  const fetcher = useCallback(async (params: Record<string, any>) => {
    const month = params.settlementMonth;
    return financeApi.overdue(params.contractId || undefined, {
      ...params,
      settlementMonth: month ? dayjs(month).format('YYYY-MM') : undefined,
    });
  }, []);

  const handleRemove = (row: ModuleListRow) => {
    Modal.confirm({
      title: `确认删除「${(row as any).settlementMonth} 第 ${(row as any).periodSeq || 1} 期」？`,
      content: '删除后该合同逾期利息与结算台账「逾期利息」列会自动重算。',
      okText: '确认删除',
      okType: 'danger',
      onOk: async () => {
        await financeApi.removeOverdue(row.id);
        message.success('已删除，已自动重算');
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
      searchable: true,
    },
    {
      key: 'settlementMonth',
      label: '结算月份',
      control: 'input',
      placeholder: '选择月份',
      render: () => <DatePicker picker="month" format="YYYY-MM" style={{ width: '100%' }} placeholder="选择月份" />,
    },
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
    { title: '期次', dataIndex: 'periodSeq', width: 64, align: 'right' as const, render: (v: any) => v ?? 1 },
    { title: '本期材料款', dataIndex: 'materialAmount', width: 120, align: 'right' as const, render: money },
    { title: '付款比例', dataIndex: 'paymentRatio', width: 90, align: 'right' as const, render: pct },
    { title: '应付款金额', dataIndex: 'payableAmount', width: 120, align: 'right' as const, render: money },
    { title: '应付款日期', dataIndex: 'payableDate', width: 115, render: dateStr },
    { title: '逾期起始日期', dataIndex: 'overdueStartDate', width: 120, render: dateStr },
    {
      title: '已付金额',
      dataIndex: 'paidAmount',
      width: 115,
      align: 'right' as const,
      render: (v: any) => <span style={{ color: Number(v) > 0 ? undefined : 'var(--cms-muted)' }}>{money(v)}</span>,
    },
    {
      title: '未付余额',
      dataIndex: 'remaining',
      width: 115,
      align: 'right' as const,
      render: (v: any) => <span style={{ color: Number(v) > 0 ? 'var(--cms-warning)' : 'var(--cms-muted)' }}>{money(v)}</span>,
    },
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
            <Statistic title="已付金额合计" value={money(stats.totalPayment)} />
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
        emptyText="暂无应付款项"
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
        /* 展开行 = 该期被付款流水抵掉的片段（每段天数与利息由引擎现算，与合计对得上） */
        rowExpandable={(row) => Array.isArray((row as any).chunks) && (row as any).chunks.length > 0}
        expandedRowRender={(row) => <PaymentChunks row={row as any} />}
        tableSummary={
          <Table.Summary fixed>
            <Table.Summary.Row style={{ fontWeight: 600 }}>
              {/* 跨合同视图多了「供应商 / 合同」两列，合计行 index 全部右移 `off` */}
              <Table.Summary.Cell index={0} colSpan={1 + off}>合计</Table.Summary.Cell>
              {/* 期次 */}
              <Table.Summary.Cell index={1 + off} />
              <Table.Summary.Cell index={2 + off} align="right">{money(stats.totalMaterial)}</Table.Summary.Cell>
              {/* 付款比例 / 应付款金额 / 应付款日期 / 逾期起始日期 */}
              <Table.Summary.Cell index={3 + off} colSpan={4} />
              <Table.Summary.Cell index={7 + off} align="right">{money(stats.totalPayment)}</Table.Summary.Cell>
              {/* 未付余额 / 计息金额 */}
              <Table.Summary.Cell index={8 + off} colSpan={2} />
              {/* 逾期天数 / 延期月利率 */}
              <Table.Summary.Cell index={10 + off} colSpan={2} />
              <Table.Summary.Cell index={12 + off} align="right">{money(stats.currentCumulative)}</Table.Summary.Cell>
              <Table.Summary.Cell index={13 + off} />
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
                {/* 新增即可选合同/月份/付款模式，一次生成多期（原「按付款模式生成应付款行」
                    是主界面上的独立动作，现已收进编辑器：付款模式可当场调整） */}
                <Button
                  type="primary"
                  icon={<PlusOutlined />}
                  onClick={() => editorTab.openCreate(contractId ? { contractId } : undefined)}
                >
                  新增应付款项
                </Button>
                <Button disabled={!contractId} onClick={() => setPayOpen(true)}>
                  付款流水
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

      <PaymentModal
        contractId={contractId}
        open={payOpen}
        onClose={() => setPayOpen(false)}
        onChanged={refreshList}
      />
    </Space>
  );
}

/** 展开行：该期收到的付款片段（引擎跨期分配的结果） */
function PaymentChunks({ row }: { row: any }) {
  const chunks: any[] = Array.isArray(row.chunks) ? row.chunks : [];
  if (!chunks.length) return <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="该期还没有收到付款" />;
  return (
    <Space direction="vertical" size={8} style={{ width: '100%' }}>
      <Table<any>
        size="small"
        rowKey={(c: any) => `${c.paymentId || 'x'}-${c.paymentDate}-${c.amount}`}
        pagination={false}
        dataSource={chunks}
        columns={[
          { title: '付款日期', dataIndex: 'paymentDate', width: 120, render: dateStr },
          { title: '抵本期金额', dataIndex: 'amount', width: 130, align: 'right' as const, render: money },
          { title: '本段逾期天数', dataIndex: 'overdueDays', width: 120, align: 'right' as const },
          { title: '本段利息', dataIndex: 'interest', width: 120, align: 'right' as const, render: money },
        ]}
      />
      <span style={{ color: 'var(--cms-muted)' }}>
        本期已付 {money(row.paidAmount)} · 未付余额 {money(row.remaining)}（未付部分按查询当日的逾期天数计息）
      </span>
    </Space>
  );
}

/**
 * 付款流水（子表）登记弹窗：合同级、跨期自动分配。
 *
 * 一笔付款可能横跨多期，抵到哪几期由后端引擎决定，这里只做录入与呈现——
 * 「哪一期还欠多少」应在应付款项列表看（那边是分配结果的主视图）。
 */
function PaymentModal({
  contractId,
  open,
  onClose,
  onChanged,
}: {
  contractId: string;
  open: boolean;
  onClose: () => void;
  onChanged: () => void;
}) {
  const [form] = Form.useForm();
  const [rows, setRows] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!contractId) return;
    setLoading(true);
    try {
      const res = await financeApi.overduePayments(contractId);
      setRows(res?.list || []);
    } finally {
      setLoading(false);
    }
  }, [contractId]);

  useEffect(() => {
    if (!open) return;
    setEditingId(null);
    form.resetFields();
    load();
  }, [open, contractId, form, load]);

  const submit = async () => {
    const v = await form.validateFields();
    setSaving(true);
    try {
      const payload = {
        contractId,
        paymentDate: v.paymentDate.format('YYYY-MM-DD'),
        paymentAmount: v.paymentAmount,
        remark: v.remark || null,
      };
      if (editingId) {
        // 乐观锁：编辑要回传 version，否则后端 assertVersion 抛 409
        await financeApi.updateOverduePayment(editingId, { ...payload, version: rows.find((r) => r.id === editingId)?.version });
      } else {
        await financeApi.createOverduePayment(payload);
      }
      message.success('已保存，逾期利息与结算台账已重算');
      setEditingId(null);
      form.resetFields();
      await load();
      onChanged();
    } finally {
      setSaving(false);
    }
  };

  const startEdit = (row: any) => {
    setEditingId(row.id);
    form.setFieldsValue({
      paymentDate: row.paymentDate ? dayjs(row.paymentDate) : null,
      paymentAmount: Number(row.paymentAmount),
      remark: row.remark,
    });
  };

  const remove = (row: any) => {
    Modal.confirm({
      title: '确认删除该笔付款？',
      content: '删除后该合同逾期利息与结算台账会自动重算。',
      okText: '确认删除',
      okType: 'danger',
      onOk: async () => {
        await financeApi.removeOverduePayment(row.id);
        message.success('已删除，已自动重算');
        await load();
        onChanged();
      },
    });
  };

  return (
    <Modal
      title="付款流水"
      open={open}
      onCancel={onClose}
      footer={null}
      width={780}
      forceRender
    >
      <Alert
        style={{ marginBottom: 12 }}
        type="info"
        showIcon
        message="付款流水是合同级的：一笔付款按付款日期**先抵已逾期、再抵未到期**的应付款项，抵到哪几期与各段利息由系统算，不需要手工挂到某一期。"
      />
      <Form form={form} layout="inline" style={{ marginBottom: 12, rowGap: 8 }}>
        <Form.Item name="paymentDate" rules={[{ required: true, message: '请选择付款日期' }]}>
          <DatePicker placeholder="付款日期" format="YYYY-MM-DD" />
        </Form.Item>
        <Form.Item name="paymentAmount" rules={[{ required: true, message: '请输入付款金额' }]}>
          <InputNumber placeholder="付款金额" min={0.01} precision={2} style={{ width: 150 }} />
        </Form.Item>
        <Form.Item name="remark">
          <Input placeholder="备注（选填）" style={{ width: 180 }} />
        </Form.Item>
        <Form.Item>
          <Space>
            <Button type="primary" loading={saving} onClick={submit}>
              {editingId ? '保存修改' : '登记付款'}
            </Button>
            {editingId && (
              <Button
                onClick={() => {
                  setEditingId(null);
                  form.resetFields();
                }}
              >
                取消
              </Button>
            )}
          </Space>
        </Form.Item>
      </Form>
      <Table<any>
        size="small"
        rowKey="id"
        loading={loading}
        dataSource={rows}
        pagination={false}
        locale={{ emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="还没有登记付款" /> }}
        columns={[
          { title: '付款日期', dataIndex: 'paymentDate', width: 110, render: dateStr },
          { title: '付款金额', dataIndex: 'paymentAmount', width: 130, align: 'right' as const, render: money },
          {
            title: '抵到哪几期',
            dataIndex: 'allocations',
            render: (v: any[]) =>
              v?.length ? (
                <Space direction="vertical" size={0}>
                  {v.map((a, i) => (
                    <span key={i} style={{ fontSize: 12 }}>
                      {a.settlementMonth} 第 {a.periodSeq ?? 1} 期 · 抵 {money(a.amount)} · {a.overdueDays} 天 · 利息 {money(a.interest)}
                    </span>
                  ))}
                </Space>
              ) : (
                <span style={{ color: 'var(--cms-muted)' }}>未分配到任何期（可能都已付清）</span>
              ),
          },
          { title: '备注', dataIndex: 'remark', width: 140, ellipsis: true, render: (v: any) => v || '-' },
          {
            title: '操作',
            width: 110,
            render: (_: any, row: any) => (
              <Can code="finance:edit">
                <Space size={4}>
                  <Button type="link" size="small" onClick={() => startEdit(row)}>
                    编辑
                  </Button>
                  <Button type="link" size="small" danger onClick={() => remove(row)}>
                    删除
                  </Button>
                </Space>
              </Can>
            ),
          },
        ]}
      />
    </Modal>
  );
}

/**
 * 应付款项「新增/编辑」。
 *
 * 新增：选合同 + 结算月份 + 本期材料款 + **付款模式**（默认取合同当前的付款安排，可当场改），
 * 系统按模式拆成各期（比例可逐期调整、应付款日期可改），保存时一次建多期。
 * 编辑：改某一期的材料款/比例/应付款日期等单期字段。
 *
 * 「保存前预览」直接调后端 `previewOverdue`（同一个引擎），所以预览的应付款金额/逾期起始日/
 * 逾期天数/预计利息与保存后的结果必然一致——前端不复刻算法。
 */
function OverdueEditor({
  contractOptions,
  seed,
  isCreate,
}: {
  contractOptions: any[];
  seed: unknown;
  isCreate: boolean;
}) {
  const [form] = Form.useForm();
  const editing = isCreate ? undefined : (seed as any | undefined);
  const [modes, setModes] = useState<any[]>([]);
  const [params, setParams] = useState<any>(null);
  const [tranches, setTranches] = useState<any[]>([]);
  const [preview, setPreview] = useState<any[]>([]);
  const [previewStats, setPreviewStats] = useState<any>({});
  const [previewing, setPreviewing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);

  const contractId = Form.useWatch('contractId', form);
  const settlementMonth = Form.useWatch('settlementMonth', form);
  const materialAmount = Form.useWatch('materialAmount', form);
  const waived = Form.useWatch('waived', form);
  const periodSeq = Form.useWatch('periodSeq', form);
  const paymentRatio = Form.useWatch('paymentRatio', form);
  const payableDate = Form.useWatch('payableDate', form);
  // 付款模式必须 useWatch：合同带出的默认值是 setFieldValue 设的，不会触发 Select 的 onChange
  const paymentMode = Form.useWatch('paymentMode', form);

  const monthStr = settlementMonth ? dayjs(settlementMonth).format('YYYY-MM') : '';

  // 付款模式定义（单一事实源在后端 PAYMENT_MODES）
  useEffect(() => {
    financeApi.paymentModes().then((res: any) => setModes(res || []));
  }, []);

  // 回显（编辑态）
  useEffect(() => {
    // 新增态不调 resetFields：挂载首帧 Form 可能尚未 attach，会触发
    // "Instance created by useForm is not connected to any Form element" 告警（新增态本来就是空表单）
    if (editing) {
      form.resetFields();
      form.setFieldsValue({
        ...editing,
        settlementMonth: editing.settlementMonth ? dayjs(`${editing.settlementMonth}-01`) : null,
        paymentRatio:
          editing.paymentRatio === null || editing.paymentRatio === undefined
            ? null
            : round2(Number(editing.paymentRatio) * 100),
        payableDate: editing.payableDate ? dayjs(editing.payableDate) : null,
      });
    } else if ((seed as any)?.contractId) {
      // 新增态也支持预填：在列表里筛了合同再点「新增应付款项」，不必重新选一遍
      form.setFieldValue('contractId', (seed as any).contractId);
    }
    setDirty(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editing]);

  // 选合同 → 取合同资金参数（付款模式默认值、利率/宽限期/上限），并把付款模式摊成占位期次
  useEffect(() => {
    if (!contractId || editing) {
      if (editing) {
        // 编辑态也要参数（预览要按本合同的利率/宽限期算）
        financeApi.previewOverdue({ contractId: editing.contractId, drafts: [] }).then((res: any) => setParams(res?.contract)).catch(() => {});
      }
      return;
    }
    let alive = true;
    financeApi
      .previewOverdue({ contractId, drafts: [] })
      .then((res: any) => {
        if (!alive) return;
        setParams(res?.contract ?? null);
        // 换合同就回到该合同的付款安排（用户仍可当场改）；下面的 effect 会据此重摊期次
        form.setFieldValue('paymentMode', res?.contract?.paymentMode || '100');
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [contractId, editing]);

  /** 付款模式 → 各期草稿（比例转百分数；应付款日 = 结算月 + 偏移月 的某日，口径来自模式定义的 day） */
  const buildTranches = useCallback(
    (mode: string, month: any): any[] => {
      const def = modes.find((m) => m.mode === mode);
      const base = month ? dayjs(month).startOf('month') : dayjs().startOf('month');
      const list = (def?.tranches || []).map((t: any) => ({
        key: `${mode}-${t.plusMonths}-${t.day}`,
        ratio: round2(Number(t.ratio) * 100),
        payableDate: base.add(Number(t.plusMonths) || 0, 'month').date(Number(t.day) || 25),
      }));
      return list.length ? list : [{ key: `${mode}-0`, ratio: 100, payableDate: base.add(1, 'month').date(25) }];
    },
    [modes],
  );

  /** 结算月份变了：只把各期应付款日期平移到新月份（保留用户改过的比例） */
  const shiftTranches = useCallback(
    (month: any, mode: string, prev: any[]): any[] => {
      if (!month || !prev.length) return prev;
      const def = modes.find((m) => m.mode === mode);
      const base = dayjs(month).startOf('month');
      return prev.map((t, i) => {
        const plus = Number(def?.tranches?.[i]?.plusMonths ?? i + 1) || 0;
        const day = Number(def?.tranches?.[i]?.day ?? 25) || 25;
        return { ...t, payableDate: base.add(plus, 'month').date(day) };
      });
    },
    [modes],
  );

  /** 「按付款模式重填」：按当前模式的默认比例与日期整表重摊 */
  const applyMode = (mode: string) => {
    setTranches(buildTranches(mode, form.getFieldValue('settlementMonth')));
    setDirty(true);
  };

  /** 付款模式变化（含合同带出的默认值）→ 整表重摊 */
  useEffect(() => {
    if (editing || !paymentMode || !modes.length) return;
    setTranches(buildTranches(paymentMode, settlementMonth));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [paymentMode, modes, editing]);

  /** 结算月份变化 → 只平移日期 */
  useEffect(() => {
    if (editing) return;
    setTranches((prev) => shiftTranches(settlementMonth, form.getFieldValue('paymentMode') || '100', prev));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settlementMonth, editing]);

  /** 比例合计（百分数）——不等于 100% 也允许（部分分期），只提示 */
  const ratioSum = useMemo(
    () => round2(tranches.reduce((a, t) => a + (Number(t.ratio) || 0), 0)),
    [tranches],
  );

  /** 预览用的草稿（与保存入参同源，避免"预览一个数、存完另一个数"） */
  const drafts = useMemo(() => {
    if (!contractId || !monthStr) return [];
    if (editing) {
      const mat = Number(materialAmount);
      if (!(mat > 0)) return [];
      return [
        {
          id: editing.id,
          settlementMonth: monthStr,
          periodSeq: Number(periodSeq) || editing.periodSeq || 1,
          materialAmount: mat,
          paymentRatio: Number(paymentRatio) > 0 ? Number(paymentRatio) / 100 : 1,
          payableDate: payableDate ? dayjs(payableDate).format('YYYY-MM-DD') : null,
          waived: waived === true,
        },
      ];
    }
    const mat = Number(materialAmount);
    if (!(mat > 0)) return [];
    return tranches
      .map((t, i) => ({
        settlementMonth: monthStr,
        periodSeq: i + 1,
        materialAmount: round2((mat * (Number(t.ratio) || 0)) / 100),
        paymentRatio: Number(t.ratio) / 100 || 1,
        payableDate: t.payableDate ? dayjs(t.payableDate).format('YYYY-MM-DD') : null,
        waived: waived === true,
      }))
      .filter((d) => d.materialAmount > 0);
  }, [contractId, monthStr, editing, materialAmount, periodSeq, paymentRatio, payableDate, waived, tranches]);

  // 保存前预览（防抖 400ms；字段没填全时后端会拒，预览失败不打断录入）
  useEffect(() => {
    if (!drafts.length) {
      setPreview([]);
      return;
    }
    let alive = true;
    const timer = setTimeout(async () => {
      setPreviewing(true);
      try {
        const res = await financeApi.previewOverdue({ contractId, drafts });
        if (!alive) return;
        setPreview(res?.rows || []);
        setPreviewStats(res?.stats || {});
      } catch {
        /* 预览失败保持上一次结果，不弹错（保存时后端仍会拦） */
      } finally {
        if (alive) setPreviewing(false);
      }
    }, 400);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [contractId, drafts]);

  const submit = async () => {
    const values = await form.validateFields();
    setSaving(true);
    try {
      if (editing) {
        await financeApi.updateOverdue(editing.id, {
          settlementMonth: dayjs(values.settlementMonth).format('YYYY-MM'),
          periodSeq: values.periodSeq,
          materialAmount: values.materialAmount,
          paymentRatio: values.paymentRatio === null || values.paymentRatio === undefined ? null : round2(Number(values.paymentRatio) / 100),
          payableDate: values.payableDate ? values.payableDate.format('YYYY-MM-DD') : null,
          prevCumulative: values.prevCumulative ?? null,
          waived: values.waived === true,
          remark: values.remark ?? null,
          // 乐观锁：编辑态必须回传 version，否则后端 assertVersion 抛 409
          version: editing.version,
        });
      } else {
        if (!tranches.length) throw new Error('请至少保留一期');
        await financeApi.createOverdue({
          contractId: values.contractId,
          settlementMonth: dayjs(values.settlementMonth).format('YYYY-MM'),
          materialAmount: values.materialAmount,
          tranches: tranches.map((t) => ({
            ratio: round2((Number(t.ratio) || 0) / 100),
            payableDate: t.payableDate ? dayjs(t.payableDate).format('YYYY-MM-DD') : null,
          })),
          prevCumulative: values.prevCumulative ?? null,
          waived: values.waived === true,
          remark: values.remark ?? null,
        });
      }
      message.success('保存成功，已自动重算逾期利息与结算台账');
    } finally {
      setSaving(false);
    }
  };

  return (
    <EditorTabPage
      listPath={LIST_PATH}
      title={editing ? '编辑应付款项' : '新增应付款项'}
      saving={saving}
      dirty={dirty}
      onSave={submit}
    >
      <Alert
        style={{ marginBottom: 12 }}
        type="info"
        showIcon
        message="应付款金额 = 本期材料款金额；逾期起始日期 = 应付款日期 + 宽限期 + 1 天；逾期利息 = 计息金额 × 逾期天数 × 月利率 ÷ 30（含税）。付款在「付款流水」里登记，系统会跨期自动分配。"
      />
      <Form form={form} layout="vertical" onValuesChange={() => setDirty(true)}>
        <Row gutter={16}>
          <Col xs={24} md={12}>
            <Form.Item name="contractId" label="合同" rules={[{ required: true, message: '请选择合同' }]}>
              <Select
                showSearch
                optionFilterProp="label"
                placeholder="请选择合同"
                options={contractOptions}
                disabled={!!editing}
              />
            </Form.Item>
          </Col>
          <Col xs={24} md={12}>
            <Form.Item
              name="settlementMonth"
              label="结算月份"
              rules={[{ required: true, message: '请选择结算月份' }]}
              tooltip="逾期利息按这个月归集；应付款日期默认按付款模式从该月往后推"
            >
              <DatePicker picker="month" format="YYYY-MM" style={{ width: '100%' }} placeholder="选择月份" />
            </Form.Item>
          </Col>
          <Col xs={24} md={12}>
            <Form.Item
              name="materialAmount"
              label="本期材料款金额（不含资金费用）"
              rules={[{ required: true, message: '请输入材料款金额' }]}
            >
              <InputNumber style={{ width: '100%' }} min={0.01} precision={2} />
            </Form.Item>
          </Col>
          {!editing && (
            <Col xs={24} md={12}>
              <Form.Item
                name="paymentMode"
                label="付款模式"
                tooltip="默认取合同当前的付款安排；可按本期实际商定的分期调整"
              >
                <Select
                  placeholder="选择付款模式"
                  options={modes.map((m) => ({ value: m.mode, label: m.label }))}
                />
              </Form.Item>
            </Col>
          )}
          {editing && (
            <>
              <Col xs={24} md={12}>
                <Form.Item name="periodSeq" label="期次" tooltip="同一结算月内第几期">
                  <InputNumber style={{ width: '100%' }} min={1} precision={0} />
                </Form.Item>
              </Col>
              <Col xs={24} md={12}>
                <Form.Item name="paymentRatio" label="付款比例（%）" tooltip="记录用；应付款金额 = 本期材料款金额，不再二次乘比例">
                  <InputNumber style={{ width: '100%' }} min={0} max={100} precision={2} suffix="%" />
                </Form.Item>
              </Col>
              <Col xs={24} md={12}>
                <Form.Item name="payableDate" label="应付款日期" tooltip="留空则该期不参与逾期计息">
                  <DatePicker format="YYYY-MM-DD" style={{ width: '100%' }} />
                </Form.Item>
              </Col>
            </>
          )}
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

      {/* 各期（仅新增态）：比例可调、应付款日期可改 */}
      {!editing && (
        <Card
          size="small"
          title="分期明细"
          extra={
            <Space>
              <span style={{ color: ratioSum === 100 ? 'var(--cms-muted)' : 'var(--cms-warning)' }}>
                比例合计 {ratioSum}%
              </span>
              <Button
                size="small"
                onClick={() =>
                  setTranches((prev) => [...prev, { key: `manual-${Date.now()}`, ratio: 0, payableDate: null }])
                }
              >
                添加一期
              </Button>
              <Button
                size="small"
                // 读 render 期的 watched 值：不要在渲染里直调 form.getFieldValue（未 attach 时会触发 antd 告警）
                onClick={() => applyMode(paymentMode || '100')}
                disabled={!paymentMode}
              >
                按付款模式重填
              </Button>
            </Space>
          }
          style={{ marginBottom: 16 }}
        >
          <Table<any>
            size="small"
            rowKey="key"
            pagination={false}
            dataSource={tranches}
            locale={{ emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="选好付款模式后会自动摊开各期" /> }}
            columns={[
              { title: '期次', width: 70, render: (_: any, __: any, i: number) => i + 1 },
              {
                title: '付款比例（%）',
                width: 160,
                render: (_: any, _row: any, i: number) => (
                  <InputNumber
                    value={tranches[i]?.ratio}
                    min={0}
                    max={100}
                    precision={2}
                    suffix="%"
                    style={{ width: '100%' }}
                    onChange={(v) => {
                      setTranches((prev) => prev.map((t, idx) => (idx === i ? { ...t, ratio: Number(v) || 0 } : t)));
                      setDirty(true);
                    }}
                  />
                ),
              },
              {
                title: '本期材料款（自动）',
                width: 150,
                align: 'right' as const,
                render: (_: any, row: any) => money(round2((Number(materialAmount) || 0) * (Number(row.ratio) || 0) / 100)),
              },
              {
                title: '应付款日期',
                render: (_: any, _row: any, i: number) => (
                  <DatePicker
                    value={tranches[i]?.payableDate ? dayjs(tranches[i].payableDate) : null}
                    format="YYYY-MM-DD"
                    style={{ width: '100%' }}
                    onChange={(d) => {
                      setTranches((prev) => prev.map((t, idx) => (idx === i ? { ...t, payableDate: d } : t)));
                      setDirty(true);
                    }}
                  />
                ),
              },
              {
                title: '操作',
                width: 70,
                render: (_: any, __: any, i: number) => (
                  <Button
                    type="link"
                    size="small"
                    danger
                    onClick={() => {
                      setTranches((prev) => prev.filter((_, idx) => idx !== i));
                      setDirty(true);
                    }}
                  >
                    删除
                  </Button>
                ),
              },
            ]}
          />
        </Card>
      )}

      {/* 保存前预览：派生列由后端引擎现算，与保存结果同源 */}
      <Card
        size="small"
        title="保存前预览（系统计算的派生列）"
        extra={
          <Space size={16}>
            {previewing && <span style={{ color: 'var(--cms-muted)' }}>计算中…</span>}
            <span style={{ color: 'var(--cms-muted)' }}>
              预计合计逾期利息 <b>{money(previewStats.currentCumulative)}</b>
            </span>
          </Space>
        }
      >
        <Table<any>
          size="small"
          rowKey="__k"
          pagination={false}
          loading={previewing}
          dataSource={preview.map((r, i) => ({ ...r, __k: i }))}
          locale={{ emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="填好合同、结算月份与材料款金额后自动预览" /> }}
          columns={[
            { title: '期次', dataIndex: 'periodSeq', width: 70, render: (v: any) => v ?? '-' },
            { title: '本期材料款', dataIndex: 'materialAmount', width: 130, align: 'right' as const, render: money },
            { title: '应付款金额', dataIndex: 'payableAmount', width: 130, align: 'right' as const, render: money },
            { title: '应付款日期', dataIndex: 'payableDate', width: 115, render: dateStr },
            { title: '逾期起始日期', dataIndex: 'overdueStartDate', width: 120, render: dateStr },
            { title: '已付金额', dataIndex: 'paidAmount', width: 115, align: 'right' as const, render: money },
            { title: '未付余额', dataIndex: 'remaining', width: 115, align: 'right' as const, render: money },
            { title: '逾期天数', dataIndex: 'overdueDays', width: 95, align: 'right' as const, render: (v: any) => v ?? '-' },
            {
              title: '预计逾期利息',
              dataIndex: 'overdueInterest',
              width: 140,
              align: 'right' as const,
              render: (v: any) => <b>{money(v)}</b>,
            },
          ]}
        />
        {params && (
          <div style={{ marginTop: 8, color: 'var(--cms-muted)' }}>
            本合同参数：延期月利率 {(Number(params.monthlyRate) * 100).toFixed(2)}% · 宽限期 {params.graceDays} 天 ·
            利息上限比例 {(Number(params.interestCapRatio) * 100).toFixed(1)}%
          </div>
        )}
      </Card>
    </EditorTabPage>
  );
}

