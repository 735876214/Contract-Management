import { useCallback, useEffect, useState } from 'react';
import { Alert, Button, Card, Collapse, DatePicker, Empty, Input, Segmented, Space, Spin, Tag, Typography } from 'antd';
import { message } from '@/utils/antdStatic';
import { ThunderboltOutlined } from '@ant-design/icons';
import dayjs, { type Dayjs } from 'dayjs';
import { aiApi } from '@/api/modules';
import { useAuthStore } from '@/store/auth';
import ReportMarkdown from '@/components/ReportMarkdown';

const { Text, Paragraph } = Typography;
const { TextArea } = Input;

interface ChatAskResult {
  id: string | null;
  question: string;
  answer: string;
  accepted: boolean;
  discardedNumbers: string[];
  scopeLabel: string;
  periodLabel: string;
  datasetKeys: string[];
  datasets: Array<{ label: string; rowCount: number }>;
  source: 'llm' | 'template';
  warnings: string[];
}

/**
 * AI 问数面板（P3-A，只读）。
 *
 * 不变式：**数字全部由后端算**（DatasetCollector），模型只组织语言，回答里的数字逐条回查。
 * 因此这里有三处刻意的 UI：
 * 1. `discardedNumbers` 非空 → 红色告警，明确告诉用户「模型那句话的数字对不上，已换成事实汇总」；
 * 2. 「依据」区列出本次用到的数据集与行数——让用户知道这个答案的边界；
 * 3. 不显示「AI 一定对」的语气，措辞统一为「本期间数据里……」/「系统不包含该信息」。
 */
export default function ChatPanel() {
  const currentProjectId = useAuthStore((s) => s.currentProjectId);
  const [status, setStatus] = useState<any>(null);
  const [question, setQuestion] = useState('');
  const [scope, setScope] = useState<'current' | 'all'>('current');
  const [range, setRange] = useState<[Dayjs, Dayjs] | null>(null);
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<ChatAskResult | null>(null);
  const [history, setHistory] = useState<any[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);

  const reloadHistory = useCallback(() => {
    setHistoryLoading(true);
    aiApi
      .chatRecords({ page: 1, pageSize: 10 })
      .then((res: any) => setHistory(res?.list || []))
      .catch(() => setHistory([]))
      .finally(() => setHistoryLoading(false));
  }, []);

  useEffect(() => {
    aiApi
      .chatStatus()
      .then((res: any) => setStatus(res))
      .catch(() => setStatus({ enabled: false }));
    reloadHistory();
  }, [reloadHistory]);

  const ask = async () => {
    const text = question.trim();
    if (!text) {
      message.warning('请先输入问题');
      return;
    }
    setLoading(true);
    try {
      const body: Record<string, unknown> = { text, scope: { mode: scope } };
      if (range) {
        body.period = { preset: 'custom', from: range[0].format('YYYY-MM-DD'), to: range[1].format('YYYY-MM-DD') };
      } else {
        // 'this_year' 是 AiPeriodPreset 的合法取值（没有 last_12_months，传错会被后端忽略并告警）
        body.period = { preset: 'this_year' };
      }
      const res = (await aiApi.chatAsk(body)) as ChatAskResult;
      setResult(res);
      reloadHistory();
    } catch (e: any) {
      message.error(e?.message || '提问失败');
    } finally {
      setLoading(false);
    }
  };

  const enabled = status?.enabled === true;
  const crossProjectAllowed = status?.crossProjectAllowed === true;
  const datasetCount = status?.datasets?.length ?? 0;

  return (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      <Alert
        type="info"
        showIcon
        message="问数：数字由程序计算，模型只负责组织语言"
        description={
          <span>
            回答里每个数字都会回查事实清单；对不上的数字会被拦下并提示你，不会当成结论给你。
            {enabled ? `当前可问 ${datasetCount} 类数据。` : '（AI 未启用，请先到「系统管理 → AI 信息登记」配置）'}
          </span>
        }
      />

      <Card size="small">
        <Space direction="vertical" size={12} style={{ width: '100%' }}>
          <Space wrap>
            <Segmented
              value={scope}
              onChange={(v) => setScope(v as 'current' | 'all')}
              options={[
                { label: '当前项目', value: 'current' },
                ...(crossProjectAllowed ? [{ label: '全部项目', value: 'all' }] : []),
              ]}
            />
            <DatePicker.RangePicker
              value={range as any}
              onChange={(v) => setRange(v as [Dayjs, Dayjs] | null)}
              allowClear
              placeholder={['开始日期', '结束日期']}
            />
            <Text type="secondary">不选期间 = 本年度</Text>
          </Space>
          <TextArea
            rows={3}
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            maxLength={2000}
            showCount
            placeholder="例如：本期间哪个项目的付款进度最慢？合同签约额是多少？"
            onPressEnter={(e) => {
              if (!e.shiftKey) {
                e.preventDefault();
                void ask();
              }
            }}
          />
          <Space>
            <Button
              type="primary"
              icon={<ThunderboltOutlined />}
              loading={loading}
              disabled={!enabled || !currentProjectId}
              onClick={() => void ask()}
            >
              提问
            </Button>
            <Text type="secondary">Enter 发送，Shift+Enter 换行</Text>
          </Space>
        </Space>
      </Card>

      {loading ? (
        <Card>
          <Space>
            <Spin />
            <Text type="secondary">正在取数并组织回答（数字由后端计算，通常 5~20 秒）…</Text>
          </Space>
        </Card>
      ) : null}

      {result ? (
        <Card
          title="回答"
          extra={
            <Space size={4}>
              <Tag color={result.source === 'llm' ? 'blue' : 'default'}>
                {result.source === 'llm' ? 'AI 组织' : '事实汇总（AI 未参与）'}
              </Tag>
              <Tag>{result.periodLabel}</Tag>
            </Space>
          }
        >
          <Space direction="vertical" size={12} style={{ width: '100%' }}>
            {result.discardedNumbers?.length ? (
              <Alert
                type="warning"
                showIcon
                message="模型回答里有对不上账的数字，已整段作废"
                description={`对不上：${result.discardedNumbers.join('、')}。下面是程序直出的本期间事实汇总，可直接核对。`}
              />
            ) : null}

            <ReportMarkdown text={result.answer} />

            {result.datasets?.length ? (
              <div>
                <Text type="secondary">依据：</Text>
                <Space size={4} wrap style={{ marginTop: 4 }}>
                  {result.datasets.map((d) => (
                    <Tag key={d.label}>
                      {d.label}（{d.rowCount} 行）
                    </Tag>
                  ))}
                </Space>
              </div>
            ) : null}

            <Text type="secondary" style={{ fontSize: 12 }}>
              统计范围：{result.scopeLabel}。结论仅基于上述数据集，不含未列出的信息。
            </Text>
          </Space>
        </Card>
      ) : null}

      <Card size="small" title="最近问答" loading={historyLoading && !history.length}>
        {history.length ? (
          <Collapse
            size="small"
            items={history.map((h) => ({
              key: h.id,
              label: (
                <Space>
                  <Text ellipsis style={{ maxWidth: 480 }}>
                    {h.title}
                  </Text>
                  <Text type="secondary" style={{ fontSize: 12 }}>
                    {dayjs(h.createdAt).format('MM-DD HH:mm')}
                  </Text>
                </Space>
              ),
              children: (
                <Button
                  type="link"
                  size="small"
                  onClick={() => {
                    aiApi
                      .chatRecord(h.id)
                      .then((detail: any) => {
                        setResult({
                          id: detail.id,
                          question: detail.rawText || h.title,
                          answer: detail.markdown || '',
                          accepted: detail.source === 'llm',
                          discardedNumbers: detail.discardedNumbersJson || [],
                          scopeLabel: h.periodLabel || '',
                          periodLabel: h.periodLabel || '',
                          datasetKeys: detail.datasetKeys || [],
                          datasets: [],
                          source: detail.source === 'llm' ? 'llm' : 'template',
                          warnings: detail.warningsJson || [],
                        });
                      })
                      .catch((e: any) => message.error(e?.message || '加载失败'));
                  }}
                >
                  查看这条回答
                </Button>
              ),
            }))}
          />
        ) : (
          <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="还没有问答记录" />
        )}
        {history.length ? (
          <Paragraph type="secondary" style={{ marginTop: 12, marginBottom: 0, fontSize: 12 }}>
            历史只保留你本人（超管可见全部）；每条都是当时的快照，重新提问会新增一条。
          </Paragraph>
        ) : null}
      </Card>
    </Space>
  );
}
