import { useEffect, useMemo, useState } from 'react';
import { Alert, Button, Card, Col, Row, Select, Space, Statistic, Switch, Table, Tag, Typography } from 'antd';
import { AuditOutlined } from '@ant-design/icons';
import type { ColumnsType } from 'antd/es/table';
import dayjs from 'dayjs';
import { aiApi, procurementTaskApi, type AiQuoteFinding, type AiQuoteResult } from '@/api/modules';
import EmptyState from '@/components/EmptyState';

const { Text, Paragraph } = Typography;

/**
 * 命中码 → 中文名。
 *
 * 与 `server/src/modules/ai/quote/quote-types.ts` 的 `QUOTE_CODE_LABELS` 保持一致；
 * 这里再存一份是为了筛选下拉与表格在没有接口返回时也能说清「这条是什么规则」。
 * 后端新增规则码时此表要同步加一行（未登记的码会原样显示，不会静默变空白）。
 */
const CODE_LABELS: Record<string, string> = {
  B1_DROP_EXCESS: '二轮降幅超阈值',
  B1_DROP_INVERTED: '二轮报价高于一轮',
  B2_SPREAD_TOO_LOW: '首轮报价高度一致',
  B3_OVER_BUDGET: '成交价超控制价',
  B3_UNDER_BUDGET: '成交价显著低于控制价',
  B4_PRICE_OVER_CONTROL: '单行成交单价超控制价',
  B4_PRICE_VS_MARKET: '单价偏离市场价',
  B5_TAX_RATE_INVALID: '税率不在常用集合',
  B5_TAX_RATE_DRIFT: '两轮税率不一致',
  B6_NOT_LOWEST: '成交价非最低有效报价',
  B7_FEW_BIDDERS: '有效报价家数不足',
  B7_WINNER_NO_PRICE: '中标单位缺报价',
};

const ENTITY_LABELS: Record<string, string> = {
  task: '采购任务',
  bidder: '响应单位',
  totalItem: '清单行',
};

const LEVEL_META = {
  HIGH: { label: '高', color: 'red' },
  MEDIUM: { label: '需复核', color: 'orange' },
} as const;

const money = (v: string | null) => {
  if (v === null || v === undefined || v === '') return '-';
  const n = Number(v);
  return Number.isFinite(n)
    ? n.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
    : v;
};

/**
 * 异常报价与价差预警面板（课题 3-9）。
 *
 * 定位与 6-9 的 `AnomalyPanel` 一致：**这是核对清单，不是结论页**。
 * - 命中判定与全部金额/比例由服务端纯函数规则算出（有真值夹具锁），模型只把命中翻成业务语言；
 * - 面板**只读**：不提供「一键定标 / 一键改价」，避免预警自己动业务数据；
 * - 「未判定」与「样本量」必须同时可见 —— 只说「0 命中」会把人误导成「报价没问题」。
 */
export default function QuoteAnomalyPanel() {
  const [taskId, setTaskId] = useState<string>('');
  const [useAi, setUseAi] = useState(true);
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<AiQuoteResult | null>(null);
  const [levelFilter, setLevelFilter] = useState<'ALL' | 'HIGH' | 'MEDIUM'>('ALL');
  const [codeFilter, setCodeFilter] = useState<string>('ALL');
  const [tasks, setTasks] = useState<any[]>([]);

  useEffect(() => {
    // 采购任务下拉：兼容分页包装（`{ list }` / `{ items }`）与直接返回数组两种形状
    procurementTaskApi
      .list({ page: 1, pageSize: 200 })
      .then((res: any) => setTasks(Array.isArray(res) ? res : res?.list || res?.items || []))
      .catch(() => setTasks([]));
  }, []);

  const scan = async () => {
    setLoading(true);
    try {
      const res = await aiApi.quoteAnomaly({
        taskId: taskId || undefined,
        narrative: useAi ? undefined : '0',
      });
      setResult(res);
    } catch {
      // 拦截器已弹错；保留上一次结果，避免用户以为「扫完没问题」
    } finally {
      setLoading(false);
    }
  };

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

  const columns: ColumnsType<AiQuoteFinding> = [
    {
      title: '等级',
      dataIndex: 'level',
      width: 84,
      render: (v: AiQuoteFinding['level']) => {
        // 后端只发 HIGH/MEDIUM；将来加了新等级也原样显示，不渲染崩
        const meta = LEVEL_META[v] ?? { label: v, color: 'default' as const };
        return <Tag color={meta.color}>{meta.label}</Tag>;
      },
    },
    {
      title: '类型',
      dataIndex: 'code',
      width: 180,
      render: (v: string) => CODE_LABELS[v] || v,
    },
    {
      title: '采购编号',
      dataIndex: 'taskNo',
      width: 170,
      render: (v: string) => <Text code>{v || '-'}</Text>,
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
        v === null ? <Text type="secondary">-</Text> : <Text style={{ color: 'var(--cms-danger)' }}>{money(v)}</Text>,
    },
  ];

  return (
    <Card
      title={
        <Space>
          <AuditOutlined />
          <span>AI 助手 · 异常报价与价差预警</span>
        </Space>
      }
    >
      <Alert
        type="info"
        showIcon
        style={{ marginBottom: 12 }}
        message="规则先算，AI 后说：降幅、离散度、价差全由系统计算，AI 只把结果翻译成采购能看懂的话"
        description="本页只读，不改采购任务状态、不改报价数据。命中项一律是「建议核查」，不构成定性结论。"
      />

      <Space wrap size={16} align="center" style={{ width: '100%', marginBottom: 12 }}>
        <span>
          <Text type="secondary">采购任务 </Text>
          <Select
            showSearch
            allowClear
            style={{ width: 320 }}
            placeholder="本项目全部采购任务"
            value={taskId || undefined}
            optionFilterProp="label"
            onChange={(v) => setTaskId(v || '')}
            options={tasks.map((t) => ({
              value: t.id,
              label: `${t.taskNo || ''} ${t.content || ''}`.trim(),
            }))}
          />
        </span>
        <span>
          <Text type="secondary">AI 措辞 </Text>
          <Switch checked={useAi} onChange={setUseAi} />
        </span>
        <Button type="primary" icon={<AuditOutlined />} loading={loading} onClick={scan}>
          开始扫描
        </Button>
      </Space>

      {!result && !loading && (
        <EmptyState
          description="选采购任务（或留空扫全项目）后点「开始扫描」。任务越多命中越全，也越慢。"
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
              description="未执行任何判定。需要启用请到「系统管理 → 系统参数」把 ai.quote.enabled 设为 1。"
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
              <Statistic title="需复核" value={result.summary.medium} />
            </Col>
            <Col xs={12} md={6} lg={4}>
              <Statistic title="未判定规则" value={result.notEvaluated.length} />
            </Col>
            <Col xs={24} lg={8}>
              <div style={{ paddingTop: 6 }}>
                <Text type="secondary" style={{ fontSize: 12 }}>
                  扫描时间 {dayjs(result.generatedAt).format('YYYY-MM-DD HH:mm')} · 范围 {result.scope}
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
              阈值：金额容差 {result.tolerances.amount} 元 / 二轮降幅 &gt; {result.tolerances.dropPct}% / 首轮离散系数 &lt;{' '}
              {result.tolerances.spreadPct}% / 成交价 &lt; 控制价 {result.tolerances.underBudgetPct}% / 单价偏离市场价 ±
              {result.tolerances.priceDevPct}% / 税率差 &gt; {(result.tolerances.taxRateToleranceBp / 100).toFixed(2)} 个百分点 /
              有效报价 &lt; {result.tolerances.minBidders} 家
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
              type="success"
              showIcon
              message="所选范围内的采购任务未发现命中"
              description={
                result.notEvaluated.length > 0
                  ? `注意：仍有 ${result.notEvaluated.length} 条规则未判定（见上），这部分任务等于没检查。`
                  : '所有规则均已执行且无命中，可以按已核对处理。'
              }
            />
          ) : (
            <Table<AiQuoteFinding>
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
                      <Text type="secondary">对象 ID：</Text>
                      <Text code>{r.entityId}</Text>
                      <Text type="secondary" style={{ marginLeft: 16 }}>
                        采购任务：
                      </Text>
                      <Text code>{r.taskNo || r.taskId}</Text>
                    </Paragraph>
                    <ul style={{ margin: 0, paddingLeft: 18, fontSize: 13 }}>
                      {r.facts.map((f) => (
                        <li key={f}>{f}</li>
                      ))}
                    </ul>
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
                      { value: 'MEDIUM', label: '仅需复核' },
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
                emptyText: <EmptyState compact description="当前筛选条件下没有命中，换个等级或类型看看" />,
              }}
            />
          )}
        </>
      )}
    </Card>
  );
}
