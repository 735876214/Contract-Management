import { useEffect, useState } from 'react';
import { Card, Col, Row, Statistic, List, Tag, Empty, Spin } from 'antd';
import { FileTextOutlined, AccountBookOutlined, WalletOutlined, ReconciliationOutlined } from '@ant-design/icons';
import ReactECharts from 'echarts-for-react';
import { dashboardApi } from '@/api/modules';
import { useDictStore } from '@/store/dict';

const money = (v: number) => `¥${(v || 0).toLocaleString('zh-CN', { maximumFractionDigits: 2 })}`;

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
        <Col xs={24} lg={12}>
          <Card title="待办审批" extra={<Tag color="blue">{reminders.pendingApprovals?.length || 0}</Tag>}>
            <List
              dataSource={reminders.pendingApprovals || []}
              locale={{ emptyText: <Empty description="暂无待办" /> }}
              renderItem={(item: any) => (
                <List.Item>
                  <List.Item.Meta title={item.title} description={`${item.applicant || ''} · ${item.bizType}`} />
                  <Tag color="processing">审批中</Tag>
                </List.Item>
              )}
            />
          </Card>
        </Col>
        <Col xs={24} lg={12}>
          <Card title="逾期付款计划" extra={<Tag color="red">{reminders.overduePlans?.length || 0}</Tag>}>
            <List
              dataSource={reminders.overduePlans || []}
              locale={{ emptyText: <Empty description="暂无逾期" /> }}
              renderItem={(item: any) => (
                <List.Item>
                  <List.Item.Meta
                    title={item.contract?.name || '-'}
                    description={`${item.contract?.supplier?.name || ''} · 第 ${item.period} 期 · 计划日期 ${item.planDate?.slice(0, 10)}`}
                  />
                  <span style={{ color: '#cf1322' }}>{money(item.planAmount)}</span>
                </List.Item>
              )}
            />
          </Card>
        </Col>
      </Row>
    </>
  );
}
