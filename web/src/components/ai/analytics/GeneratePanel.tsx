import { useMemo, useState } from 'react';
import {
  Alert,
  Button,
  Card,
  Checkbox,
  Col,
  Collapse,
  DatePicker,
  Descriptions,
  Divider,
  Empty,
  Form,
  Input,
  Radio,
  Row,
  Segmented,
  Select,
  Space,
  Switch,
  Tag,
  Typography,
  message,
} from 'antd';
import { DownloadOutlined, FileTextOutlined, ThunderboltOutlined } from '@ant-design/icons';
import dayjs, { type Dayjs } from 'dayjs';
import {
  aiApi,
  type AiAnalyticsDatasetMeta,
  type AiAnalyticsPlanResult,
  type AiAnalyticsReportResult,
  type AiCompareMode,
  type AiPeriodPreset,
  type AiScopeMode,
} from '@/api/modules';
import ReportMarkdown from '@/components/ReportMarkdown';

const { Text, Paragraph } = Typography;

const PRESET_OPTIONS: Array<{ value: AiPeriodPreset; label: string }> = [
  { value: 'this_month', label: '本月' },
  { value: 'last_month', label: '上月' },
  { value: 'this_quarter', label: '本季度' },
  { value: 'this_year', label: '今年' },
  { value: 'ytd', label: '年初至今' },
  { value: 'last_30_days', label: '近 30 天' },
  { value: 'last_90_days', label: '近 90 天' },
  { value: 'all', label: '累计至今' },
  { value: 'custom', label: '自定义' },
];

const KIND_OPTIONS = [
  { value: 'monthly', label: '月度经营简报' },
  { value: 'brief', label: '领导简报' },
  { value: 'project', label: '项目履约简报' },
  { value: 'comparison', label: '对比简报' },
  { value: 'custom', label: '经营数据报告' },
];

const SCOPE_LABEL: Record<AiScopeMode, string> = { current: '当前项目', selected: '多选项目', all: '全部项目' };

export interface GeneratePanelProps {
  datasets: AiAnalyticsDatasetMeta[];
  defaultKeys: string[];
  projects: Array<{ id: string; code: string; name: string }>;
  crossProjectAllowed: boolean;
  /** 生成成功后通知历史页签刷新 */
  onSaved: () => void;
}

/**
 * 生成页签（Phase 2）：范围/期间/数据集/自然语言 → 意图预览 → 确定性报告。
 * 数由程序算、排版由程序生成；本阶段不调用模型（`source='template'`）。
 */
export default function GeneratePanel({ datasets, defaultKeys, projects, crossProjectAllowed, onSaved }: GeneratePanelProps) {
  const [scopeMode, setScopeMode] = useState<AiScopeMode>('current');
  const [projectIds, setProjectIds] = useState<string[]>([]);
  const [preset, setPreset] = useState<AiPeriodPreset>('this_month');
  const [customRange, setCustomRange] = useState<[Dayjs, Dayjs] | null>(null);
  const [compare, setCompare] = useState<AiCompareMode>('mom');
  const [selectedKeys, setSelectedKeys] = useState<string[]>(defaultKeys);
  const [text, setText] = useState('');
  const [reportKind, setReportKind] = useState<string | undefined>();
  const [detail, setDetail] = useState<string | undefined>();
  const [notes, setNotes] = useState('');
  const [title, setTitle] = useState('');
  const [narrative, setNarrative] = useState(true);
  const [planning, setPlanning] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [exporting, setExporting] = useState<'docx' | 'pdf' | null>(null);
  const [plan, setPlan] = useState<AiAnalyticsPlanResult | null>(null);
  const [result, setResult] = useState<AiAnalyticsReportResult | null>(null);

  const labelByKey = useMemo(() => new Map(datasets.map((d) => [d.key, d.label])), [datasets]);

  const body = (): Record<string, unknown> => {
    const b: Record<string, unknown> = {
      text: text.trim() || undefined,
      scope: { mode: scopeMode, projectIds: scopeMode === 'selected' ? projectIds : undefined },
      period:
        preset === 'custom'
          ? customRange
            ? { preset: 'custom', from: customRange[0].format('YYYY-MM-DD'), to: customRange[1].format('YYYY-MM-DD') }
            : { preset }
          : { preset },
      datasets: selectedKeys.length ? selectedKeys : undefined,
      compare,
      notes: notes.trim() || undefined,
      reportKind,
      detail,
      narrative,
    };
    return b;
  };

  const doPlan = async () => {
    setPlanning(true);
    try {
      setPlan(await aiApi.analyticsPlan(body()));
    } catch {
      // 拦截器已弹错
    } finally {
      setPlanning(false);
    }
  };

  const doGenerate = async () => {
    if (scopeMode === 'selected' && !projectIds.length) {
      message.warning('多选项目里还没有选择项目');
      return;
    }
    if (preset === 'custom' && !customRange) {
      message.warning('自定义期间需要选择开始与结束日期');
      return;
    }
    setGenerating(true);
    try {
      const res = await aiApi.analyticsReport({ ...body(), title: title.trim() || undefined });
      setResult(res);
      setPlan(null);
      if (res.persisted) {
        message.success('报告已生成并保存到历史');
        onSaved();
      } else {
        message.warning('报告已生成，但历史记录保存失败');
      }
    } catch {
      // 拦截器已弹错
    } finally {
      setGenerating(false);
    }
  };

  const doExport = async (format: 'docx' | 'pdf') => {
    if (!result?.id) return;
    setExporting(format);
    try {
      const res = await aiApi.analyticsExport(result.id, format);
      const blob = new Blob([res.data], {
        type:
          format === 'pdf'
            ? 'application/pdf'
            : 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      });
      const cd = (res.headers && (res.headers['content-disposition'] as string)) || '';
      const m = /filename\*=UTF-8''([^;]+)/i.exec(cd);
      const fileName = m ? decodeURIComponent(m[1]) : `${result.title}.${format}`;
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
    } finally {
      setExporting(null);
    }
  };

  const datasetLabels = (keys: string[]) => keys.map((k) => labelByKey.get(k) ?? k);

  return (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      <Card title="生成经营数据报告">
        <Form layout="vertical">
          <Row gutter={[16, 0]}>
            <Col xs={24} lg={12} xl={8}>
              <Form.Item label="范围">
                <Segmented
                  block
                  value={scopeMode}
                  onChange={(v) => setScopeMode(v as AiScopeMode)}
                  options={[
                    { value: 'current', label: '当前项目' },
                    { value: 'selected', label: '多选项目', disabled: !crossProjectAllowed },
                    { value: 'all', label: '全部项目', disabled: !crossProjectAllowed },
                  ]}
                />
                {!crossProjectAllowed && (
                  <Text type="secondary" style={{ fontSize: 12 }}>
                    跨项目汇总需要「统计报表-查看」权限
                  </Text>
                )}
              </Form.Item>
            </Col>
            {scopeMode === 'selected' && (
              <Col xs={24} lg={12} xl={8}>
                <Form.Item label="选择项目">
                  <Select
                    mode="multiple"
                    allowClear
                    showSearch
                    maxTagCount="responsive"
                    placeholder="选择要汇总的项目"
                    value={projectIds}
                    onChange={setProjectIds}
                    options={projects.map((p) => ({ value: p.id, label: `${p.name}（${p.code}）` }))}
                  />
                </Form.Item>
              </Col>
            )}
            <Col xs={24} lg={12} xl={8}>
              <Form.Item label="期间">
                <Space wrap>
                  <Select
                    style={{ width: 140 }}
                    value={preset}
                    onChange={setPreset}
                    options={PRESET_OPTIONS}
                  />
                  {preset === 'custom' && (
                    <DatePicker.RangePicker
                      value={customRange}
                      onChange={(v) => setCustomRange(v as [Dayjs, Dayjs] | null)}
                    />
                  )}
                </Space>
              </Form.Item>
            </Col>
            <Col xs={24} lg={12} xl={8}>
              <Form.Item label="对比">
                <Radio.Group value={compare} onChange={(e) => setCompare(e.target.value)}>
                  <Radio.Button value="mom">环比</Radio.Button>
                  <Radio.Button value="yoy">同比</Radio.Button>
                  <Radio.Button value="none">不对比</Radio.Button>
                </Radio.Group>
              </Form.Item>
            </Col>
          </Row>

          <Form.Item label={`数据集（最多 8 个，已选 ${selectedKeys.length}）`}>
            <Checkbox.Group
              value={selectedKeys}
              onChange={(v) => setSelectedKeys(v as string[])}
              options={datasets.map((d) => ({
                value: d.key,
                label: (
                  <span title={d.desc}>
                    {d.label}
                    <Text type="secondary" style={{ fontSize: 12, marginLeft: 4 }}>
                      {d.desc}
                    </Text>
                  </span>
                ),
              }))}
            />
          </Form.Item>

          <Form.Item label="自然语言描述（可选）" extra="模型只用于理解意图：不会产生项目 ID、日期或数字。">
            <Input.TextArea
              rows={3}
              maxLength={2000}
              showCount
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder="例：汇总全部项目今年合同、结算、付款和发票，出一份给领导的简报"
            />
          </Form.Item>

          <Collapse
            ghost
            items={[
              {
                key: 'advanced',
                label: '高级选项',
                children: (
                  <Row gutter={[16, 0]}>
                    <Col xs={24} md={8}>
                      <Form.Item label="报告类型">
                        <Select allowClear placeholder="按描述自动判断" value={reportKind} onChange={setReportKind} options={KIND_OPTIONS} />
                      </Form.Item>
                    </Col>
                    <Col xs={24} md={8}>
                      <Form.Item label="明细程度">
                        <Select
                          allowClear
                          placeholder="默认汇总"
                          value={detail}
                          onChange={setDetail}
                          options={[
                            { value: 'summary', label: '汇总' },
                            { value: 'detail', label: '明细' },
                            { value: 'both', label: '汇总 + 明细' },
                          ]}
                        />
                      </Form.Item>
                    </Col>
                    <Col xs={24} md={8}>
                      <Form.Item label="标题（留空自动生成）">
                        <Input maxLength={60} value={title} onChange={(e) => setTitle(e.target.value)} />
                      </Form.Item>
                    </Col>
                    <Col xs={24} md={8}>
                      <Form.Item label="AI 撰写分析段落" extra="关闭则只出确定性表格与汇总">
                        <Switch checked={narrative} onChange={setNarrative} />
                      </Form.Item>
                    </Col>
                    <Col span={24}>
                      <Form.Item label="补充说明（只影响写作，不影响取数）">
                        <Input maxLength={300} value={notes} onChange={(e) => setNotes(e.target.value)} />
                      </Form.Item>
                    </Col>
                  </Row>
                ),
              },
            ]}
          />

          <Space wrap>
            <Button icon={<ThunderboltOutlined />} loading={planning} onClick={doPlan}>
              解析意图
            </Button>
            <Button type="primary" icon={<FileTextOutlined />} loading={generating} onClick={doGenerate}>
              生成报告
            </Button>
          </Space>
        </Form>
      </Card>

      {plan && (
        <Card title="意图预览" extra={<Text type="secondary">来源：{plan.source === 'rules' ? '规则解析' : '模型'}</Text>}>
          <Descriptions column={{ xs: 1, md: 2, xl: 3 }} size="small">
            <Descriptions.Item label="范围">{SCOPE_LABEL[plan.intent.scope.mode] ?? plan.intent.scope.mode}</Descriptions.Item>
            <Descriptions.Item label="期间">
              {PRESET_OPTIONS.find((p) => p.value === plan.intent.period.preset)?.label ?? plan.intent.period.preset}
              {plan.intent.period.preset === 'custom' ? `（${plan.intent.period.from} ~ ${plan.intent.period.to}）` : ''}
            </Descriptions.Item>
            <Descriptions.Item label="对比">
              {plan.intent.compare === 'yoy' ? '同比' : plan.intent.compare === 'mom' ? '环比' : '不对比'}
            </Descriptions.Item>
            <Descriptions.Item label="报告类型">
              {KIND_OPTIONS.find((k) => k.value === plan.intent.reportKind)?.label ?? plan.intent.reportKind}
            </Descriptions.Item>
            <Descriptions.Item label="项目数">{plan.projects.length}</Descriptions.Item>
            <Descriptions.Item label="数据集">{plan.intent.datasets.length}</Descriptions.Item>
          </Descriptions>
          <div style={{ marginTop: 8 }}>
            {datasetLabels(plan.intent.datasets).map((label) => (
              <Tag key={label} color="blue">
                {label}
              </Tag>
            ))}
          </div>
          {!!plan.warnings.length && (
            <Alert
              style={{ marginTop: 12 }}
              type="warning"
              showIcon
              message="解析提醒"
              description={
                <ul style={{ margin: 0, paddingLeft: 18 }}>
                  {plan.warnings.map((w) => (
                    <li key={w}>{w}</li>
                  ))}
                </ul>
              }
            />
          )}
        </Card>
      )}

      {result && (
        <Card
          title={result.title}
          extra={
            <Space wrap>
              <Button icon={<DownloadOutlined />} loading={exporting === 'docx'} disabled={!result.id} onClick={() => doExport('docx')}>
                Word
              </Button>
              <Button icon={<DownloadOutlined />} loading={exporting === 'pdf'} disabled={!result.id} onClick={() => doExport('pdf')}>
                PDF
              </Button>
            </Space>
          }
        >
          {!result.persisted && (
            <Alert
              style={{ marginBottom: 12 }}
              type="warning"
              showIcon
              message="历史记录保存失败：本次结果仍可查看，但刷新后不可找回。"
            />
          )}
          {!!result.discardedNumbers.length && (
            <Alert
              style={{ marginBottom: 12 }}
              type="error"
              showIcon
              message="模型叙述包含无法对账的数字，已整段丢弃，报告改用确定性结果"
              description={result.discardedNumbers.join('、')}
            />
          )}
          {!!result.warnings.length && (
            <Alert
              style={{ marginBottom: 12 }}
              type="warning"
              showIcon
              message="生成提醒"
              description={
                <ul style={{ margin: 0, paddingLeft: 18 }}>
                  {result.warnings.map((w) => (
                    <li key={w}>{w}</li>
                  ))}
                </ul>
              }
            />
          )}
          <Space wrap style={{ marginBottom: 8 }}>
            {result.sections.map((s) => (
              <Tag key={s.id}>{s.title}</Tag>
            ))}
            <Tag color={result.source === 'template' ? 'default' : 'green'}>
              {result.source === 'template' ? '确定性模板' : '模型叙述'}
            </Tag>
          </Space>
          <Divider style={{ margin: '8px 0 12px' }} />
          {result.markdown ? <ReportMarkdown text={result.markdown} /> : <Empty description="没有生成内容" />}
          <Paragraph type="secondary" style={{ fontSize: 12, marginTop: 12 }}>
            口径：业务发生日归期；合同金额按合同链（主合同 + Σ 补充协议增量）；发票排除作废/红冲；未填金额按未知处理。
          </Paragraph>
        </Card>
      )}
    </Space>
  );
}
