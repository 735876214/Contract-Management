import { useEffect, useMemo, useState } from 'react';
import {
  Alert,
  Button,
  Card,
  Col,
  Collapse,
  Row,
  Select,
  Space,
  Statistic,
  Switch,
  Table,
  Tag,
  Typography,
} from 'antd';
import { BarChartOutlined, DownloadOutlined, FileTextOutlined } from '@ant-design/icons';
import type { ColumnsType } from 'antd/es/table';
import { aiApi, type AiScmProjectFacts, type AiScmResult, type AiScmSupplierFacts } from '@/api/modules';
import { projectApi } from '@/api/business';
import EmptyState from '@/components/EmptyState';
import ReportMarkdown from '@/components/ReportMarkdown';

const { Text } = Typography;

/**
 * 供应链运营全景（课题 7-11）。
 *
 * 定位与三个预警面板不同：那三个是「核对清单」，这个是**汇报材料**。
 * 共同的底线不变：**程序给数字、模型给文字**。
 * - 签约额/结算额/付款额/开票额/比例/逾期节点全部由后端事实层算出（`scm-facts.ts`，有真值单测锁口径）；
 * - 模型只许抄这些数字写结论，正文里出现对不上的数字就整段丢弃并在这里提示（`discardedNumbers`）；
 * - 导出 Word/PDF 用的是**页面上的同一份 Markdown**，不重新生成——避免「预览一套、导出另一套」。
 * - 跨项目看数是敏感动作：后端要求跨项目权限（`dashboard:view`），只有一个项目权限时会被拒。
 */
export default function ScmAnalysisPanel() {
  const [projectIds, setProjectIds] = useState<string[]>([]);
  const [useAi, setUseAi] = useState(true);
  const [loading, setLoading] = useState(false);
  const [exporting, setExporting] = useState<'docx' | 'pdf' | null>(null);
  const [result, setResult] = useState<AiScmResult | null>(null);
  const [projects, setProjects] = useState<Array<{ id: string; code: string; name: string }>>([]);

  useEffect(() => {
    projectApi
      .list({ page: 1, pageSize: 200 })
      .then((res: any) => {
        const list = res?.list || res?.items || res || [];
        setProjects(
          (Array.isArray(list) ? list : []).map((p: any) => ({
            id: p.id,
            code: p.code || '',
            name: p.name || '',
          })),
        );
      })
      .catch(() => setProjects([]));
  }, []);

  const generate = async () => {
    setLoading(true);
    try {
      const res = await aiApi.supplyChain({
        projectIds: projectIds.length ? projectIds.join(',') : undefined,
        narrative: useAi ? undefined : '0',
      });
      setResult(res);
    } catch {
      // 拦截器已弹错；保留上一次结果，避免用户以为「重新生成成功」
    } finally {
      setLoading(false);
    }
  };

  const exportFile = async (format: 'docx' | 'pdf') => {
    if (!result?.markdown) return;
    setExporting(format);
    try {
      const res = await aiApi.reportExport({
        markdown: result.markdown,
        title: '供应链运营全景',
        format,
      });
      const blob = new Blob([res.data], {
        type:
          format === 'pdf'
            ? 'application/pdf'
            : 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      });
      const cd = (res.headers && (res.headers['content-disposition'] as string)) || '';
      const m = /filename\*=UTF-8''([^;]+)/i.exec(cd);
      const fileName = m ? decodeURIComponent(m[1]) : `供应链运营全景.${format}`;
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

  const money = (v: number | null | undefined) =>
    v === null || v === undefined
      ? '—'
      : Number(v).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

  const pct = (v: number | null | undefined) => (v === null || v === undefined ? '—' : `${v.toFixed(1)}%`);

  const projectColumns: ColumnsType<AiScmProjectFacts> = useMemo(
    () => [
      {
        title: '项目',
        dataIndex: 'name',
        key: 'name',
        width: 200,
        render: (_: unknown, r) => (
          <Space direction="vertical" size={0}>
            <Text strong>{r.name}</Text>
            <Text type="secondary" style={{ fontSize: 12 }}>
              {r.code}
            </Text>
          </Space>
        ),
      },
      { title: '合同数', dataIndex: 'contractCount', key: 'contractCount', width: 90, align: 'right' },
      {
        title: '签约额',
        dataIndex: 'signedYuan',
        key: 'signedYuan',
        width: 140,
        align: 'right',
        render: (v: number) => money(v),
      },
      {
        title: '结算额',
        dataIndex: 'settledYuan',
        key: 'settledYuan',
        width: 140,
        align: 'right',
        render: (v: number) => money(v),
      },
      {
        title: '付款额',
        dataIndex: 'paidYuan',
        key: 'paidYuan',
        width: 140,
        align: 'right',
        render: (v: number) => money(v),
      },
      {
        title: '付款率',
        dataIndex: 'payRatioPct',
        key: 'payRatioPct',
        width: 100,
        align: 'right',
        render: (v: number | null) =>
          v !== null && v > 100 ? <Text type="danger">{pct(v)}</Text> : pct(v),
      },
      {
        title: '开票率',
        dataIndex: 'invoiceRatioPct',
        key: 'invoiceRatioPct',
        width: 100,
        align: 'right',
        render: (v: number | null) => pct(v),
      },
      {
        title: '逾期节点',
        dataIndex: 'overdueMilestones',
        key: 'overdueMilestones',
        width: 100,
        align: 'right',
        render: (v: number) => (v > 0 ? <Text type="warning">{v}</Text> : v),
      },
    ],
    [],
  );

  const supplierColumns: ColumnsType<AiScmSupplierFacts> = [
    { title: '供应商', dataIndex: 'name', key: 'name', width: 260 },
    { title: '合同数', dataIndex: 'contractCount', key: 'contractCount', width: 90, align: 'right' },
    {
      title: '签约额',
      dataIndex: 'signedYuan',
      key: 'signedYuan',
      width: 160,
      align: 'right',
      render: (v: number) => money(v),
    },
    {
      title: '占比',
      dataIndex: 'sharePct',
      key: 'sharePct',
      width: 100,
      align: 'right',
      render: (v: number) => pct(v),
    },
  ];

  const disabled = result && !result.enabled;

  return (
    <Card
      title={
        <Space>
          <BarChartOutlined />
          <span>供应链运营全景</span>
        </Space>
      }
      extra={
        <Space wrap>
          <Select
            mode="multiple"
            allowClear
            showSearch
            optionFilterProp="label"
            placeholder="全部有权限的项目"
            style={{ minWidth: 240, maxWidth: 420 }}
            value={projectIds}
            onChange={(v) => setProjectIds(v as string[])}
            options={projects.map((p) => ({ value: p.id, label: `${p.name}（${p.code}）` }))}
            maxTagCount="responsive"
          />
          <Space size={6}>
            <Text type="secondary" style={{ fontSize: 12 }}>
              调用 AI 撰写
            </Text>
            <Switch
              size="small"
              checked={useAi}
              onChange={setUseAi}
              checkedChildren="开"
              unCheckedChildren="关"
            />
          </Space>
          <Button type="primary" icon={<FileTextOutlined />} loading={loading} onClick={generate}>
            生成报告
          </Button>
        </Space>
      }
    >
      <Alert
        type="info"
        showIcon
        style={{ marginBottom: 16 }}
        message="数字由系统算，AI 只负责组织语言"
        description="签约额按合同链汇总（补充协议只算变更金额）；草稿结算、失败付款、红冲发票不计入；比例的分母为 0 时显示「—」而不是 0%。正文里凡出现与事实对不上的数字，该段落会被丢弃并在下方提示。"
      />

      {disabled && (
        <Alert
          type="warning"
          showIcon
          style={{ marginBottom: 16 }}
          message="供应链全景已停用"
          description="系统参数 ai.analysis.enabled 已关闭，接口不再生成报告。"
        />
      )}

      {result?.warnings?.length ? (
        <Alert
          type="warning"
          showIcon
          style={{ marginBottom: 16 }}
          message="生成过程中的提示"
          description={
            <ul style={{ margin: 0, paddingLeft: 18 }}>
              {result.warnings.map((w, i) => (
                <li key={i}>{w}</li>
              ))}
            </ul>
          }
        />
      ) : null}

      {result && result.discardedNumbers.length > 0 && (
        <Alert
          type="warning"
          showIcon
          style={{ marginBottom: 16 }}
          message={`模型输出了 ${result.discardedNumbers.length} 个对不上的数字，相关段落已丢弃`}
          description={`涉及：${result.discardedNumbers.slice(0, 12).join('、')}${result.discardedNumbers.length > 12 ? ' 等' : ''}`}
        />
      )}

      {result && (
        <Space wrap size={[8, 8]} style={{ marginBottom: 16 }}>
          <Tag color="blue">{result.scope}</Tag>
          <Tag>基准日 {result.asOf}</Tag>
          <Tag color={result.source === 'llm' ? 'green' : 'default'}>
            {result.source === 'llm' ? 'AI 撰写（数字已对账）' : '确定性汇总'}
          </Tag>
          <Tag>{result.toleranceText}</Tag>
          {result.missingSections.length > 0 && (
            <Tag color="orange">缺章节：{result.missingSections.join('、')}</Tag>
          )}
        </Space>
      )}

      {result && (
        <Row gutter={[16, 16]} style={{ marginBottom: 8 }}>
          <Col xs={12} sm={8} xl={4}>
            <Statistic title="项目数" value={result.facts.totals.projectCount} />
          </Col>
          <Col xs={12} sm={8} xl={4}>
            <Statistic title="签约额（元）" value={money(result.facts.totals.signedYuan)} />
          </Col>
          <Col xs={12} sm={8} xl={4}>
            <Statistic title="结算额（元）" value={money(result.facts.totals.settledYuan)} />
          </Col>
          <Col xs={12} sm={8} xl={4}>
            <Statistic title="付款额（元）" value={money(result.facts.totals.paidYuan)} />
          </Col>
          <Col xs={12} sm={8} xl={4}>
            <Statistic title="开票额（元）" value={money(result.facts.totals.invoicedYuan)} />
          </Col>
          <Col xs={12} sm={8} xl={4}>
            <Statistic title="逾期节点" value={result.facts.totals.overdueMilestones} />
          </Col>
        </Row>
      )}

      {result ? (
        <>
          <Card
            type="inner"
            title="报告正文"
            style={{ marginBottom: 16 }}
            extra={
              <Space>
                <Button
                  size="small"
                  icon={<DownloadOutlined />}
                  loading={exporting === 'docx'}
                  disabled={!result.markdown}
                  onClick={() => exportFile('docx')}
                >
                  Word
                </Button>
                <Button
                  size="small"
                  icon={<DownloadOutlined />}
                  loading={exporting === 'pdf'}
                  disabled={!result.markdown}
                  onClick={() => exportFile('pdf')}
                >
                  PDF
                </Button>
              </Space>
            }
          >
            {result.markdown ? (
              <ReportMarkdown text={result.markdown} />
            ) : (
              <EmptyState description="本次没有生成正文（模型未配置或已关闭）" compact />
            )}
          </Card>

          <Collapse
            items={[
              {
                key: 'facts',
                label: `事实清单（数字出处，${result.facts.projects.length} 个项目 / ${result.facts.suppliers.length} 家供应商）`,
                children: (
                  <Space direction="vertical" size={16} style={{ width: '100%' }}>
                    {result.facts.empty ? (
                      <EmptyState description="所选范围内没有可汇总的数据" compact />
                    ) : (
                      <>
                        <Space wrap size={[8, 4]}>
                          <Text type="secondary" style={{ fontSize: 12 }}>
                            扫描数据量：
                          </Text>
                          {Object.entries(result.sample).map(([k, v]) => (
                            <Tag key={k}>
                              {k} {v}
                            </Tag>
                          ))}
                        </Space>
                        <Table
                          rowKey="projectId"
                          size="small"
                          columns={projectColumns}
                          dataSource={result.facts.projects}
                          pagination={false}
                          scroll={{ x: 1000 }}
                        />
                        <Table
                          rowKey={(r) => r.supplierId || r.name}
                          size="small"
                          columns={supplierColumns}
                          dataSource={result.facts.suppliers}
                          pagination={false}
                          scroll={{ x: 620 }}
                        />
                        {result.facts.risks.length > 0 && (
                          <Alert
                            type="warning"
                            showIcon
                            message="系统判定的风险点（模型只许转述，不许自行加戏）"
                            description={
                              <ul style={{ margin: 0, paddingLeft: 18 }}>
                                {result.facts.risks.map((r, i) => (
                                  <li key={i}>{r}</li>
                                ))}
                              </ul>
                            }
                          />
                        )}
                      </>
                    )}
                  </Space>
                ),
              },
            ]}
          />
        </>
      ) : (
        <EmptyState
          description="还没有生成报告：选定项目范围后点「生成报告」"
          actionText="生成报告"
          onAction={generate}
          height={220}
        />
      )}
    </Card>
  );
}
