import { useEffect, useMemo, useState } from 'react';
import { formatAmount } from '@/utils/money';
import {
  Alert,
  Button,
  Card,
  Col,
  DatePicker,
  Row,
  Select,
  Space,
  Statistic,
  Switch,
  Table,
  Tag,
  Typography,
} from 'antd';
import { SafetyCertificateOutlined } from '@ant-design/icons';
import type { ColumnsType } from 'antd/es/table';
import dayjs, { type Dayjs } from 'dayjs';
import { aiApi, type AiAnomalyFinding, type AiAnomalyResult, type AiAnomalyWindow } from '@/api/modules';
import { contractApi } from '@/api/business';
import { coverageState } from '../utils/aiCoverage';
import EmptyState from '@/components/EmptyState';

const { Text, Paragraph } = Typography;
const { RangePicker } = DatePicker;

/**
 * 命中码 → 中文名。
 *
 * 与 `server/src/modules/ai-insight/anomaly/anomaly-types.ts` 的 `ANOMALY_CODE_LABELS` 保持一致；
 * 这里再存一份是为了筛选下拉和表格在没有接口返回时也能说清"这条是什么规则"。
 * 后端新增规则码时，此表要同步加一行（未登记的码会原样显示代码，不会静默变空白）。
 */
const CODE_LABELS: Record<string, string> = {
  R1_DUP_ACROSS_PERIOD: '疑似重复结算（跨期）',
  R1_DUP_MATERIAL_QTY: '同一物资重复计量',
  R1_FINAL_SNAPSHOT_DRIFT: '总结算单与月度结算金额不一致',
  R2_OVERPAY: '付款超过应付比例',
  R3_PAY_WITHOUT_CONTRACT: '付款缺少有效合同',
  R4_INVOICE_MISMATCH: '发票金额与结算金额不一致',
  R5_SETTLE_BEFORE_RECEIPT: '结算早于收领单日期',
  R6_PROCEDURE_SNAPSHOT_DRIFT: '付款手续开累金额与台账不一致',
};

const ENTITY_LABELS: Record<string, string> = {
  contract: '合同',
  settlement: '结算单',
  payment: '付款',
  procedure: '付款手续',
};

const LEVEL_META = {
  HIGH: { label: '高', color: 'red' },
  MEDIUM: { label: '中', color: 'orange' },
} as const;

/** 金额（后端可能以字符串下发 Decimal；非数字/空值统一 `-`） */
const money = (v: any) => formatAmount(v);

/**
 * 结算 / 付款异常预警面板（课题 6-9）。
 *
 * 定位：**这是核对清单，不是结论页**。
 * - 所有判定由服务端纯函数规则给出（有真值夹具锁），模型只把命中翻成业务语言；
 * - 面板**只读**：不提供"一键处理"，避免预警自己改单据；
 * - 「未判定」与「样本量」必须同时可见 —— 只说"0 命中"会把人误导成"账没问题"。
 */
export default function AnomalyPanel() {
  // 默认**近 12 个自然月**（含本月）：与后端缺省区间同口径，用户不用点「开始扫描」就知道算哪一段
  const [range, setRange] = useState<[Dayjs, Dayjs]>([
    dayjs().subtract(11, 'month').startOf('month'),
    dayjs(),
  ]);
  /** 区间口径（默认跨度/上限）从后端取：改系统参数后这里自动跟上，前端不写死数字 */
  const [windowLimit, setWindowLimit] = useState<{ defaultMonths: number; maxMonths: number } | null>(null);
  /** 区间超上限时的待确认项（null = 无需确认） */
  const [pendingRange, setPendingRange] = useState<AiAnomalyWindow | null>(null);
  const [contractId, setContractId] = useState<string>('');
  const [useAi, setUseAi] = useState(true);
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<AiAnomalyResult | null>(null);
  const [levelFilter, setLevelFilter] = useState<'ALL' | 'HIGH' | 'MEDIUM'>('ALL');
  const [codeFilter, setCodeFilter] = useState<string>('ALL');
  const [contracts, setContracts] = useState<any[]>([]);

  useEffect(() => {
    contractApi
      .options()
      .then((res: any) => setContracts(res || []))
      .catch(() => setContracts([]));
  }, []);

  useEffect(() => {
    // 只为了把「默认近 N 个月 / 超过 M 个月要确认」写准：取不到就不显示，不编数字
    aiApi
      .anomalyWindow({})
      .then((res) => setWindowLimit({ defaultMonths: res.defaultMonths, maxMonths: res.maxMonths }))
      .catch(() => setWindowLimit(null));
  }, []);

  const doScan = async (force: boolean) => {
    setLoading(true);
    try {
      const res = await aiApi.paymentAnomaly({
        from: range[0].format('YYYY-MM-DD'),
        to: range[1].format('YYYY-MM-DD'),
        contractId: contractId || undefined,
        narrative: useAi ? undefined : '0',
        force: force ? '1' : undefined,
      });
      setResult(res);
    } catch {
      // 拦截器已弹错；保留上一次结果，避免用户以为"扫完没问题"
    } finally {
      setLoading(false);
    }
  };

  /**
   * 扫描前先做一次**区间体检**：
   * - 区间超过取数上限时，后端会硬拒（400），但界面上先问一句更省事——
   *   用户点「仍然扫描」等于明确知道「这次会慢」，而不是被一个红条挡住再自己猜怎么继续；
   * - 月份**不在前端算**：默认跨度与上限都是系统参数，前端算必然与后端漂移。
   */
  const scan = async () => {
    const from = range[0].format('YYYY-MM-DD');
    const to = range[1].format('YYYY-MM-DD');
    let check: Awaited<ReturnType<typeof aiApi.anomalyWindow>> | null = null;
    try {
      check = await aiApi.anomalyWindow({ from, to });
    } catch {
      // 体检接口不通不该挡扫描：真正的口径仍由扫描接口把关（超限会 400 并说清原因）
      check = null;
    }
    if (check && !check.allowed) {
      // 超上限：**不直接扫、也不弹层**，就在页面上挂一条可确认的提示（理由见下面的 Alert 注释）
      setPendingRange(check);
      return;
    }
    setPendingRange(null);
    await doScan(false);
  };

  const coverage = result
    ? coverageState({ ...result, requiredSample: ['结算单'] })
    : { ok: false, sampled: 0, reason: '' };
  const findings = useMemo(() => {
    const list = result?.findings || [];
    return list.filter(
      (f) => (levelFilter === 'ALL' || f.level === levelFilter) && (codeFilter === 'ALL' || f.code === codeFilter),
    );
  }, [result, levelFilter, codeFilter]);

  const codeOptions = useMemo(() => {
    const used = new Set((result?.findings || []).map((f) => f.code));
    return [
      { value: 'ALL', label: '全部类型' },
      ...Array.from(used).map((c) => ({ value: c, label: CODE_LABELS[c] || c })),
    ];
  }, [result]);

  const columns: ColumnsType<AiAnomalyFinding> = [
    {
      title: '等级',
      dataIndex: 'level',
      width: 72,
      render: (v: AiAnomalyFinding['level']) => {
        // 后端只发 HIGH/MEDIUM；万一将来加了新等级，原样显示而不是渲染崩掉
        const meta = LEVEL_META[v] ?? { label: v, color: 'default' as const };
        return <Tag color={meta.color}>{meta.label}</Tag>;
      },
    },
    {
      title: '类型',
      dataIndex: 'code',
      width: 200,
      render: (v: string) => CODE_LABELS[v] || v,
    },
    {
      title: '命中内容',
      dataIndex: 'title',
      render: (v: string) => <span style={{ color: 'var(--cms-ink)' }}>{v}</span>,
    },
    {
      title: '对象',
      dataIndex: 'entity',
      width: 96,
      render: (v: string) => <Tag>{ENTITY_LABELS[v] || v}</Tag>,
    },
    {
      title: '差额（元）',
      dataIndex: 'amountDiff',
      width: 130,
      align: 'right',
      render: (v: string | null) =>
        v === null ? (
          <Text type="secondary">-</Text>
        ) : (
          <Text style={{ color: 'var(--cms-danger)' }}>{money(v)}</Text>
        ),
    },
  ];

  return (
    <Card
      title={
        <Space>
          <SafetyCertificateOutlined />
          <span>AI 助手 · 结算与付款异常预警</span>
        </Space>
      }
    >
      <Alert
        type="info"
        showIcon
        style={{ marginBottom: 12 }}
        message="规则先算，AI 后说：命中判定和每一笔金额都由系统计算，AI 只把结果翻译成业务语言"
        description="本页只读，不修改任何单据。请逐条核对原始凭证后再决定是否处理。"
      />

      <Space wrap size={16} align="center" style={{ width: '100%', marginBottom: 12 }}>
        <span>
          <Text type="secondary">统计区间 </Text>
          <RangePicker
            value={range}
            allowClear={false}
            presets={[
              { label: '近 12 个月', value: [dayjs().subtract(11, 'month').startOf('month'), dayjs()] },
              { label: '本月', value: [dayjs().startOf('month'), dayjs().endOf('month')] },
              {
                label: '上月',
                value: [dayjs().subtract(1, 'month').startOf('month'), dayjs().subtract(1, 'month').endOf('month')],
              },
              {
                label: '近三月',
                value: [dayjs().subtract(2, 'month').startOf('month'), dayjs().endOf('month')],
              },
              { label: '今年', value: [dayjs().startOf('year'), dayjs().endOf('year')] },
            ]}
            onChange={(v) => {
              if (!v || !v[0] || !v[1]) return;
              setRange([v[0], v[1]]);
              setPendingRange(null); // 区间变了，旧的超限确认作废
            }}
          />
          {windowLimit && (
            <Text type="secondary" style={{ fontSize: 12, marginLeft: 8 }}>
              默认近 {windowLimit.defaultMonths} 个月，超过 {windowLimit.maxMonths} 个月需确认后继续
            </Text>
          )}
        </span>
        <span>
          <Text type="secondary">合同 </Text>
          <Select
            showSearch
            allowClear
            style={{ width: 260 }}
            placeholder="全部合同"
            value={contractId || undefined}
            optionFilterProp="label"
            onChange={(v) => setContractId(v || '')}
            options={contracts.map((c) => ({ value: c.id, label: `${c.code} ${c.name}` }))}
          />
        </span>
        <span>
          <Text type="secondary">AI 措辞 </Text>
          <Switch checked={useAi} onChange={setUseAi} />
        </span>
        <Button type="primary" icon={<SafetyCertificateOutlined />} loading={loading} onClick={scan}>
          开始扫描
        </Button>
      </Space>

      {pendingRange && (
        <Alert
          type="warning"
          showIcon
          style={{ marginBottom: 12 }}
          message="统计区间超过取数上限"
          description={
            <Space direction="vertical" size={8}>
              <span>{pendingRange.message}</span>
              {/*
                为什么是页内确认条而不是弹层：这段说明较长，弹层会把结果区整块挡住；
                而且「确认后继续」是页面上的一次状态切换，用按钮表达比模态更直观（也更好自动核验）。
              */}
              <Space wrap>
                <Button
                  size="small"
                  type="primary"
                  onClick={() => {
                    setPendingRange(null);
                    void doScan(true);
                  }}
                >
                  仍然扫描（覆盖 {pendingRange.months} 个月）
                </Button>
                <Button size="small" onClick={() => setPendingRange(null)}>
                  缩小区间
                </Button>
              </Space>
            </Space>
          }
        />
      )}

      {!result && !loading && (
        <EmptyState
          description="选好统计区间后点「开始扫描」。区间越大命中越全，也越慢。"
          height={200}
        />
      )}

      {result && (
        <>
          {!result.enabled && (
            <Alert
              type="warning"
              showIcon
              style={{ marginBottom: 12 }}
              message="预警已在系统参数里停用"
              description="未执行任何判定。需要启用请到「系统管理 → 系统参数」把 ai.anomaly.enabled 设为 1。"
            />
          )}

          {result.warnings.length > 0 && (
            <Alert
              type="warning"
              showIcon
              style={{ marginBottom: 12 }}
              message="数据侧提醒"
              description={
                <ul style={{ margin: 0, paddingLeft: 18 }}>
                  {result.warnings.map((w) => (
                    <li key={w}>{w}</li>
                  ))}
                </ul>
              }
            />
          )}

          <Row gutter={16} style={{ marginBottom: 12 }}>
            <Col xs={12} md={6} lg={4}>
              <Statistic title="命中合计" value={result.summary.total} />
            </Col>
            <Col xs={12} md={6} lg={4}>
              <Statistic
                title="高风险"
                value={result.summary.high}
                valueStyle={result.summary.high > 0 ? { color: 'var(--cms-danger)' } : undefined}
              />
            </Col>
            <Col xs={12} md={6} lg={4}>
              <Statistic title="中风险" value={result.summary.medium} />
            </Col>
            <Col xs={12} md={6} lg={4}>
              <Statistic title="未判定规则" value={result.notEvaluated.length} />
            </Col>
            <Col xs={24} lg={8}>
              <div style={{ paddingTop: 6 }}>
                <Text type="secondary" style={{ fontSize: 12 }}>
                  扫描时间 {dayjs(result.generatedAt).format('YYYY-MM-DD HH:mm')} · 区间{' '}
                  {result.period.from || '不限'} ~ {result.period.to || '不限'}
                  {result.period.months != null && ` · 覆盖 ${result.period.months} 个自然月`}
                  {result.period.maxMonths != null && `（上限 ${result.period.maxMonths}）`}
                  {result.period.defaulted && ' · 系统默认区间'}
                  {result.period.forced && ' · 已确认超过上限'}
                </Text>
              </div>
            </Col>
          </Row>

          <div style={{ marginBottom: 12 }}>
            <Text type="secondary">参与判定：</Text>
            {Object.entries(result.sample).map(([k, v]) => (
              <Tag key={k} style={{ marginInlineEnd: 6 }}>
                {k} {v}
              </Tag>
            ))}
            <Text type="secondary" style={{ marginLeft: 8, fontSize: 12 }}>
              容差：金额 {result.tolerances.amount} 元 / 数量 {result.tolerances.qtyPct}% / 明细重合度{' '}
              {result.tolerances.jaccard}
            </Text>
          </div>

          <Card
            size="small"
            title={
              <Space>
                <span>结论与建议</span>
                {result.narrative.source === 'llm' ? (
                  <Tag color="green">AI 措辞（数字已对账）</Tag>
                ) : (
                  <Tag>模板结论</Tag>
                )}
              </Space>
            }
            style={{ marginBottom: 12, background: 'var(--cms-canvas)' }}
          >
            <Paragraph style={{ marginBottom: 8 }}>{result.narrative.conclusion}</Paragraph>
            {result.narrative.actions.length > 0 && (
              <ol style={{ margin: 0, paddingLeft: 20 }}>
                {result.narrative.actions.map((a, i) => (
                  <li key={i}>{a}</li>
                ))}
              </ol>
            )}
            {result.narrative.unknownNumbers.length > 0 && (
              <Alert
                type="error"
                showIcon
                style={{ marginTop: 12 }}
                message="以下数字未在系统数据中找到，已退回模板结论，请勿直接引用"
                description={result.narrative.unknownNumbers.join('、')}
              />
            )}
          </Card>

          {result.notEvaluated.length > 0 && (
            <Alert
              type="info"
              showIcon
              style={{ marginBottom: 12 }}
              message={`有 ${result.notEvaluated.length} 条规则因数据缺失没跑成：未判定 ≠ 没问题`}
              description={
                <ul style={{ margin: 0, paddingLeft: 18 }}>
                  {result.notEvaluated.map((n) => (
                    <li key={n}>{n}</li>
                  ))}
                </ul>
              }
            />
          )}

          {result.summary.total === 0 ? (
            <Alert
              type={coverage.ok ? 'success' : 'warning'}
              showIcon
              message={coverage.ok ? `所选区间内未发现命中` : '未命中，但不能视作「已核对通过」'}
              description={coverage.ok ? '规则全部执行且数据齐全，可以按已核对处理。' : coverage.reason}
            />
          ) : (
            <Table<AiAnomalyFinding>
              rowKey={(r) => `${r.code}-${r.entityId}-${r.title}`}
              size="small"
              // 表格必须声明 scroll（DESIGN.md §10.1 第 2 条）：窄屏下让表格内部横滑，不压扁列
              scroll={{ x: 760 }}
              loading={loading}
              columns={columns}
              dataSource={findings}
              pagination={{ pageSize: 20, hideOnSinglePage: true }}
              expandable={{
                expandedRowRender: (r) => (
                  <div style={{ paddingLeft: 8 }}>
                    <Paragraph style={{ marginBottom: 8 }}>
                      <Text type="secondary">单据 ID：</Text>
                      <Text code>{r.entityId}</Text>
                    </Paragraph>
                    <table style={{ borderCollapse: 'collapse', fontSize: 13 }}>
                      <tbody>
                        {Object.entries(r.facts).map(([k, v]) => (
                          <tr key={k}>
                            <td style={{ padding: '2px 16px 2px 0', color: 'var(--cms-ink-2)' }}>{k}</td>
                            <td style={{ padding: '2px 0' }}>{v}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                ),
              }}
              title={() => (
                <Space wrap>
                  <Select
                    size="small"
                    style={{ width: 130 }}
                    value={levelFilter}
                    onChange={(v) => setLevelFilter(v)}
                    options={[
                      { value: 'ALL', label: '全部等级' },
                      { value: 'HIGH', label: '仅高风险' },
                      { value: 'MEDIUM', label: '仅中风险' },
                    ]}
                  />
                  <Select
                    size="small"
                    style={{ width: 220 }}
                    value={codeFilter}
                    onChange={(v) => setCodeFilter(v)}
                    options={codeOptions}
                  />
                  <Text type="secondary" style={{ fontSize: 12 }}>
                    点行首箭头展开判定依据（每一条都写明比对了哪些数）
                  </Text>
                </Space>
              )}
              locale={{
                emptyText: (
                  <EmptyState compact description="当前筛选条件下没有命中，换个等级或类型看看" />
                ),
              }}
            />
          )}
        </>
      )}
    </Card>
  );
}
