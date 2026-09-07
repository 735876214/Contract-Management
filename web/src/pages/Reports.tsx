import { useEffect, useMemo, useState } from 'react';
import { Card, Row, Col, Statistic } from 'antd';
import ReactECharts from 'echarts-for-react';
import { dashboardApi } from '@/api/modules';
import { useDictStore } from '@/store/dict';

const money = (v: any) =>
  v == null ? '-' : '¥' + Number(v).toLocaleString('zh-CN', { maximumFractionDigits: 2 });

export default function Reports() {
  const ensure = useDictStore((s) => s.ensure);
  const dictReady = useDictStore(
    (s) => !!(s.cache['contract_type'] && s.cache['invoice_type'] && s.cache['invoice_status'])
  );

  const [overview, setOverview] = useState<any>(null);
  const [trend, setTrend] = useState<any>(null);
  const [contractType, setContractType] = useState<any[]>([]);
  const [invoice, setInvoice] = useState<any>(null);

  useEffect(() => {
    ensure(['contract_type', 'invoice_type', 'invoice_status']);
    dashboardApi.overview().then((r: any) => setOverview(r)).catch(() => setOverview({}));
    dashboardApi.trend().then((r: any) => setTrend(r)).catch(() => setTrend({}));
    dashboardApi.contractType().then((r: any) => setContractType(r || [])).catch(() => setContractType([]));
    dashboardApi.invoiceStats().then((r: any) => setInvoice(r)).catch(() => setInvoice({}));
  }, []);

  const label = (typeCode: string, value?: string) =>
    value == null ? '-' : useDictStore.getState().label(typeCode, value);

  const trendOption = useMemo(() => {
    const months = trend?.months || [];
    const settle = trend?.settle || [];
    const pay = trend?.pay || [];
    return {
      tooltip: { trigger: 'axis' },
      legend: { data: ['结算', '付款'] },
      grid: { left: 50, right: 50, bottom: 40, top: 50 },
      xAxis: { type: 'category', data: months },
      yAxis: [
        { type: 'value', name: '结算' },
        { type: 'value', name: '付款' },
      ],
      series: [
        { name: '结算', type: 'bar', data: settle, itemStyle: { color: '#1677ff' } },
        {
          name: '付款',
          type: 'line',
          yAxisIndex: 1,
          smooth: true,
          data: pay,
          itemStyle: { color: '#52c41a' },
        },
      ],
    };
  }, [trend]);

  const contractTypeOption = useMemo(() => {
    return {
      tooltip: { trigger: 'item', formatter: '{b}: {c} ({d}%)' },
      legend: { type: 'scroll', bottom: 0 },
      series: [
        {
          type: 'pie',
          radius: ['40%', '70%'],
          data: contractType.map((i) => ({
            name: label('contract_type', i.code) || i.code,
            value: i.amount || 0,
          })),
        },
      ],
    };
  }, [contractType, dictReady]);

  const invoiceByTypeOption = useMemo(() => {
    const byType = invoice?.byType || [];
    return {
      tooltip: { trigger: 'axis' },
      grid: { left: 80, right: 30, bottom: 40, top: 30 },
      xAxis: { type: 'value' },
      yAxis: {
        type: 'category',
        data: byType.map((i: any) => label('invoice_type', i.code) || i.code),
      },
      series: [{ type: 'bar', data: byType.map((i: any) => i.amount || 0), itemStyle: { color: '#722ed1' } }],
    };
  }, [invoice, dictReady]);

  const invoiceByStatusOption = useMemo(() => {
    const byStatus = invoice?.byStatus || [];
    return {
      tooltip: { trigger: 'axis' },
      grid: { left: 80, right: 30, bottom: 40, top: 30 },
      xAxis: { type: 'value' },
      yAxis: {
        type: 'category',
        data: byStatus.map((i: any) => label('invoice_status', i.code) || i.code),
      },
      series: [{ type: 'bar', data: byStatus.map((i: any) => i.count || 0), itemStyle: { color: '#fa8c16' } }],
    };
  }, [invoice, dictReady]);

  return (
    <Card title="统计报表">
      <Row gutter={16} style={{ marginBottom: 16 }}>
        <Col xs={12} md={6}><Card size="small"><Statistic title="合同数量" value={overview?.contractCount ?? 0} /></Card></Col>
        <Col xs={12} md={6}><Card size="small"><Statistic title="合同总额" value={money(overview?.contractAmount)} /></Card></Col>
        <Col xs={12} md={6}><Card size="small"><Statistic title="累计结算" value={money(overview?.settleAmount)} /></Card></Col>
        <Col xs={12} md={6}><Card size="small"><Statistic title="累计发票金额" value={money(overview?.invoiceAmount)} /></Card></Col>
      </Row>

      <Row gutter={16}>
        <Col xs={24} lg={12}>
          <Card size="small" title="近12个月结算/付款趋势" style={{ marginBottom: 16 }}>
            <ReactECharts option={trendOption} style={{ height: 360 }} notMerge />
          </Card>
        </Col>
        <Col xs={24} lg={12}>
          <Card size="small" title="合同类型金额分布" style={{ marginBottom: 16 }}>
            <ReactECharts option={contractTypeOption} style={{ height: 360 }} notMerge />
          </Card>
        </Col>
        <Col xs={24} lg={12}>
          <Card size="small" title="发票按类型金额分布" style={{ marginBottom: 16 }}>
            <ReactECharts option={invoiceByTypeOption} style={{ height: 360 }} notMerge />
          </Card>
        </Col>
        <Col xs={24} lg={12}>
          <Card size="small" title="发票状态数量分布">
            <ReactECharts option={invoiceByStatusOption} style={{ height: 360 }} notMerge />
          </Card>
        </Col>
      </Row>
    </Card>
  );
}
