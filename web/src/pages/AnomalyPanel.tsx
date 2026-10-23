import { useEffect, useMemo, useState } from 'react';
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
import { aiApi, type AiAnomalyFinding, type AiAnomalyResult } from '@/api/modules';
import { contractApi } from '@/api/business';
import { coverageState } from '../utils/aiCoverage';
import EmptyState from '@/components/EmptyState';

const { Text, Paragraph } = Typography;
const { RangePicker } = DatePicker;

/**
 * 命中码 → 中文名。
 *
 * 与 `server/src/modules/ai/anomaly/anomaly-types.ts` 的 `ANOMALY_CODE_LABELS` 保持一致；
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

const money = (v: string | null) => {
  if (v === null || v === undefined || v === '') return '-';
  const n = Number(v);
  return Number.isFinite(n)
    ? n.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
    : v;
};

/**
 * 结算 / 付款异常预警面板（课题 6-9）。
 *
 * 定位：**这是核对清单，不是结论页**。
 * - 所有判定由服务端纯函数规则给出（有真值夹具锁），模型只把命中翻成业务语言；
 * - 面板**只读**：不提供"一键处理"，避免预警自己改单据；
 * - 「未判定」与「样本量」必须同时可见 —— 只说"0 命中"会把人误导成"账没问题"。
 */
export default function AnomalyPanel() {
  const [range, setRange] = useState<[Dayjs, Dayjs]>([
    dayjs().subtract(2, 'month').startOf('month'),
    dayjs().endOf('month'),
  ]);
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

  const scan = async () => {
    setLoading(true);
    try {
      const res = await aiApi.paymentAnomaly({
        from: range[0].format('YYYY-MM-DD'),
        to: range[1].format('YYYY-MM-DD'),
        contractId: contractId || undefined,
        narrative: useAi ? undefined : '0',
      });
      setResult(res);
    } catch {
      // 拦截器已弹错；保留上一次结果，避免用户以为"扫完没问题"
    } finally {
      setLoading(false);
    }
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
            onChange={(v) => v && v[0] && v[1] && setRange([v[0], v[1]])}
          />
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
