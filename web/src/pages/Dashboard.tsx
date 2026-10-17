import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Alert, Button, Card, Col, Row, Space, Statistic, List, Tag, Spin } from 'antd';
import { FileTextOutlined, AccountBookOutlined, WalletOutlined } from '@ant-design/icons';
import ReactECharts from 'echarts-for-react';
import dayjs from 'dayjs';
import { dashboardApi } from '@/api/modules';
import { contractApi } from '@/api/business';
import { useDictStore } from '@/store/dict';
import { chartPalette } from '@/theme';
import { useContainerWidth } from '@/hooks/useContainerWidth';
import EmptyState from '@/components/EmptyState';
import { TodoCard, DashboardNoticeModal } from './dashboardTodo';

const money = (v: number) => `¥${(v || 0).toLocaleString('zh-CN', { maximumFractionDigits: 2 })}`;

/** 草稿超时阈值（需求 2.1.3：新增后 2 小时内未完成） */
const OVERDUE_HOURS = 2;
/** 工作台超时提醒自动刷新间隔：5 分钟 */
const OVERDUE_CHECK_INTERVAL = 5 * 60 * 1000;

/**
 * 合同草稿超时提醒（需求 2.1.3）
 * 每次挂载时检查一次，之后每 5 分钟自动刷新；点击提醒跳转合同起草页；
 * 草稿提交（execStatus 变更）或删除后，下一次检查自动消除。
 */
function OverdueDraftReminder() {
  const navigate = useNavigate();
  const [overdue, setOverdue] = useState<any[]>([]);

  useEffect(() => {
    let alive = true;
    const check = () =>
      contractApi
        .drafts()
        .then((res: any) => {
          if (!alive) return;
          const list = Array.isArray(res) ? res : res?.list || [];
          setOverdue(list.filter((c: any) => dayjs().diff(dayjs(c.createdAt), 'minute') >= OVERDUE_HOURS * 60));
        })
        .catch(() => undefined);
    check();
    const timer = window.setInterval(check, OVERDUE_CHECK_INTERVAL);
    return () => {
      alive = false;
      window.clearInterval(timer);
    };
  }, []);

  if (!overdue.length) return null;
  return (
    <Alert
      type="warning"
      showIcon
      style={{ marginBottom: 16 }}
      message={
        <span>
          您有 {overdue.length} 份合同草稿已超时未完成，请及时处理
          <Button type="link" size="small" onClick={() => navigate('/contract/draft')}>
            前往处理
          </Button>
        </span>
      }
      description={
        <ul style={{ margin: 0, paddingLeft: 18 }}>
          {overdue.slice(0, 5).map((c) => (
            <li key={c.id} style={{ cursor: 'pointer' }} onClick={() => navigate('/contract/draft')}>
              {c.code ? `${c.code} ` : ''}
              {c.name || '未命名合同'}
              （创建于 {dayjs(c.createdAt).format('YYYY-MM-DD HH:mm')}，已超时{' '}
              {dayjs().diff(dayjs(c.createdAt), 'hour')} 小时）
            </li>
          ))}
          {overdue.length > 5 && <li>…等共 {overdue.length} 份</li>}
        </ul>
      }
    />
  );
}

export default function Dashboard() {
  const navigate = useNavigate();
  const [overview, setOverview] = useState<any>({});
  const [trend, setTrend] = useState<any[]>([]);
  const [typeStat, setTypeStat] = useState<any[]>([]);
  const [reminders, setReminders] = useState<any>({});
  /** 我的待办聚合数据（TodoCard 与"当天首次浮窗"共用，避免两份请求） */
  const [todoData, setTodoData] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const label = useDictStore((s) => s.label);
  const ensure = useDictStore((s) => s.ensure);

  useEffect(() => {
    ensure(['contract_type']);
    Promise.all([
      dashboardApi.overview(),
      dashboardApi.trend(),
      dashboardApi.contractType(),
      dashboardApi.reminders(),
      dashboardApi.todos(),
    ])
      .then(([o, t, c, r, td]) => {
        setOverview(o || {});
        setTrend((t as any[]) || []);
        setTypeStat((c as any[]) || []);
        setReminders((r as any) || {});
        setTodoData(td || { groups: [], total: 0 });
      })
      .finally(() => setLoading(false));
  }, []);

  const { ref: trendRef, size: trendSize } = useContainerWidth<HTMLDivElement>();
  const { ref: pieRef, size: pieSize } = useContainerWidth<HTMLDivElement>();

  /**
   * 图表按**自身容器宽度**降级（DESIGN.md §10.2）：ECharts 的图例/标签/边距都是 JS 选项，
   * CSS 的 `@container` 驱动不了 —— 图表的"响应式"必须落在 JS，故这里用 `useContainerWidth()`，
   * 且量的是**卡片**宽度而不是视口：`lg=8` 侧列卡片只有 ~380px，按视口它会以为自己在大屏上。
   */
  const trendOption = {
    tooltip: { trigger: 'axis' },
    legend: {
      data: ['结算金额', '付款金额'],
      ...(trendSize.isNarrow ? { itemWidth: 14, itemHeight: 8, textStyle: { fontSize: 11 } } : {}),
    },
    // 窄容器里默认的左 60 / 右 20 边距会吃掉本就不多的绘图区
    grid: trendSize.isNarrow
      ? { left: 44, right: 8, top: 34, bottom: 26 }
      : { left: 60, right: 20, top: 40, bottom: 30 },
    xAxis: { type: 'category', data: trend.map((t) => t.month) },
    yAxis: { type: 'value' },
    series: [
      { name: '结算金额', type: 'line', smooth: true, data: trend.map((t) => t.settleAmount), itemStyle: { color: chartPalette[0] } },
      { name: '付款金额', type: 'bar', data: trend.map((t) => t.paidAmount), itemStyle: { color: chartPalette[1] } },
    ],
  };

  const typeOption = {
    tooltip: { trigger: 'item' },
    legend: {
      bottom: 0,
      ...(pieSize.isNarrow ? { itemWidth: 10, itemHeight: 8, textStyle: { fontSize: 11 } } : {}),
    },
    // 系列配色统一取 theme 的 chartPalette（珊瑚 → 青 → 琥珀 → 绿 → 深墨 → 红）
    color: [...chartPalette],
    series: [
      {
        type: 'pie',
        radius: ['40%', '70%'],
        // 窄容器：扇形上的标签会互相压字 → 关掉标签、把识别交给图例与 tooltip
        label: pieSize.isNarrow ? { show: false } : undefined,
        labelLine: pieSize.isNarrow ? { show: false } : undefined,
        data: typeStat.map((t) => ({ name: label('contract_type', t.typeCode), value: t.amount })),
      },
    ],
  };

  /** 金额预警（业务口径 2026-10-15）：红/黄分级由后端按合同当前金额与补充协议占比算好 */
  const alertList: any[] = reminders.amountAlerts || [];
  /** 付款超比例预警（业务口径 2026-10-16）与上面的金额预警是**两个信号**，分列展示 */
  const payAlertList: any[] = reminders.paymentRatioAlerts || [];
  const alertRed = alertList.filter((a: any) => a.level === 'RED').length;
  const alertYellow = alertList.filter((a: any) => a.level === 'YELLOW').length;

  if (loading) return <Spin style={{ width: '100%', marginTop: 80 }} />;

  return (
    <>
      <OverdueDraftReminder />
      <TodoCard />
      <DashboardNoticeModal data={todoData} loading={loading} />
      <Row gutter={[16, 16]}>
        <Col xs={24} sm={12} lg={6}>
          {/* 每张统计卡自己声明容器：卡只有 1/4 宽，字号要按**卡**宽收敛（见 containers.css §4）；
              `stat-card` 只加"悬停加深一档阴影"（业务要求，见 DESIGN.md §5） */}
          <Card className="cq stat-card"><Statistic title="合同数量" value={overview.contractCount || 0} prefix={<FileTextOutlined />} /></Card>
        </Col>
        <Col xs={24} sm={12} lg={6}>
          <Card className="cq stat-card"><Statistic title="合同总额" value={overview.contractAmount || 0} precision={2} prefix="¥" /></Card>
        </Col>
        <Col xs={24} sm={12} lg={6}>
          <Card className="cq stat-card"><Statistic title="累计结算额" value={overview.settleAmount || 0} precision={2} prefix={<AccountBookOutlined />} /></Card>
        </Col>
        <Col xs={24} sm={12} lg={6}>
          <Card className="cq stat-card"><Statistic title="累计付款额" value={overview.paidAmount || 0} precision={2} prefix={<WalletOutlined />} /></Card>
        </Col>
      </Row>

      <Row gutter={[16, 16]} style={{ marginTop: 16 }}>
        <Col xs={24} lg={16}>
          <Card className="cq" ref={trendRef} title="近 12 个月结算 / 付款趋势">
            <ReactECharts option={trendOption} style={{ height: 300 }} />
          </Card>
        </Col>
        <Col xs={24} lg={8}>
          <Card className="cq" ref={pieRef} title="合同类型金额分布">
            <ReactECharts option={typeOption} style={{ height: 300 }} />
          </Card>
        </Col>
      </Row>

      <Row gutter={[16, 16]} style={{ marginTop: 16 }}>
        <Col xs={24}>
          <TodoCard />
        </Col>
      </Row>

      <Row gutter={[16, 16]} style={{ marginTop: 16 }}>
        <Col xs={24}>
          <Card
            title="合同金额预警"
            extra={
              <Space size={8}>
                {alertRed > 0 && <Tag color="error">红 {alertRed}</Tag>}
                {alertYellow > 0 && <Tag color="warning">黄 {alertYellow}</Tag>}
              </Space>
            }
          >
            <List
              dataSource={alertList}
              locale={{ emptyText: <EmptyState compact description="暂无金额预警" /> }}
              renderItem={(a: any) => (
                <List.Item>
                  <List.Item.Meta
                    title={
                      <Space size={8} wrap>
                        <Tag color={a.level === 'RED' ? 'error' : 'warning'}>
                          {a.level === 'RED' ? '红' : '黄'}
                        </Tag>
                        <Button type="link" size="small" style={{ padding: 0 }} onClick={() => navigate('/ledger')}>
                          {a.code}
                        </Button>
                        <span>{a.name}</span>
                      </Space>
                    }
                    description={(a.reasons || []).join('；')}
                  />
                </List.Item>
              )}
            />
            {reminders.amountAlertTotal > alertList.length && (
              <div className="cms-hint">仅显示前 {alertList.length} 条，共 {reminders.amountAlertTotal} 条</div>
            )}
          </Card>
        </Col>
      </Row>

      <Row gutter={[16, 16]} style={{ marginTop: 16 }}>
        <Col xs={24}>
          <Card
            title="付款超比例预警"
            extra={<Tag color="warning">{reminders.paymentRatioAlertTotal || 0}</Tag>}
          >
            {/* 单级预警（业务只给了"超过就预警"一个口径）：不冒充红/黄，避免暗示不存在的分级阈值 */}
            <List
              dataSource={payAlertList}
              locale={{ emptyText: <EmptyState compact description="暂无付款超比例预警" /> }}
              renderItem={(a: any) => (
                <List.Item>
                  <List.Item.Meta
                    title={
                      <Space size={8} wrap>
                        <Tag color="warning">付款超比例</Tag>
                        <Button
                          type="link"
                          size="small"
                          style={{ padding: 0 }}
                          onClick={() => navigate('/settlement/payment')}
                        >
                          {a.code}
                        </Button>
                        <span>{a.name}</span>
                      </Space>
                    }
                    description={a.reason}
                  />
                </List.Item>
              )}
            />
            {reminders.paymentRatioAlertTotal > payAlertList.length && (
              <div className="cms-hint">
                仅显示前 {payAlertList.length} 条，共 {reminders.paymentRatioAlertTotal} 条
              </div>
            )}
          </Card>
        </Col>
      </Row>

      <Row gutter={[16, 16]} style={{ marginTop: 16 }}>
        <Col xs={24}>
          <Card title="待查验发票" extra={<Tag color="red">{reminders.pendingInvoices?.length || 0}</Tag>}>
            <List
              dataSource={reminders.pendingInvoices || []}
              locale={{
                emptyText: (
                  <EmptyState compact description="暂无待查验发票" actionText="前往发票管理" onAction={() => navigate('/invoice')} />
                ),
              }}
              renderItem={(item: any) => (
                <List.Item>
                  <List.Item.Meta
                    title={item.issuer || '-'}
                    description={`发票号码 ${item.invoiceNo || '-'} · 开票日期 ${item.invoiceDate?.slice(0, 10) || '-'}`}
                  />
                  <span style={{ color: 'var(--cms-error)' }}>{money(item.amountWithTax)}</span>
                </List.Item>
              )}
            />
          </Card>
        </Col>
      </Row>
    </>
  );
}
