import { useCallback, useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import {
  Alert,
  Button,
  Card,
  Col,
  Descriptions,
  Drawer,
  Empty,
  Input,
  InputNumber,
  Modal,
  Popconfirm,
  Row,
  Select,
  Space,
  Spin,
  Table,
  Tag,
  Tooltip,
  message,
} from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { DownloadOutlined, EyeOutlined, SaveOutlined, SendOutlined } from '@ant-design/icons';
import dayjs from 'dayjs';
import { procurementTaskApi } from '@/api/modules';
import { projectApi } from '@/api/business';
import { useAuthStore } from '@/store/auth';
import { taskStatusLabel, taskTypeLabel } from '@/constants/procurementWorkflow';
import {
  getProcurementVariableGroups,
  replaceProcurementVariables,
} from '@/constants/procurementVariables';
import RichTextEditor from '@/components/RichTextEditor';
import PreviewPublishModal from '@/components/PreviewPublishModal';
import ModuleDetailCard, { useModuleDetailDoc } from '@/components/procurement/ModuleDetailCard';
import { exportProcurementWord } from '@/utils/procurementExport';
import {
  buildPriceCompareDocHtml,
  buildPriceCompareVariableValues,
  deriveRow,
  fmtAmount,
  fmtQty,
  fmtRate,
  PRICING_METHODS,
  pricingMethodLabel,
  summarizePriceCompare,
  type PriceCompareItemRow,
} from '@/utils/procurementPriceCompare';

/** 模块类型（与采购模板 moduleType、变量占位符前缀一致） */
const MODULE_TYPE = 'PRICE_COMPARE';

interface TaskRow {
  id: string;
  taskNo: string;
  type: string;
  content: string;
  status: string;
  stage: number;
  preMeetingRequired: boolean;
}

/** 明细行（表格需要 key） */
interface KeyedRow extends PriceCompareItemRow {
  key: string;
  materialBaseId: string;
}

interface PriceForm {
  pricingMethod: string;
  benefitAnalysis: string;
}

interface PriceDetail {
  task: TaskRow;
  stageIndex: number;
  resultReportStageIndex: number;
  /** 成交报告是否已完成（本模块入口条件） */
  resultReportCompleted: boolean;
  reached: boolean;
  editable: boolean;
  published: boolean;
  status: string;
  statusLabel: string;
  content: string;
  /** 明细行（总采购清单派生 + 已保存的成交价/备注） */
  items: PriceCompareItemRow[];
  data:
    | {
        id?: string;
        pricingMethod?: string;
        benefitAnalysis?: string;
        publishedAt?: string | null;
        items?: PriceCompareItemRow[];
      }
    | null;
}

const EMPTY_FORM: PriceForm = { pricingMethod: '', benefitAnalysis: '' };

export default function PriceCompare() {
  const [searchParams, setSearchParams] = useSearchParams();
  const currentProjectId = useAuthStore((s) => s.currentProjectId);

  const [tasks, setTasks] = useState<TaskRow[]>([]);
  const [tasksLoading, setTasksLoading] = useState(true);
  const [taskId, setTaskId] = useState<string | null>(searchParams.get('taskId') || null);

  const [detail, setDetail] = useState<PriceDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);

  const [form, setForm] = useState<PriceForm>(EMPTY_FORM);
  const [rows, setRows] = useState<KeyedRow[]>([]);

  const [saving, setSaving] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const [reEditing, setReEditing] = useState(false);
  /** 统一预览/发布弹窗（批次四 · 任务 4.2）：publish=发布前确认；preview=纯预览 */
  const [modalMode, setModalMode] = useState<'preview' | 'publish' | null>(null);
  /** 编辑弹窗（需求修正 · 修改二）：主视图只读详情，编辑在弹窗中进行 */
  const [editOpen, setEditOpen] = useState(false);

  const [project, setProject] = useState<{
    name?: string;
    code?: string;
    nameAbbr?: string;
    undertaker?: string;
    provinceCity?: string;
    siteLocation?: string;
    projectAddress?: string;
  }>({});

  const currentTask = detail?.task ?? null;
  const editable = !!detail && (detail.editable || (detail.published && reEditing));
  const content = detail?.content || currentTask?.content || '';

  /** 仅「成交报告已完成」（价格对比表编制中）的任务可进入编辑 */
  const priceTasks = useMemo(
    () => tasks.filter((t) => t.status === 'PRICE_COMPARE_EDITING'),
    [tasks],
  );

  /** 表底汇总（清单收入总金额 / 标准成本总金额 / 采购效益率 / 采购成本降低率） */
  const summary = useMemo(() => summarizePriceCompare(rows), [rows]);

  useEffect(() => {
    setTasksLoading(true);
    procurementTaskApi
      .list({ type: 'SINGLE', pageSize: 200 })
      .then((res: any) => setTasks(res?.list ?? res?.data?.list ?? []))
      .catch(() => setTasks([]))
      .finally(() => setTasksLoading(false));
  }, []);

  useEffect(() => {
    if (!currentProjectId) return;
    projectApi
      .detail(currentProjectId)
      .then((res: any) => setProject(res ?? {}))
      .catch(() => setProject({}));
  }, [currentProjectId]);

  const loadDetail = useCallback((id: string) => {
    setDetailLoading(true);
    procurementTaskApi
      .priceCompare(id)
      .then((res: any) => {
        const d: PriceDetail = res?.data ?? res;
        setDetail(d);
        const data = (d?.data ?? {}) as NonNullable<PriceDetail['data']>;
        setForm({
          pricingMethod: data.pricingMethod ?? '',
          benefitAnalysis: data.benefitAnalysis ?? '',
        });
        const list = Array.isArray(d?.items) ? d.items : [];
        setRows(
          list.map((r, i) => ({
            ...r,
            key: r.materialBaseId ? String(r.materialBaseId) : `row-${i}`,
            materialBaseId: String(r.materialBaseId ?? ''),
            dealPrice: r.dealPrice ?? null,
            remark: r.remark ?? '',
          })),
        );
        setReEditing(false);
      })
      .catch(() => {
        setDetail(null);
        setForm(EMPTY_FORM);
        setRows([]);
      })
      .finally(() => setDetailLoading(false));
  }, []);

  useEffect(() => {
    if (taskId) loadDetail(taskId);
  }, [taskId, loadDetail]);

  const selectTask = (id: string) => {
    setTaskId(id);
    setSearchParams({ taskId: id }, { replace: true });
  };

  const patchRow = (key: string, patch: Partial<KeyedRow>) =>
    setRows((prev) => prev.map((r) => (r.key === key ? { ...r, ...patch } : r)));

  /* ---------------- 保存 / 发布 / 导出 ---------------- */

  const buildSavePayload = () => ({
    pricingMethod: form.pricingMethod,
    benefitAnalysis: form.benefitAnalysis,
    // 仅提交用户录入的两列，其余列由后端按总采购清单回填
    items: rows.map((r) => ({
      materialBaseId: r.materialBaseId,
      dealPrice: r.dealPrice ?? null,
      remark: r.remark ?? '',
    })),
  });

  const handleSave = async () => {
    if (!taskId) return;
    setSaving(true);
    try {
      await procurementTaskApi.savePriceCompare(taskId, buildSavePayload());
      message.success('已保存');
      setEditOpen(false);
      loadDetail(taskId);
    } finally {
      setSaving(false);
    }
  };

  const openPublishPreview = () => {
    if (!form.pricingMethod) {
      message.warning('请先选择「计价方式」再发布');
      return;
    }
    if (!form.benefitAnalysis.trim() || form.benefitAnalysis === '<p><br></p>') {
      message.warning('请先填写「采购效益分析说明」再发布');
      return;
    }
    setModalMode('publish');
  };

  const handlePublish = async () => {
    if (!taskId) return;
    setPublishing(true);
    try {
      await procurementTaskApi.savePriceCompare(taskId, buildSavePayload());
      await procurementTaskApi.publish(taskId);
      message.success('已发布，采购价格对比表状态变更为「已完成」');
      setModalMode(null);
      loadDetail(taskId);
    } finally {
      setPublishing(false);
    }
  };

  const priceData = useMemo(
    () => ({
      pricingMethod: form.pricingMethod,
      benefitAnalysis: form.benefitAnalysis,
      items: rows,
    }),
    [form, rows],
  );

  const priceCtx = useMemo(
    () => ({
      projectName: project.name,
      projectCode: project.code,
      projectAbbr: project.nameAbbr,
      undertaker: project.undertaker,
      provinceCity: project.provinceCity,
      siteLocation: project.siteLocation,
      projectAddress: project.projectAddress,
      content,
    }),
    [project, content],
  );

  /** 模块内置文档 HTML（含 {{占位符}}，未替换；统一管线内完成模板优先与变量替换） */
  const rawDocHtml = useMemo(() => {
    if (!currentTask) return '';
    const title = `${project.nameAbbr || project.name || ''}-${content}-采购价格对比表`;
    return buildPriceCompareDocHtml(priceData, priceCtx, title);
  }, [priceData, priceCtx, currentTask, project, content]);

  /** 变量取值（统一预览 / 导出共用） */
  const varValues = useMemo(
    () => buildPriceCompareVariableValues(priceData, priceCtx),
    [priceData, priceCtx],
  );

  const exportFilename = `${
    project.nameAbbr || project.name || '项目'
  }-${content}-采购价格对比表.docx`;

  const handleExport = async () => {
    if (!currentTask) return;
    await exportProcurementWord({
      moduleType: MODULE_TYPE,
      taskId: taskId ?? undefined,
      docHtml: rawDocHtml,
      values: varValues,
      filename: exportFilename,
    });
    message.success(`已导出：${exportFilename}`);
  };

  /** 只读详情文档（模板优先 + 变量替换，需求修正 · 修改二） */
  const detailDoc = useModuleDetailDoc(
    !!currentTask,
    MODULE_TYPE,
    taskId ?? undefined,
    rawDocHtml,
    varValues,
  );

  /* ---------------- 表格列（18 列） ---------------- */

  const columns: ColumnsType<KeyedRow> = [
    { title: '序号', width: 56, fixed: 'left', render: (_v, _r, i) => i + 1 },
    {
      title: '采购名称',
      dataIndex: 'materialName',
      width: 160,
      fixed: 'left',
      render: (v: string | null | undefined) => v || '-',
    },
    { title: '规格型号', dataIndex: 'spec', width: 130, render: (v) => v || '-' },
    { title: '单位', dataIndex: 'unit', width: 70, render: (v) => v || '-' },
    {
      title: '数量',
      dataIndex: 'qty',
      width: 90,
      align: 'right',
      render: (v) => fmtQty(v) || '-',
    },
    {
      title: '清单收入\n不含税单价',
      dataIndex: 'incomePrice',
      width: 120,
      align: 'right',
      render: (v) => fmtAmount(v) || '-',
    },
    {
      title: '清单收入\n不含税合价',
      width: 130,
      align: 'right',
      render: (_v, r) => fmtAmount(deriveRow(r).incomeAmount) || '-',
    },
    {
      title: '标准成本\n不含税单价',
      dataIndex: 'stdCost',
      width: 120,
      align: 'right',
      render: (v) => fmtAmount(v) || '-',
    },
    {
      title: '标准成本\n不含税合价',
      width: 130,
      align: 'right',
      render: (_v, r) => fmtAmount(deriveRow(r).stdAmount) || '-',
    },
    {
      title: '控制价\n不含税单价',
      dataIndex: 'planPrice',
      width: 120,
      align: 'right',
      render: (v) => fmtAmount(v) || '-',
    },
    {
      title: '信息价\n不含税单价',
      dataIndex: 'infoPrice',
      width: 120,
      align: 'right',
      render: (v) => fmtAmount(v) || '-',
    },
    {
      title: '信息价\n不含税合价',
      width: 130,
      align: 'right',
      render: (_v, r) => fmtAmount(deriveRow(r).infoAmount) || '-',
    },
    {
      title: '成交价\n不含税单价',
      width: 140,
      align: 'right',
      render: (v: number | null | undefined, r) =>
        editable ? (
          <InputNumber
            size="small"
            style={{ width: '100%' }}
            min={0}
            precision={2}
            value={v ?? null}
            placeholder="录入成交价"
            onChange={(val) => patchRow(r.key, { dealPrice: val ?? null })}
          />
        ) : (
          fmtAmount(v) || '-'
        ),
    },
    {
      title: '成交价\n不含税合价',
      width: 130,
      align: 'right',
      render: (_v, r) => fmtAmount(deriveRow(r).dealAmount) || '-',
    },
    {
      title: '采购成本降低率',
      width: 130,
      align: 'right',
      render: (_v, r) => fmtRate(deriveRow(r).costReduceRate) || '-',
    },
    {
      title: '采购成交价下浮率',
      width: 140,
      align: 'right',
      render: (_v, r) => fmtRate(deriveRow(r).dealDiscountRate) || '-',
    },
    {
      title: '信息价下浮率',
      width: 120,
      align: 'right',
      render: (_v, r) => fmtRate(deriveRow(r).infoDiscountRate) || '-',
    },
    {
      title: '备注',
      width: 180,
      render: (v: string | null | undefined, r) =>
        editable ? (
          <Input
            size="small"
            value={v ?? ''}
            placeholder="请输入"
            onChange={(e) => patchRow(r.key, { remark: e.target.value })}
          />
        ) : (
          v || '-'
        ),
    },
  ];

  /* ---------------- 渲染 ---------------- */

  return (
    <Space direction="vertical" size={12} style={{ width: '100%' }}>
      <Card size="small">
        <Space wrap>
          <Select
            showSearch
            optionFilterProp="label"
            style={{ width: 460 }}
            placeholder="选择采购任务（仅显示成交报告已完成的任务）"
            loading={tasksLoading}
            value={taskId ?? undefined}
            onChange={selectTask}
            options={priceTasks.map((t) => ({
              value: t.id,
              label: `${t.taskNo} · ${t.content}`,
            }))}
            notFoundContent={
              tasksLoading
                ? '加载中…'
                : '暂无可编辑任务（需先完成成交报告，任务状态为「价格对比表编制中」）'
            }
          />
          {currentTask && (
            <>
              <Tag color="cyan">{taskTypeLabel(currentTask.type)}</Tag>
              <Tag color={detail?.published ? 'green' : 'orange'}>
                采购价格对比表：{detail?.statusLabel ?? '编辑中'}
              </Tag>
              <Tag>{taskStatusLabel(currentTask.status)}</Tag>
            </>
          )}
        </Space>
      </Card>

      {!currentTask && (
        <Card>
          <Empty description="请先在上方选择「成交报告已完成」的采购任务" />
        </Card>
      )}

      {/* 只读详情（需求修正 · 修改二）：默认展示，编辑在下方弹窗进行 */}
      {currentTask && (
        <ModuleDetailCard
          title="采购价格对比表 · 任务详情"
          taskNo={currentTask.taskNo}
          content={content}
          statusLabel={detail?.statusLabel ?? '编辑中'}
          publishedAt={detail?.data?.publishedAt ?? null}
          docHtml={detailDoc.html}
          docLoading={detailDoc.loading}
          actions={
            <>
              {detail && !detail.published && (
                <Button type="primary" onClick={() => setEditOpen(true)}>
                  编辑
                </Button>
              )}
              <Button icon={<EyeOutlined />} onClick={() => setModalMode('preview')}>
                预览
              </Button>
              <Button icon={<DownloadOutlined />} onClick={handleExport}>
                导出 Word
              </Button>
              {detail && !detail.published && (
                <Button type="primary" icon={<SendOutlined />} onClick={openPublishPreview}>
                  发布
                </Button>
              )}
              {detail?.published && (
                <Button
                  onClick={() => {
                    setReEditing(true);
                    setEditOpen(true);
                  }}
                >
                  重新编辑
                </Button>
              )}
            </>
          }
        />
      )}

      {/* 编辑弹窗（需求修正 · 修改二）：保存后关闭返回只读详情 */}
      <Drawer
        title={`采购价格对比表 · 编辑${currentTask ? ` · ${currentTask.taskNo}` : ''}`}
        width={1100}
        open={editOpen && !!currentTask}
        onClose={() => setEditOpen(false)}
        destroyOnClose
        footer={
          <Space style={{ float: 'right' }}>
            <Button onClick={() => setEditOpen(false)}>取消</Button>
            {editable && (
              <Button type="primary" icon={<SaveOutlined />} loading={saving} onClick={handleSave}>
                保存
              </Button>
            )}
          </Space>
        }
      >
        <Spin spinning={detailLoading}>
          {currentTask && (
            <Space direction="vertical" size={12} style={{ width: '100%' }}>
              {detail && !detail.reached && (
                <Alert
                  type="info"
                  showIcon
                  message="该采购任务尚未进入采购价格对比表阶段（需先完成成交报告）。"
                />
              )}
              {detail?.published && editable && (
                <Alert
                  type="warning"
                  showIcon
                  message="重新编辑模式：修改后请保存，发布状态保持「已完成」。"
                />
              )}

            {/* 展示信息 */}
            <Card size="small" title="展示信息">
              <Descriptions column={3} size="small" bordered>
                <Descriptions.Item label="项目名称及编码">
                  {[project.name, project.code ? `（${project.code}）` : ''].join('') || '-'}
                </Descriptions.Item>
                <Descriptions.Item label="采购内容">{content || '-'}</Descriptions.Item>
                <Descriptions.Item label="计价方式">
                  {pricingMethodLabel(form.pricingMethod) || '-'}
                </Descriptions.Item>
                <Descriptions.Item label="采购类型">
                  {taskTypeLabel(currentTask.type)}
                </Descriptions.Item>
                <Descriptions.Item label="任务状态">
                  {taskStatusLabel(currentTask.status)}
                </Descriptions.Item>
                <Descriptions.Item label="发布时间">
                  {detail?.data?.publishedAt
                    ? dayjs(detail.data.publishedAt).format('YYYY-MM-DD HH:mm')
                    : '-'}
                </Descriptions.Item>
              </Descriptions>
            </Card>

            {/* 一、项目基本情况 */}
            <Card size="small" title="一、项目基本情况">
              <Row gutter={[16, 16]}>
                <Col span={12}>
                  <div style={{ color: '#8c8c8c', fontSize: 12, marginBottom: 4 }}>
                    项目名称及编码
                  </div>
                  <div style={{ minHeight: 32, lineHeight: '32px' }}>
                    {project.name || '-'}
                    {project.code ? `（${project.code}）` : ''}
                  </div>
                </Col>
                <Col span={12}>
                  <div style={{ color: '#8c8c8c', fontSize: 12, marginBottom: 4 }}>计价方式</div>
                  {editable ? (
                    <Select
                      style={{ width: '100%' }}
                      placeholder="请选择计价方式"
                      value={form.pricingMethod || undefined}
                      options={PRICING_METHODS.map((m) => ({ value: m.value, label: m.label }))}
                      onChange={(v) => setForm((f) => ({ ...f, pricingMethod: v }))}
                    />
                  ) : (
                    <div style={{ minHeight: 32, lineHeight: '32px' }}>
                      {pricingMethodLabel(form.pricingMethod) || '-'}
                    </div>
                  )}
                </Col>
              </Row>
            </Card>

            {/* 二、采购效益分析说明 */}
            <Card size="small" title="二、采购效益分析说明">
              <RichTextEditor
                value={form.benefitAnalysis}
                onChange={(html) => setForm((f) => ({ ...f, benefitAnalysis: html }))}
                variableGroups={getProcurementVariableGroups(MODULE_TYPE)}
                disabled={!editable}
                minHeight={180}
                placeholder="请填写采购效益分析说明（可插入变量占位符）"
              />
            </Card>

            {/* 三、采购价格对比明细表 */}
            <Card
              size="small"
              title="三、采购价格对比明细表"
              extra={
                <span style={{ color: '#8c8c8c', fontSize: 12 }}>
                  采购名称/规格/单位/数量/清单收入/标准成本/控制价/信息价来自总采购清单（只读）；成交价与备注由人工录入
                </span>
              }
            >
              <Table<KeyedRow>
                size="small"
                rowKey="key"
                columns={columns}
                dataSource={rows}
                pagination={false}
                scroll={{ x: 2450 }}
                locale={{ emptyText: '暂无明细（请先编制并发布总采购清单）' }}
              />
              <Descriptions
                style={{ marginTop: 12 }}
                size="small"
                bordered
                column={4}
                title="表底汇总"
              >
                <Descriptions.Item label="清单收入不含税总金额">
                  {fmtAmount(summary.incomeAmount) || '0.00'} 元
                </Descriptions.Item>
                <Descriptions.Item label="标准成本不含税总金额">
                  {fmtAmount(summary.stdAmount) || '0.00'} 元
                </Descriptions.Item>
                <Descriptions.Item label="采购效益率">
                  {fmtRate(summary.benefitRate) || '-'}
                </Descriptions.Item>
                <Descriptions.Item label="采购成本降低率">
                  {fmtRate(summary.costReduceRate) || '-'}
                </Descriptions.Item>
              </Descriptions>
              <div style={{ color: '#8c8c8c', fontSize: 12, marginTop: 8 }}>
                计算规则：利润额 = 清单收入 − 成交价；采购效益率 = 利润额 ÷ 清单收入；
                采购成本降低率 =（标准成本 − 成交价）÷ 标准成本；信息价下浮率 =（信息价 − 成交价）÷ 信息价。
              </div>
            </Card>

          </Space>
          )}
        </Spin>
      </Drawer>

      {/* 统一预览 / 发布流程（批次四 · 任务 4.2）：发布前确认与发布后预览共用 */}
      <PreviewPublishModal
        open={modalMode !== null}
        mode={modalMode ?? 'preview'}
        moduleType={MODULE_TYPE}
        taskId={taskId ?? undefined}
        docHtml={rawDocHtml}
        values={varValues}
        publishing={publishing}
        filename={exportFilename}
        projectAbbr={project.nameAbbr}
        content={content}
        confirmTitle="确认发布采购价格对比表？"
        confirmDescription="发布前将自动保存当前内容；发布后状态变更为「已完成」，任务状态流转到下一阶段。"
        tipMessage="请核对明细表与表底汇总数据，确认无误后点击「确认发布」。"
        onPublish={handlePublish}
        onClose={() => setModalMode(null)}
      />
    </Space>
  );
}
