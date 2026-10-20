import { Fragment, useState, type ReactNode } from 'react';
import {
  Alert,
  Button,
  Card,
  Collapse,
  DatePicker,
  Empty,
  Form,
  Input,
  Segmented,
  Space,
  Spin,
  Tag,
  Typography,
  message,
} from 'antd';
import { DownloadOutlined, FilePdfOutlined, FileTextOutlined, ThunderboltOutlined } from '@ant-design/icons';
import dayjs, { type Dayjs } from 'dayjs';
import { aiApi, type AiReportDelta, type AiReportResult } from '@/api/modules';

const { Text, Paragraph, Title } = Typography;

/** 环比文案：上期为 0 时后端给的是 null，这里如实写「上期为 0」，不编百分比 */
function pctText(d: AiReportDelta): string {
  return d.pct === null
    ? `上期为 0（本期 ${d.now}）`
    : `${d.pct > 0 ? '+' : ''}${d.pct.toFixed(2)}%（上期 ${d.prev} → 本期 ${d.now}）`;
}

/** 行内 `**加粗**` → <strong>（不引 markdown 依赖：材料只用到这一种行内语法） */
function inline(text: string, keyPrefix: string): ReactNode[] {
  return text.split(/(\*\*[^*]+\*\*)/g).filter(Boolean).map((seg, i) => {
    const m = /^\*\*([^*]+)\*\*$/.exec(seg);
    return m ? <strong key={`${keyPrefix}-${i}`}>{m[1]}</strong> : <Fragment key={`${keyPrefix}-${i}`}>{seg}</Fragment>;
  });
}

/**
 * 极简 Markdown 渲染：标题 / 无序列表 / 段落 / 行内加粗。
 * 不引 react-markdown —— 汇报材料只用得到这几种语法，多一个依赖不划算。
 */
function MiniMarkdown({ text }: { text: string }) {
  const blocks: ReactNode[] = [];
  let list: string[] = [];
  const flush = () => {
    if (!list.length) return;
    const items = list;
    list = [];
    blocks.push(
      <ul key={`ul-${blocks.length}`} style={{ margin: '4px 0 12px', paddingLeft: 20 }}>
        {items.map((t, i) => (
          <li key={i}>{inline(t, `li-${blocks.length}-${i}`)}</li>
        ))}
      </ul>,
    );
  };
  for (const raw of String(text || '').split('\n')) {
    const line = raw.trimEnd();
    if (!line.trim()) {
      flush();
      continue;
    }
    const h = /^(#{1,4})\s+(.*)$/.exec(line);
    if (h) {
      flush();
      const level = h[1].length;
      blocks.push(
        <Title key={`h-${blocks.length}`} level={level <= 2 ? 4 : 5} style={{ marginTop: 16, marginBottom: 8 }}>
          {inline(h[2], `h-${blocks.length}`)}
        </Title>,
      );
      continue;
    }
    const li = /^[-*]\s+(.*)$/.exec(line);
    if (li) {
      list.push(li[1]);
      continue;
    }
    flush();
    blocks.push(
      <Paragraph key={`p-${blocks.length}`} style={{ marginBottom: 8 }}>
        {inline(line, `p-${blocks.length}`)}
      </Paragraph>,
    );
  }
  flush();
  return <>{blocks}</>;
}
const { RangePicker } = DatePicker;
const { TextArea } = Input;

type ReportKind = 'monthly' | 'project' | 'brief';

const KIND_OPTIONS: { label: string; value: ReportKind }[] = [
  { label: '月度经营汇报', value: 'monthly' },
  { label: '项目履约汇报', value: 'project' },
  { label: '领导汇报摘要', value: 'brief' },
];

/**
 * AI 助手 · 汇报材料（三期）。
 *
 * 分工：**程序给事实、模型给文字**。页面上的数字全部来自后端聚合的事实清单，
 * 生成后会把材料里对不上的数字单独列出来（`unknownNumbers`）——
 * 汇报材料是给领导看的，编一个数字比写得平淡严重得多，所以宁可把风险摆到明面上。
 */
export default function AiReportPanel() {
  const [kind, setKind] = useState<ReportKind>('monthly');
  const [range, setRange] = useState<[Dayjs, Dayjs]>([dayjs().startOf('month'), dayjs()]);
  const [extra, setExtra] = useState('');
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<AiReportResult | null>(null);
  const [exporting, setExporting] = useState<'docx' | 'pdf' | null>(null);
  const [header, setHeader] = useState('');
  const [footer, setFooter] = useState('');

  const generate = async () => {
    setLoading(true);
    try {
      const res = await aiApi.reportGenerate({
        kind,
        from: range?.[0]?.format('YYYY-MM-DD'),
        to: range?.[1]?.format('YYYY-MM-DD'),
        extra: extra.trim() || undefined,
      });
      setResult(res);
      if (res.unknownNumbers.length) message.warning('材料里有数字未在系统数据中找到，请复核');
      else message.success('已生成，请核对后导出');
    } catch {
      // 拦截器已弹错
    } finally {
      setLoading(false);
    }
  };

  /** 导出：Word 与 PDF 都走同一个接口，只是 `format` 不同；页眉/页脚留空时后端走默认值 */
  const exportFile = async (format: 'docx' | 'pdf') => {
    if (!result) return;
    setExporting(format);
    try {
      const res = await aiApi.reportExport({
        markdown: result.markdown,
        title: `${result.facts.project.name}${result.label}`,
        header: header.trim() || undefined,
        footer: footer.trim() || undefined,
        format,
      });
      const blob = new Blob([res.data], {
        type:
          format === 'pdf'
            ? 'application/pdf'
            : 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      });
      const cd = res.headers?.['content-disposition'] || '';
      const m = /filename\*=UTF-8''([^;]+)/i.exec(cd);
      const fileName = m ? decodeURIComponent(m[1]) : `汇报材料.${format}`;
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

  return (
    <Card
      title={
        <Space>
          <FileTextOutlined />
          <span>AI 助手 · 汇报材料</span>
          {result ? <Tag color="green">{result.label}</Tag> : null}
        </Space>
      }
      extra={
        <Space>
          <Button icon={<DownloadOutlined />} loading={exporting === 'docx'} disabled={!result} onClick={() => exportFile('docx')}>
            导出 Word
          </Button>
          <Button icon={<FilePdfOutlined />} loading={exporting === 'pdf'} disabled={!result} onClick={() => exportFile('pdf')}>
            导出 PDF
          </Button>
        </Space>
      }
    >
      <Alert
        type="info"
        showIcon
        style={{ marginBottom: 12 }}
        message="用系统里的真实数据生成汇报材料：数字由程序汇总，AI 只负责组织语言"
        description="生成后请核对；材料里出现但系统数据对不上的数字会被单独列出来提示你。"
      />

      <Form layout="vertical">
        <Space wrap size={16} align="end" style={{ width: '100%' }}>
          <Form.Item label="材料类型" style={{ marginBottom: 8 }}>
            <Segmented
              options={KIND_OPTIONS}
              value={kind}
              onChange={(v) => setKind(v as ReportKind)}
            />
          </Form.Item>
          <Form.Item label="统计区间" style={{ marginBottom: 8 }}>
            <RangePicker
              value={range}
              allowClear={false}
              onChange={(v) => v && v[0] && v[1] && setRange([v[0], v[1]])}
            />
          </Form.Item>
          <Form.Item style={{ marginBottom: 8 }}>
            <Button type="primary" icon={<ThunderboltOutlined />} loading={loading} onClick={generate}>
              生成材料
            </Button>
          </Form.Item>
        </Space>
        <Space wrap size={16} align="end" style={{ width: '100%' }}>
          <Form.Item label="页眉（留空用标题）" style={{ marginBottom: 8 }}>
            <Input value={header} onChange={(e) => setHeader(e.target.value)} placeholder="例如：XX 项目月度情况报告" style={{ width: 260 }} />
          </Form.Item>
          <Form.Item label="页脚（留空用默认说明）" style={{ marginBottom: 8 }}>
            <Input value={footer} onChange={(e) => setFooter(e.target.value)} placeholder="例如：工程管理部　2026 年 10 月" style={{ width: 260 }} />
          </Form.Item>
        </Space>
        <Form.Item label="补充要求（可选）" style={{ marginBottom: 8 }}>
          <TextArea
            rows={2}
            value={extra}
            maxLength={200}
            placeholder="例如：重点写付款风险；面向集团领导，控制在一页以内"
            onChange={(e) => setExtra(e.target.value)}
          />
        </Form.Item>
      </Form>

      {loading && (
        <div style={{ padding: 32, textAlign: 'center' }}>
          <Spin tip="正在汇总数据并生成材料…" size="large">
            <div style={{ height: 48 }} />
          </Spin>
        </div>
      )}

      {!loading && result && (
        <>
          {result.warnings.length > 0 && (
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

          {result.unknownNumbers.length > 0 && (
            <Alert
              type="error"
              showIcon
              style={{ marginBottom: 12 }}
              message="以下数字未在系统数据中找到，请核对后再使用"
              description={result.unknownNumbers.join('、')}
            />
          )}

          <div
            style={{
              border: '1px solid var(--cms-hairline)',
              borderRadius: 8,
              padding: 16,
              background: 'var(--cms-canvas)',
              maxHeight: 620,
              overflow: 'auto',
            }}
          >
            <MiniMarkdown text={result.markdown} />
          </div>

          {result.missingSections.length > 0 && (
            <Alert
              type="warning"
              showIcon
              style={{ marginBottom: 12 }}
              message="材料缺少以下小节（模板骨架与 prompt 一致，模型偶尔会漏）"
              description={result.missingSections.join('、')}
            />
          )}

          <Collapse
            style={{ marginTop: 12 }}
            items={[
              {
                key: 'facts',
                label: '数据来源（事实清单，材料里的数字都来自这里）',
                children: (
                  <Paragraph style={{ whiteSpace: 'pre-wrap', marginBottom: 0 }} type="secondary">
                    {[
                      `公文骨架：${result.sections.join(' / ')}`,
                      `本期区间：${result.period.label}`,
                      `对比区间：${result.comparePeriod.label}`,
                      `项目累计：合同 ${result.facts.totals.contracts} 份（执行中 ${result.facts.totals.executing}），累计金额 ${result.facts.totals.contractAmount} 元，累计结算 ${result.facts.totals.settlementAmount} 元，累计付款 ${result.facts.totals.paymentAmount} 元，累计开票 ${result.facts.totals.invoiceAmount} 元，应付未付 ${result.facts.totals.unpaid} 元`,
                      `本期发生额：新签 ${result.facts.current.contractsSigned} 份 / ${result.facts.current.contractsSignedAmount} 元，结算 ${result.facts.current.settlementAmount} 元，付款 ${result.facts.current.paymentAmount} 元，开票 ${result.facts.current.invoiceAmount} 元，日报 ${result.facts.current.dailyReports} 条`,
                      `环比（上期 ${result.facts.compare.period.label}）：新签金额 ${pctText(result.facts.deltas.contractsSignedAmount)}，结算金额 ${pctText(result.facts.deltas.settlementAmount)}，付款金额 ${pctText(result.facts.deltas.paymentAmount)}，日报 ${pctText(result.facts.deltas.dailyReports)}`,
                      `系统识别风险：${result.facts.risks.length ? result.facts.risks.join('；') : '无'}`,
                    ].join('\n')}
                  </Paragraph>
                ),
              },
            ]}
          />
        </>
      )}

      {!loading && !result && (
        <Empty description="还没有生成材料：选好类型与区间后点「生成材料」" style={{ marginTop: 32 }} />
      )}

      <Paragraph type="secondary" style={{ marginTop: 12, marginBottom: 0 }}>
        <Text type="secondary">
          口径：合同金额按合同链（主合同 + 补充协议）累计；结算排除草稿；付款排除失败/退款；
          应付未付 = 累计结算 − 累计付款（可为负，负值说明付超了）。
        </Text>
      </Paragraph>
    </Card>
  );
}
