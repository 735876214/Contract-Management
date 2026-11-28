import { useEffect, useState } from 'react';
import { Alert, Card, Col, Input, Row, Select, Space, Statistic, Table, Tag, Typography } from 'antd';
import http from '@/api/http';
import { formatDateTime } from '@/utils/money';

const { Title, Text } = Typography;

interface ToolRow {
  tool: string;
  calls: number;
  failures: number;
  successRate: number;
  avgDurationMs: number | null;
  lastAt: string | null;
}

interface CallRow {
  id: string;
  createdAt: string;
  actorTool: string;
  username: string | null;
  method: string | null;
  url: string | null;
  result: string | null;
  duration: number | null;
  message: string | null;
  requestId: string | null;
}

/**
 * 系统管理 → MCP 调用（**只读**）。
 *
 * 它回答的是清单类文档回答不了的问题：外部 AI 到底在调哪些工具、失败率高不高、慢不慢。
 * 刻意**不**在这里重复维护「工具/资源/提示词清单」——权威定义在 `mcp/` 包里（`mcp/README.md`），
 * 再抄一份必然漂移；也刻意不提供开关，工具是否可用由 `mcp/src/server.ts` 与后端 RBAC 决定。
 */
export default function McpAuditPage() {
  const [overview, setOverview] = useState<any>(null);
  const [error, setError] = useState<string>('');
  const [calls, setCalls] = useState<CallRow[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const [tool, setTool] = useState<string | undefined>();
  const [result, setResult] = useState<string | undefined>();
  const [keyword, setKeyword] = useState('');
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    http
      .get<any, any>('system/mcp/overview')
      .then((res: any) => setOverview(res))
      .catch((e: any) => setError(e?.message || '加载失败'));
  }, []);

  useEffect(() => {
    setLoading(true);
    http
      .get<any, any>('system/mcp/calls', { params: { page, pageSize, tool, result, keyword: keyword || undefined } })
      .then((res: any) => {
        setCalls(res?.list || []);
        setTotal(res?.total || 0);
      })
      .catch((e: any) => setError(e?.message || '加载失败'))
      .finally(() => setLoading(false));
  }, [page, pageSize, tool, result, keyword]);

  const toolOptions = (overview?.tools || []).map((t: ToolRow) => ({ value: t.tool, label: t.tool }));

  return (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      <div>
        <Title level={4} style={{ marginBottom: 4 }}>
          MCP 调用
        </Title>
        <Text type="secondary">
          外部 AI 经 MCP 调用本系统的留痕（`OperationLog.actorTool`）。工具/资源/提示词的权威定义在
          {' '}
          <Text code>mcp/README.md</Text>
          ，这里不重复维护清单，只看「谁在用、用成了没有、慢不慢」。
        </Text>
      </div>

      {error ? <Alert type="error" showIcon message={error} /> : null}

      <Row gutter={16}>
        <Col xs={12} md={6}>
          <Card size="small">
            <Statistic title={`调用次数（近 ${overview?.windowDays ?? 30} 天）`} value={overview?.totals?.calls ?? 0} />
          </Card>
        </Col>
        <Col xs={12} md={6}>
          <Card size="small">
            <Statistic title="失败次数" value={overview?.totals?.failures ?? 0} valueStyle={(overview?.totals?.failures ?? 0) > 0 ? { color: 'var(--cms-danger)' } : undefined} />
          </Card>
        </Col>
        <Col xs={12} md={6}>
          <Card size="small">
            <Statistic title="被调用的工具数" value={overview?.totals?.tools ?? 0} />
          </Card>
        </Col>
        <Col xs={12} md={6}>
          <Card size="small">
            <Statistic title="采样条数上限" value={overview?.truncated ? '已截断' : '完整'} />
          </Card>
        </Col>
      </Row>

      <Card size="small" title="按工具聚合">
        <Table
          size="small"
          rowKey="tool"
          dataSource={overview?.tools || []}
          pagination={false}
          columns={[
            { title: '工具', dataIndex: 'tool' },
            { title: '调用次数', dataIndex: 'calls', width: 100 },
            {
              title: '失败',
              dataIndex: 'failures',
              width: 80,
              render: (v: number) => (v > 0 ? <Tag color="red">{v}</Tag> : <Tag color="green">0</Tag>),
            },
            { title: '成功率', dataIndex: 'successRate', width: 100, render: (v: number) => `${v}%` },
            {
              title: '平均耗时',
              dataIndex: 'avgDurationMs',
              width: 110,
              render: (v: number | null) => (v === null ? '—' : `${v} ms`),
            },
            {
              title: '最近一次',
              dataIndex: 'lastAt',
              width: 180,
              render: (v: string | null) => (v ? formatDateTime(v) : '—'),
            },
          ]}
        />
      </Card>

      <Card
        size="small"
        title="调用明细"
        extra={
          <Space wrap>
            <Select allowClear placeholder="工具" style={{ width: 200 }} options={toolOptions} value={tool} onChange={(v) => { setPage(1); setTool(v); }} />
            <Select allowClear placeholder="结果" style={{ width: 120 }} value={result} onChange={(v) => { setPage(1); setResult(v); }}
              options={[{ value: 'SUCCESS', label: '成功' }, { value: 'FAIL', label: '失败' }]}
            />
            <Input.Search allowClear placeholder="URL / 用户 / 请求 id" style={{ width: 240 }} onSearch={(v) => { setPage(1); setKeyword(v); }} />
          </Space>
        }
      >
        <Table
          size="small"
          rowKey="id"
          loading={loading}
          dataSource={calls}
          pagination={{ current: page, pageSize, total, showSizeChanger: true, onChange: (p, s) => { setPage(p); setPageSize(s); } }}
          columns={[
            { title: '时间', dataIndex: 'createdAt', width: 180, render: (v: string) => formatDateTime(v) },
            { title: '工具', dataIndex: 'actorTool', width: 200 },
            { title: '调用人', dataIndex: 'username', width: 120, render: (v: string | null) => v || '（服务账号）' },
            {
              title: '结果',
              dataIndex: 'result',
              width: 90,
              render: (v: string | null) => (v === 'FAIL' ? <Tag color="red">失败</Tag> : <Tag color="green">成功</Tag>),
            },
            { title: '耗时', dataIndex: 'duration', width: 90, render: (v: number | null) => (v === null ? '—' : `${v} ms`) },
            { title: '请求 id', dataIndex: 'requestId', width: 110, render: (v: string | null) => v || '—' },
            { title: '接口', dataIndex: 'url', ellipsis: true },
          ]}
        />
      </Card>
    </Space>
  );
}
