import { useCallback, useEffect, useState } from 'react';
import {
  Alert,
  Button,
  Card,
  DatePicker,
  Descriptions,
  Drawer,
  Input,
  Popconfirm,
  Select,
  Space,
  Table,
  Tag,
  Typography,
  message,
} from 'antd';
import { DeleteOutlined, DownloadOutlined, EyeOutlined } from '@ant-design/icons';
import type { ColumnsType } from 'antd/es/table';
import dayjs, { type Dayjs } from 'dayjs';
import {
  aiApi,
  type AiAnalyticsRecordDetail,
  type AiAnalyticsRecordSummary,
} from '@/api/modules';
import ReportMarkdown from '@/components/ReportMarkdown';

const { Text } = Typography;

const SCOPE_LABEL: Record<string, string> = { current: '当前项目', selected: '多选项目', all: '全部项目' };
const COMPARE_LABEL: Record<string, string> = { none: '不对比', mom: '环比', yoy: '同比' };

export interface HistoryPanelProps {
  projects: Array<{ id: string; code: string; name: string }>;
  /** 生成页签保存成功后自增，触发本页刷新 */
  refreshKey: number;
}

/** 历史页签：本人全部（跨项目可见）；`projectId` 可选筛选；超管可看全部（由后端 all=1 决定）。 */
export default function HistoryPanel({ projects, refreshKey }: HistoryPanelProps) {
  const [keyword, setKeyword] = useState('');
  const [has, setHas] = useState<string | undefined>();
  const [projectId, setProjectId] = useState<string | undefined>();
  const [range, setRange] = useState<[Dayjs, Dayjs] | null>(null);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const [list, setList] = useState<AiAnalyticsRecordSummary[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [detail, setDetail] = useState<AiAnalyticsRecordDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await aiApi.analyticsHistory({
        page,
        pageSize,
        keyword: keyword.trim() || undefined,
        has,
        projectId,
        from: range?.[0]?.format('YYYY-MM-DD'),
        to: range?.[1]?.format('YYYY-MM-DD'),
      });
      setList(res.list || []);
      setTotal(res.total || 0);
    } catch {
      // 拦截器已弹错
    } finally {
      setLoading(false);
    }
  }, [page, pageSize, keyword, has, projectId, range]);

  useEffect(() => {
    load();
  }, [load, refreshKey]);

  const openDetail = async (row: AiAnalyticsRecordSummary) => {
    setDrawerOpen(true);
    setDetail(null);
    setDetailLoading(true);
    try {
      setDetail(await aiApi.analyticsDetail(row.id));
    } catch {
      setDrawerOpen(false);
    } finally {
      setDetailLoading(false);
    }
  };

  const doExport = async (row: AiAnalyticsRecordSummary, format: 'docx' | 'pdf') => {
    try {
      const res = await aiApi.analyticsExport(row.id, format);
      const blob = new Blob([res.data], {
        type:
          format === 'pdf'
            ? 'application/pdf'
            : 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      });
      const cd = (res.headers && (res.headers['content-disposition'] as string)) || '';
      const m = /filename\*=UTF-8''([^;]+)/i.exec(cd);
      const fileName = m ? decodeURIComponent(m[1]) : `${row.title}.${format}`;
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = fileName;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch {
      // 拦截器已弹错
    }
  };

  const doRemove = async (row: AiAnalyticsRecordSummary) => {
    try {
      await aiApi.analyticsRemove(row.id);
      message.success('已删除记录（文件保留，由存储审计人工处理）');
      load();
    } catch {
      // 拦截器已弹错
    }
  };

  const columns: ColumnsType<AiAnalyticsRecordSummary> = [
    {
      title: '标题',
      dataIndex: 'title',
      key: 'title',
      ellipsis: true,
      render: (_: unknown, r) => (
        <Space direction="vertical" size={0}>
          <Text strong>{r.title}</Text>
          <Text type="secondary" style={{ fontSize: 12 }}>
            {SCOPE_LABEL[r.scopeMode || ''] ?? r.scopeMode ?? '—'}
            {r.projectCount ? `（${r.projectCount} 个项目）` : ''}
          </Text>
        </Space>
      ),
    },
    { title: '期间', dataIndex: 'periodLabel', key: 'periodLabel', width: 210 },
    {
      title: '对比',
      dataIndex: 'compareMode',
      key: 'compareMode',
      width: 90,
      render: (v: string | null) => COMPARE_LABEL[v || 'none'] ?? v ?? '—',
    },
    {
      title: '类型',
      key: 'type',
      width: 150,
      render: (_: unknown, r) => (
        <Space size={4} wrap>
          {r.hasReport && <Tag color="blue">报告</Tag>}
          {r.hasWorkbook && <Tag color="green">表格</Tag>}
          <Tag>{r.source === 'llm' ? '模型' : '模板'}</Tag>
        </Space>
      ),
    },
    { title: '创建人', dataIndex: 'createdByName', key: 'createdByName', width: 110 },
    {
      title: '创建时间',
      dataIndex: 'createdAt',
      key: 'createdAt',
      width: 160,
      render: (v: string) => (v ? dayjs(v).format('YYYY-MM-DD HH:mm') : '—'),
    },
    {
      title: '操作',
      key: 'actions',
      width: 220,
      render: (_: unknown, r) => (
        <Space size={4} wrap>
          <Button size="small" icon={<EyeOutlined />} onClick={() => openDetail(r)}>
            查看
          </Button>
          {r.hasReport && (
            <>
              <Button size="small" icon={<DownloadOutlined />} onClick={() => doExport(r, 'docx')}>
                Word
              </Button>
              <Button size="small" icon={<DownloadOutlined />} onClick={() => doExport(r, 'pdf')}>
                PDF
              </Button>
            </>
          )}
          <Popconfirm
            title="删除这条记录？"
            description="只删除记录；对应文件保留，由存储审计人工清理。"
            okText="删除"
            cancelText="取消"
            onConfirm={() => doRemove(r)}
          >
            <Button size="small" danger icon={<DeleteOutlined />} />
          </Popconfirm>
        </Space>
      ),
    },
  ];

  return (
    <Card>
      <Space wrap style={{ marginBottom: 16 }}>
        <Input.Search
          allowClear
          style={{ width: 240 }}
          placeholder="搜索标题"
          value={keyword}
          onChange={(e) => {
            setKeyword(e.target.value);
            setPage(1);
          }}
          onSearch={() => load()}
        />
        <Select
          allowClear
          style={{ width: 200 }}
          placeholder="按项目筛选（默认全部）"
          value={projectId}
          onChange={(v) => {
            setProjectId(v);
            setPage(1);
          }}
          options={projects.map((p) => ({ value: p.id, label: `${p.name}（${p.code}）` }))}
        />
        <Select
          allowClear
          style={{ width: 140 }}
          placeholder="类型"
          value={has}
          onChange={(v) => {
            setHas(v);
            setPage(1);
          }}
          options={[
            { value: 'report', label: '报告' },
            { value: 'workbook', label: '表格' },
          ]}
        />
        <DatePicker.RangePicker value={range} onChange={(v) => setRange(v as [Dayjs, Dayjs] | null)} />
        <Button onClick={() => load()}>刷新</Button>
      </Space>

      <Table
        rowKey="id"
        size="middle"
        loading={loading}
        columns={columns}
        dataSource={list}
        scroll={{ x: 1100 }}
        pagination={{
          current: page,
          pageSize,
          total,
          showSizeChanger: true,
          showTotal: (n) => `共 ${n} 条`,
          onChange: (p, ps) => {
            setPage(p);
            setPageSize(ps);
          },
        }}
      />

      <Drawer
        title={detail?.title || '记录详情'}
        width={760}
        open={drawerOpen}
        onClose={() => setDrawerOpen(false)}
        destroyOnClose
      >
        {detailLoading ? (
          <Card loading />
        ) : detail ? (
          <Space direction="vertical" size={12} style={{ width: '100%' }}>
            <Descriptions column={1} size="small">
              <Descriptions.Item label="范围">
                {SCOPE_LABEL[detail.scopeMode || ''] ?? detail.scopeMode ?? '—'}
                {detail.projectCount ? `（${detail.projectCount} 个项目）` : ''}
              </Descriptions.Item>
              <Descriptions.Item label="期间">{detail.periodLabel ?? '—'}</Descriptions.Item>
              <Descriptions.Item label="对比">{COMPARE_LABEL[detail.compareMode || 'none'] ?? '—'}</Descriptions.Item>
              <Descriptions.Item label="创建">
                {detail.createdByName ?? '—'} · {detail.createdAt ? dayjs(detail.createdAt).format('YYYY-MM-DD HH:mm') : '—'}
              </Descriptions.Item>
            </Descriptions>
            {Array.isArray(detail.warningsJson) && detail.warningsJson.length > 0 && (
              <Alert
                type="warning"
                showIcon
                message="生成提醒"
                description={
                  <ul style={{ margin: 0, paddingLeft: 18 }}>
                    {(detail.warningsJson as string[]).map((w) => (
                      <li key={w}>{w}</li>
                    ))}
                  </ul>
                }
              />
            )}
            {detail.markdown ? <ReportMarkdown text={detail.markdown} /> : <Text type="secondary">没有报告正文</Text>}
          </Space>
        ) : null}
      </Drawer>
    </Card>
  );
}
