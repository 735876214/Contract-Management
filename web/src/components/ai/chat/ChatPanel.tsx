import { useCallback, useEffect, useMemo, useState } from 'react';
import { Alert, Button, Card, Collapse, DatePicker, Empty, Input, Segmented, Space, Spin, Tag, Typography } from 'antd';
import { message } from '@/utils/antdStatic';
import { ThunderboltOutlined } from '@ant-design/icons';
import dayjs, { type Dayjs } from 'dayjs';
import { aiApi } from '@/api/modules';
import { useAuthStore } from '@/store/auth';
import ReportMarkdown from '@/components/ReportMarkdown';

const { Text, Paragraph } = Typography;
const { TextArea } = Input;

interface ChatResult {
  id?: string | null;
  answer: string;
  accepted: boolean;
  discardedNumbers: string[];
  toolTrace?: Array<{ name: string; ok: boolean; label: string }>;
  datasetKeys?: string[];
  scopeLabel?: string;
  periodLabel?: string;
  warnings?: string[];
  source?: 'llm' | 'template';
}

/** SSE 帧 → 事件（`event: x` + `data: {...}`，空行分隔） */
function parseFrames(buffer: string): { frames: Array<{ event: string; data: any }>; rest: string } {
  const frames: Array<{ event: string; data: any }> = [];
  let rest = buffer;
  for (;;) {
    const idx = rest.indexOf('\n\n');
    if (idx < 0) break;
    const raw = rest.slice(0, idx);
    rest = rest.slice(idx + 2);
    let event = 'message';
    const dataLines: string[] = [];
    for (const line of raw.split('\n')) {
      if (line.startsWith('event:')) event = line.slice(6).trim();
      else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim());
    }
    if (!dataLines.length) continue; // 心跳注释帧（`: ping`）到此已被跳过
    let data: any = null;
    try {
      data = JSON.parse(dataLines.join('\n'));
    } catch {
      continue;
    }
    frames.push({ event, data });
  }
  return { frames, rest };
}

/**
 * AI 问数面板（P3-A 非流式 + P3-B 流式/工具）。
 *
 * 不变式：**数字全部由后端算**，模型只组织语言，回答里的数字逐条回查。因此三处刻意设计：
 * 1. 流式时先显示模型原文（`delta`），**收到 `final` 后必须整段覆盖**——对账不通过时最终正文
 *    会换成程序直出的事实汇总，不覆盖等于把作废内容当结论给用户；
 * 2. `discardedNumbers` 非空 → 黄色告警，明确「模型那句话的数字对不上，已作废」；
 * 3. 「依据」列出本次用到的数据集——让用户知道这个答案的边界。
 */
export default function ChatPanel() {
  const currentProjectId = useAuthStore((s) => s.currentProjectId);
  const [status, setStatus] = useState<any>(null);
  const [question, setQuestion] = useState('');
  const [scope, setScope] = useState<'current' | 'all'>('current');
  const [range, setRange] = useState<[Dayjs, Dayjs] | null>(null);
  const [loading, setLoading] = useState(false);
  const [phase, setPhase] = useState('');
  const [streaming, setStreaming] = useState('');
  const [result, setResult] = useState<ChatResult | null>(null);
  const [history, setHistory] = useState<any[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);

  const labelOf = useMemo(() => {
    const map = new Map<string, string>();
    for (const d of status?.datasets || []) map.set(d.key, d.label);
    return (key: string) => map.get(key) ?? key;
  }, [status]);

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

  const buildBody = () => {
    const body: Record<string, unknown> = { text: question.trim(), scope: { mode: scope } };
    body.period = range
      ? { preset: 'custom', from: range[0].format('YYYY-MM-DD'), to: range[1].format('YYYY-MM-DD') }
      : // 'this_year' 是 AiPeriodPreset 的合法取值（没有 last_12_months）
        { preset: 'this_year' };
    return body;
  };

  /**
   * 问数主流程（2026-11-24 改：后台 run + 断线续传）。
   *
   * 为什么不再直接把 `fetch('/chat/ask/stream')` 当唯一通路：那套把生成绑在这次 HTTP 请求上，
   * 关页/切网/代理掐断，生成就白丢了，刷新页面也找不回（历史里只有跑完才存在的记录）。
   * 现在的顺序是：建 run → 订阅事件流 → **断了就带事件序号续传一次** → 还不行就读快照。
   * 任何一步失败都不会重跑模型（钱已经花了），最差也是把已落库的结论交给用户。
   */
  const askStream = async () => {
    const text = question.trim();
    if (!text) {
      message.warning('请先输入问题');
      return;
    }
    setLoading(true);
    setResult(null);
    setStreaming('');
    setPhase('解析问题并取数…');

    const apiBase = (import.meta as any).env?.VITE_API_BASE || '/api';
    const token = localStorage.getItem('cms_token') || '';
    const projectId = localStorage.getItem('cms_project_id') || currentProjectId || '';
    const headers: Record<string, string> = {
      Authorization: `Bearer ${token}`,
      'x-project-id': projectId,
      // 让后端 ResponseInterceptor 原样返回（否则 SSE 会被 JSON 包装破坏）
      'x-raw-response': '1',
    };
    const body = buildBody();
    let acc = '';
    /** 已消费的事件条数：断线重连时作为 `from` 报给后端，保证不重复、不丢字 */
    let seen = 0;

    const handleFrame = (event: string, data: any) => {
      seen += 1;
      if (event === 'phase') {
        setPhase(data?.message || (data?.phase === 'answering' ? 'AI 正在作答…' : '处理中…'));
      } else if (event === 'delta') {
        acc += String(data?.text ?? '');
        setStreaming(acc);
      } else if (event === 'tool') {
        setPhase(`读取中：${data?.name ?? '工具'}`);
      } else if (event === 'final') {
        // ⚠️ 必须覆盖：对账不通过时 final.answer 是程序直出的事实汇总
        acc = String(data?.answer ?? '');
        setStreaming('');
        setResult({
          answer: acc,
          accepted: !!data?.accepted,
          discardedNumbers: data?.discardedNumbers || [],
          toolTrace: data?.toolTrace || [],
          warnings: data?.warnings || [],
          source: data?.accepted ? 'llm' : 'template',
        });
      } else if (event === 'stopped') {
        setPhase('已停止（保留了已生成的部分，未写入问答记录）');
      } else if (event === 'done') {
        setResult((prev) => (prev ? { ...prev, id: data?.reportId ?? prev.id } : prev));
        reloadHistory();
      } else if (event === 'error') {
        message.error(data?.message || '问数失败');
      }
    };

    /** 订阅一次事件流；正常收完返回，网络中断会抛错（交给上层续传/快照） */
    const consume = async (runId: string, from: number): Promise<void> => {
      const res = await fetch(`${apiBase}/ai/chat/runs/${runId}/stream?from=${from}`, { headers });
      if (!res.ok || !res.body) {
        const detail = await res.text().catch(() => '');
        throw new Error(detail.slice(0, 200) || `流式请求失败（${res.status}）`);
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const parsed = parseFrames(buffer);
        buffer = parsed.rest;
        for (const { event, data } of parsed.frames) handleFrame(event, data);
      }
    };

    try {
      const created = await fetch(`${apiBase}/ai/chat/runs`, {
        method: 'POST',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!created.ok) {
        const detail = await created.text().catch(() => '');
        throw new Error(detail.slice(0, 200) || `提问失败（${created.status}）`);
      }
      const { runId } = (await created.json()) as { runId?: string };
      if (!runId) throw new Error('服务端没有返回 runId');

      try {
        await consume(runId, 0);
      } catch (e1: any) {
        // 第一次断（切网、代理掐断）：带已看条数续传一次，事件流在 Redis 里，不重复也不丢字
        try {
          await consume(runId, seen);
        } catch {
          // 还不行：读快照。这时生成多半已在服务端跑完并落库，结论不会白丢
          const snap = await fetch(`${apiBase}/ai/chat/runs/${runId}`, { headers });
          if (!snap.ok) throw e1;
          const s = (await snap.json()) as any;
          setStreaming('');
          setResult({
            id: s?.reportId ?? null,
            answer: String(s?.answer ?? ''),
            accepted: !!s?.accepted,
            discardedNumbers: s?.discardedNumbers || [],
            toolTrace: s?.toolTrace || [],
            warnings: s?.warnings || [],
            source: s?.accepted ? 'llm' : 'template',
          });
          message.info('连接中断，已为你取回本次生成的结果');
          reloadHistory();
        }
      }
      setPhase('');
    } catch (e: any) {
      // run 接口不可用（老后端/网关拦 POST）时退回非流式：宁可慢，不能白问
      try {
        const res = (await aiApi.chatAsk(body)) as any;
        setResult({
          id: res?.id,
          answer: String(res?.answer ?? ''),
          accepted: !!res?.accepted,
          discardedNumbers: res?.discardedNumbers || [],
          datasetKeys: res?.datasetKeys || [],
          scopeLabel: res?.scopeLabel,
          periodLabel: res?.periodLabel,
          warnings: res?.warnings || [],
          source: res?.source,
        });
        reloadHistory();
        setPhase('');
      } catch (e2: any) {
        message.error(e2?.message || e?.message || '提问失败');
        setPhase('');
      }
    } finally {
      setLoading(false);
    }
  };
  const enabled = status?.enabled === true;
  const crossProjectAllowed = status?.crossProjectAllowed === true;

  return (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      <Alert
        type="info"
        showIcon
        message="问数：数字由程序计算，模型只负责组织语言"
        description={
          <span>
            回答里每个数字都会回查事实清单；对不上的数字会被拦下并提示你，不会当成结论给你。
            {enabled ? `当前可问 ${status?.datasets?.length ?? 0} 类数据。` : '（AI 未启用，请先到「系统管理 → AI 信息登记」配置）'}
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
                void askStream();
              }
            }}
          />
          <Space>
            <Button
              type="primary"
              icon={<ThunderboltOutlined />}
              loading={loading}
              disabled={!enabled || !currentProjectId}
              onClick={() => void askStream()}
            >
              提问
            </Button>
            <Text type="secondary">Enter 发送，Shift+Enter 换行</Text>
          </Space>
        </Space>
      </Card>

      {loading ? (
        <Card>
          <Space direction="vertical" size={8} style={{ width: '100%' }}>
            <Space>
              <Spin size="small" />
              <Text type="secondary">{phase || '正在取数…'}</Text>
            </Space>
            {streaming ? <ReportMarkdown text={streaming} /> : null}
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
              {result.periodLabel ? <Tag>{result.periodLabel}</Tag> : null}
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

            {/**
             * 提示（warnings）：取数口径提示、工具调用次数、模型意图回退等。
             * 这些原来是**一句都不显示**的——用户看不到「本轮调用了 1 次只读工具」或「模型返回的意图不是对象」，
             * 于是既无法判断结论依据，也没法在出问题时告诉运维发生了什么。收进折叠区：默认不打扰，需要时能展开。
             */}
            {result.warnings?.length ? (
              <Collapse
                size="small"
                items={[
                  {
                    key: 'warnings',
                    label: <Text type="secondary">提示 {result.warnings.length} 条（取数与模型过程的说明，不影响结论）</Text>,
                    children: (
                      <ul style={{ margin: 0, paddingLeft: 18 }}>
                        {result.warnings.map((w: string, i: number) => (
                          <li key={i}>
                            <Text type="secondary" style={{ fontSize: 12 }}>
                              {w}
                            </Text>
                          </li>
                        ))}
                      </ul>
                    ),
                  },
                ]}
              />
            ) : null}

            <ReportMarkdown text={result.answer} />

            {result.toolTrace?.length ? (
              <div>
                <Text type="secondary">工具调用：</Text>
                <Space size={4} wrap style={{ marginTop: 4 }}>
                  {result.toolTrace.map((t, i) => (
                    <Tag key={`${t.name}-${i}`} color={t.ok ? 'geekblue' : 'red'}>
                      {t.label}
                    </Tag>
                  ))}
                </Space>
              </div>
            ) : null}

            {result.datasetKeys?.length ? (
              <div>
                <Text type="secondary">依据：</Text>
                <Space size={4} wrap style={{ marginTop: 4 }}>
                  {result.datasetKeys.map((k) => (
                    <Tag key={k}>{labelOf(k)}</Tag>
                  ))}
                </Space>
              </div>
            ) : null}

            <Text type="secondary" style={{ fontSize: 12 }}>
              {result.scopeLabel ? `统计范围：${result.scopeLabel}。` : ''}
              结论仅基于上述数据集，不含未列出的信息。
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
                          answer: detail.markdown || '',
                          accepted: detail.source === 'llm',
                          discardedNumbers: detail.discardedNumbersJson || [],
                          datasetKeys: detail.datasetKeys || [],
                          scopeLabel: '',
                          periodLabel: h.periodLabel || '',
                          warnings: detail.warningsJson || [],
                          source: detail.source === 'llm' ? 'llm' : 'template',
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
        <Paragraph type="secondary" style={{ marginTop: 12, marginBottom: 0, fontSize: 12 }}>
          历史只保留你本人（超管可见全部）；每条都是当时的快照，重新提问会新增一条。
        </Paragraph>
      </Card>
    </Space>
  );
}
