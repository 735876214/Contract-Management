import { useEffect, useMemo, useState } from 'react';
import { Alert, Button, Card, Col, Row, Select, Space, Statistic, Switch, Table, Tag, Typography } from 'antd';
import { AuditOutlined } from '@ant-design/icons';
import type { ColumnsType } from 'antd/es/table';
import dayjs from 'dayjs';
import { aiApi, type AiFulfillmentFinding, type AiFulfillmentResult } from '@/api/modules';
import { contractApi } from '@/api/business';
import { coverageState } from '../utils/aiCoverage';
import EmptyState from '@/components/EmptyState';

const { Text, Paragraph } = Typography;

/**
 * 命中码 → 中文名。
 *
 * 与 `server/src/modules/ai/fulfillment/fulfillment-types.ts` 的 `FULFILLMENT_CODE_LABELS`
 * 保持一致；这里再存一份是为了筛选下拉与表格在没有接口返回时也能说清「这条是什么规则」。
 * 后端新增规则码时此表要同步加一行（未登记的码会原样显示，不会静默变空白）。
 */
const CODE_LABELS: Record<string, string> = {
  C1_OVERDUE: '节点逾期未完成',
  C2_DONE_NO_ACTUAL: '完成未填实际日期',
  C3_SEQUENCE_INVERTED: '节点顺序倒挂',
  C4_FINISH_LATE: '完成滞后于计划',
  C5_PLAN_BEFORE_SIGN: '计划早于合同签订',
  C6_PROGRESS_PAYMENT_GAP: '付款快于履约',
  C7_SETTLED_UNFINISHED: '已结算却未完工',
  C8_NO_MILESTONE: '签章合同无履约节点',
};

const ENTITY_LABELS: Record<string, string> = {
  milestone: '履约节点',
  contract: '合同',
};

const LEVEL_META = {
  HIGH: { label: '高', color: 'red' },
  MEDIUM: { label: '需复核', color: 'orange' },
} as const;

/**
 * 合同履行偏差预警面板（课题 4-9）。
 *
 * 定位与 6-9 / 3-9 的面板一致：**这是核对清单，不是结论页**。
 * - 命中判定与全部天数/比例由服务端纯函数规则算出（有真值夹具锁），模型只把命中翻成业务语言；
 * - 面板**只读**：不提供「一键改节点/一键付款」，避免预警自己动业务数据；
 * - 「未判定」与「样本量」必须同时可见 —— 只说「没命中」会把人误导成「履约没问题」。
 */
export default function FulfillmentAnomalyPanel() {
  const [contractId, setContractId] = useState<string>('');
  const [useAi, setUseAi] = useState(true);
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<AiFulfillmentResult | null>(null);
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
      const res = await aiApi.fulfillmentAnomaly({
        contractId: contractId || undefined,
        narrative: useAi ? undefined : '0',
      });
      setResult(res);
    } catch {
      // 拦截器已弹错；保留上一次结果，避免用户以为「扫完没问题」
    } finally {
      setLoading(false);
    }
  };

  const coverage = result ? coverageState(result) : { ok: false, sampled: 0, reason: '' };
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

  const columns: ColumnsType<AiFulfillmentFinding> = [
    {
      title: '等级',
      dataIndex: 'level',
      width: 84,
      render: (v: AiFulfillmentFinding['level']) => {
        // 后端只发 HIGH/MEDIUM；将来加了新等级也原样显示，不渲染崩
        const meta = LEVEL_META[v] ?? { label: v, color: 'default' as const };
        return <Tag color={meta.color}>{meta.label}</Tag>;
      },
    },
    {
      title: '类型',
      dataIndex: 'code',
      width: 160,
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
  ];

  return (
    <Card
      title={
        <Space>
          <AuditOutlined />
          <span>AI 助手 · 合同履行偏差预警</span>
        </Space>
      }
    >
      <Alert
        type="info"
        showIcon
        style={{ marginBottom: 12 }}
        message="规则先算，AI 后说：逾期天数、完成率、付款差额全由系统计算，AI 只把结果翻译成项目上能看懂的话"
        description="本页只读，不改履约节点、不改付款状态。命中项一律是「建议核查」，不构成违约定性。"
      />

      <Space wrap size={16} align="center" style={{ width: '100%', marginBottom: 12 }}>
        <span>
          <Text type="secondary">合同 </Text>
          <Select
            showSearch
            allowClear
            style={{ width: 320 }}
            placeholder="本项目全部在履行合同"
            value={contractId || undefined}
            optionFilterProp="label"
            onChange={(v) => setContractId(v || '')}
            options={contracts.map((c) => ({
              value: c.id,
              label: `${c.code || ''} ${c.name || ''}`.trim(),
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
          description="选合同（或留空扫全项目）后点「开始扫描」。节点越全，逾期与进度背离越容易被发现。"
          height={200}
        />
      )}

      {result && !result.enabled && (
        <Alert
          type="warning"
          showIcon
          style={{ marginBottom: 12 }}
          message="预警已在系统参数里停用"
          description="未执行任何判定。需要启用请到「系统管理 → 系统参数」把 ai.fulfillment.enabled 设为 1。"
        />
      )}

      {result && result.warnings.length > 0 && (
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

      {result && (
        <>
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
              阈值：逾期宽限 {result.tolerances.graceDays} 天（逾期 &gt; 30 天升级高风险）/ 完成滞后容忍{' '}
              {result.tolerances.lateFinishDays} 天 / 付款比例高于完成率 &gt; {result.tolerances.progressGapPct} 个百分点
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
              message={coverage.ok ? `所选范围内未发现命中` : '未命中，但不能视作「已核对通过」'}
              description={coverage.ok ? '规则全部执行且数据齐全，可以按已核对处理。' : coverage.reason}
            />
          ) : (
            <Table<AiFulfillmentFinding>
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
                        对象类型：
                      </Text>
                      <Tag>{ENTITY_LABELS[r.entity] || r.entity}</Tag>
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
                    style={{ width: 200 }}
                    value={codeFilter}
                    onChange={(v) => setCodeFilter(v)}
                    options={codeOptions}
                  />
                  <Text type="secondary" style={{ fontSize: 12 }}>
                    点行首箭头展开判定依据（每一条都写明比对了哪些日期与金额）
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
