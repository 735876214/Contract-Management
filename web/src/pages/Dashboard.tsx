import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Alert, Button, Card, Col, Row, Statistic, List, Tag, Empty, Spin } from 'antd';
import { FileTextOutlined, AccountBookOutlined, WalletOutlined, ReconciliationOutlined } from '@ant-design/icons';
import ReactECharts from 'echarts-for-react';
import dayjs from 'dayjs';
import { dashboardApi } from '@/api/modules';
import { contractApi } from '@/api/business';
import { useDictStore } from '@/store/dict';

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
  const [overview, setOverview] = useState<any>({});
  const [trend, setTrend] = useState<any[]>([]);
  const [typeStat, setTypeStat] = useState<any[]>([]);
  const [reminders, setReminders] = useState<any>({});
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
    ])
      .then(([o, t, c, r]) => {
        setOverview(o || {});
        setTrend((t as any[]) || []);
        setTypeStat((c as any[]) || []);
        setReminders((r as any) || {});
      })
      .finally(() => setLoading(false));
  }, []);

  const trendOption = {
    tooltip: { trigger: 'axis' },
    legend: { data: ['结算金额', '付款金额'] },
    grid: { left: 60, right: 20, top: 40, bottom: 30 },
    xAxis: { type: 'category', data: trend.map((t) => t.month) },
    yAxis: { type: 'value' },
    series: [
      { name: '结算金额', type: 'line', smooth: true, data: trend.map((t) => t.settleAmount), itemStyle: { color: '#1677ff' } },
      { name: '付款金额', type: 'bar', data: trend.map((t) => t.paidAmount), itemStyle: { color: '#52c41a' } },
    ],
  };

  const typeOption = {
    tooltip: { trigger: 'item' },
    legend: { bottom: 0 },
    series: [
      {
        type: 'pie',
        radius: ['40%', '70%'],
        data: typeStat.map((t) => ({ name: label('contract_type', t.typeCode), value: t.amount })),
      },
    ],
  };

  if (loading) return <Spin style={{ width: '100%', marginTop: 80 }} />;

  return (
    <>
      <OverdueDraftReminder />
      <Row gutter={[16, 16]}>
        <Col xs={24} sm={12} lg={6}>
          <Card><Statistic title="合同数量" value={overview.contractCount || 0} prefix={<FileTextOutlined />} /></Card>
        </Col>
        <Col xs={24} sm={12} lg={6}>
          <Card><Statistic title="合同总额" value={overview.contractAmount || 0} precision={2} prefix="¥" /></Card>
        </Col>
        <Col xs={24} sm={12} lg={6}>
          <Card><Statistic title="累计结算额" value={overview.settleAmount || 0} precision={2} prefix={<AccountBookOutlined />} /></Card>
        </Col>
        <Col xs={24} sm={12} lg={6}>
          <Card><Statistic title="累计付款额" value={overview.paidAmount || 0} precision={2} prefix={<WalletOutlined />} /></Card>
        </Col>
      </Row>

      <Row gutter={[16, 16]} style={{ marginTop: 16 }}>
        <Col xs={24} lg={16}>
          <Card title="近 12 个月结算 / 付款趋势">
            <ReactECharts option={trendOption} style={{ height: 300 }} />
          </Card>
        </Col>
        <Col xs={24} lg={8}>
          <Card title="合同类型金额分布">
            <ReactECharts option={typeOption} style={{ height: 300 }} />
          </Card>
        </Col>
      </Row>

      <Row gutter={[16, 16]} style={{ marginTop: 16 }}>
        <Col xs={24}>
          <Card title="待查验发票" extra={<Tag color="red">{reminders.pendingInvoices?.length || 0}</Tag>}>
            <List
              dataSource={reminders.pendingInvoices || []}
              locale={{ emptyText: <Empty description="暂无待查验发票" /> }}
              renderItem={(item: any) => (
                <List.Item>
                  <List.Item.Meta
                    title={item.issuer || '-'}
                    description={`发票号码 ${item.invoiceNo || '-'} · 开票日期 ${item.invoiceDate?.slice(0, 10) || '-'}`}
                  />
                  <span style={{ color: '#cf1322' }}>{money(item.amountWithTax)}</span>
                </List.Item>
              )}
            />
          </Card>
        </Col>
      </Row>
    </>
  );
}
