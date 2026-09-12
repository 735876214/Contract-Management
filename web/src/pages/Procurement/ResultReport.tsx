import { useCallback, useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import {
  Alert,
  Button,
  Card,
  Checkbox,
  Col,
  DatePicker,
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
import ImportButton from '@/components/ImportButton';
import PreviewPublishModal from '@/components/PreviewPublishModal';
import ModuleDetailCard, { useModuleDetailDoc } from '@/components/procurement/ModuleDetailCard';
import { exportProcurementWord } from '@/utils/procurementExport';
import {
  buildResultReportDocHtml,
  buildResultReportVariableValues,
  defaultFinalPrice,
  fmtAmount,
  rankByFirstRound,
  rankBySecondRound,
  type RankedSupplier,
  type ResultCandidate,
  type ResultReportData,
  type ResultSupplier,
} from '@/utils/procurementResultReport';

/** 模块类型（与采购模板 moduleType、变量占位符前缀一致） */
const MODULE_TYPE = 'RESULT_REPORT';

interface TaskRow {
  id: string;
  taskNo: string;
  type: string;
  content: string;
  status: string;
  stage: number;
  preMeetingRequired: boolean;
}

/** 成交报告 8 个编辑字段 */
interface ResultForm {
  unitCount: number | null;
  openTime: string | null;
  openPlace: string;
  reviewMembers: string;
  approvedCount: number | null;
  participantCount: number | null;
  abstainCount: number | null;
  validFileCount: number | null;
}

interface ResultDetail {
  task: TaskRow;
  stageIndex: number;
  documentStageIndex: number;
  /** 采购文件是否已完成（本模块入口条件） */
  documentCompleted: boolean;
  reached: boolean;
  editable: boolean;
  published: boolean;
  status: string;
  statusLabel: string;
  /** 采购内容 */
  content: string;
  /** 预计采购金额（元，来自总采购清单） */
  estimatedAmount: number | null;
  /** 响应单位明细（导入） */
  suppliers: ResultSupplier[];
  /** 拟推荐成交候选人（勾选） */
  candidates: ResultCandidate[];
  data:
    | {
        id?: string;
        unitCount?: number | null;
        openTime?: string | null;
        openPlace?: string;
        reviewMembers?: string;
        approvedCount?: number | null;
        participantCount?: number | null;
        abstainCount?: number | null;
        validFileCount?: number | null;
        publishedAt?: string | null;
      }
    | null;
}

const EMPTY_FORM: ResultForm = {
  unitCount: null,
  openTime: null,
  openPlace: '',
  reviewMembers: '',
  approvedCount: null,
  participantCount: null,
  abstainCount: null,
  validFileCount: null,
};

export default function ResultReport() {
  const [searchParams, setSearchParams] = useSearchParams();
  const currentProjectId = useAuthStore((s) => s.currentProjectId);

  const [tasks, setTasks] = useState<TaskRow[]>([]);
  const [tasksLoading, setTasksLoading] = useState(true);
  const [taskId, setTaskId] = useState<string | null>(searchParams.get('taskId') || null);

  const [detail, setDetail] = useState<ResultDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);

  const [form, setForm] = useState<ResultForm>(EMPTY_FORM);
  const [suppliers, setSuppliers] = useState<ResultSupplier[]>([]);
  const [candidates, setCandidates] = useState<ResultCandidate[]>([]);

  const [saving, setSaving] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const [reEditing, setReEditing] = useState(false);
  /** 统一预览/发布弹窗（批次四 · 任务 4.2）：publish=发布前确认；preview=纯预览 */
  const [modalMode, setModalMode] = useState<'preview' | 'publish' | null>(null);
  /** 编辑弹窗（需求修正 · 修改二）：主视图只读详情，编辑在弹窗中进行 */
  const [editOpen, setEditOpen] = useState(false);

  const [project, setProject] = useState<{
    name?: string;
    nameAbbr?: string;
    undertaker?: string;
    provinceCity?: string;
    siteLocation?: string;
    projectAddress?: string;
  }>({});

  const currentTask = detail?.task ?? null;
  const editable = !!detail && (detail.editable || (detail.published && reEditing));
  const content = detail?.content || currentTask?.content || '';

  /** 仅「采购文件已完成」（成交报告编制中）的任务可进入编辑 */
  const reportTasks = useMemo(() => tasks.filter((t) => t.status === 'RESULT_EDITING'), [tasks]);

  /** 开启报价情况表（第一轮报价不含税总额升序） */
  const firstRoundRows = useMemo(() => rankByFirstRound(suppliers), [suppliers]);
  /** 第二轮报价情况表（仅「通过第一轮报价=是」，第二轮报价不含税总额升序） */
  const secondRoundRows = useMemo(() => rankBySecondRound(suppliers), [suppliers]);

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
      .resultReport(id)
      .then((res: any) => {
        const d: ResultDetail = res?.data ?? res;
        setDetail(d);
        const data = (d?.data ?? {}) as NonNullable<ResultDetail['data']>;
        setForm({
          unitCount: data.unitCount ?? null,
          openTime: data.openTime ? dayjs(data.openTime).format('YYYY-MM-DD') : null,
          openPlace: data.openPlace ?? '',
          reviewMembers: data.reviewMembers ?? '',
          approvedCount: data.approvedCount ?? null,
          participantCount: data.participantCount ?? null,
          abstainCount: data.abstainCount ?? null,
          validFileCount: data.validFileCount ?? null,
        });
        setSuppliers(Array.isArray(d?.suppliers) ? d.suppliers : []);
        setCandidates(Array.isArray(d?.candidates) ? d.candidates : []);
        setReEditing(false);
      })
      .catch(() => {
        setDetail(null);
        setForm(EMPTY_FORM);
        setSuppliers([]);
        setCandidates([]);
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

  const patchForm = (patch: Partial<ResultForm>) => setForm((f) => ({ ...f, ...patch }));

  /* ---------------- 候选人勾选（第二轮报价表） ---------------- */

  const isChecked = (index: number) => candidates.some((c) => c.supplierIndex === index);

  const toggleCandidate = (row: RankedSupplier, checked: boolean) => {
    setCandidates((list) => {
      if (checked) {
        if (list.some((c) => c.supplierIndex === row.index)) return list;
        return [
          ...list,
          {
            supplierIndex: row.index,
            name: String(row.supplier.name ?? ''),
            // 最终确认不含税价格默认取第二轮报价（未通过第一轮时回退第一轮）
            finalPreTaxPrice: defaultFinalPrice(row.supplier),
            remark: String(row.supplier.remark ?? ''),
          },
        ];
      }
      return list.filter((c) => c.supplierIndex !== row.index);
    });
  };

  const patchCandidate = (index: number, patch: Partial<ResultCandidate>) =>
    setCandidates((list) => list.map((c, i) => (i === index ? { ...c, ...patch } : c)));

  /* ---------------- 保存 / 发布 / 导出 ---------------- */

  const buildSavePayload = () => ({
    unitCount: form.unitCount,
    openTime: form.openTime || null,
    openPlace: form.openPlace,
    reviewMembers: form.reviewMembers,
    approvedCount: form.approvedCount,
    participantCount: form.participantCount,
    abstainCount: form.abstainCount,
    validFileCount: form.validFileCount,
    candidates,
  });

  const handleSave = async () => {
    if (!taskId) return;
    setSaving(true);
    try {
      await procurementTaskApi.saveResultReport(taskId, buildSavePayload());
      message.success('已保存');
      setEditOpen(false);
      loadDetail(taskId);
    } finally {
      setSaving(false);
    }
  };

  const openPublishPreview = () => {
    if (!form.openTime) {
      message.warning('请先选择「采购开启时间」再发布');
      return;
    }
    if (!suppliers.length) {
      message.warning('请先导入「响应单位情况汇总表」再发布');
      return;
    }
    setModalMode('publish');
  };

  const handlePublish = async () => {
    if (!taskId) return;
    setPublishing(true);
    try {
      await procurementTaskApi.saveResultReport(taskId, buildSavePayload());
      await procurementTaskApi.publish(taskId);
      message.success('已发布，成交报告状态变更为「已完成」');
      setModalMode(null);
      loadDetail(taskId);
    } finally {
      setPublishing(false);
    }
  };

  const reportData = useMemo<ResultReportData>(
    () => ({
      unitCount: form.unitCount,
      openTime: form.openTime,
      openPlace: form.openPlace,
      reviewMembers: form.reviewMembers,
      approvedCount: form.approvedCount,
      participantCount: form.participantCount,
      abstainCount: form.abstainCount,
      validFileCount: form.validFileCount,
      suppliers,
      candidates,
    }),
    [form, suppliers, candidates],
  );

  const reportCtx = useMemo(
    () => ({
      projectName: project.name,
      projectAbbr: project.nameAbbr,
      undertaker: project.undertaker,
      provinceCity: project.provinceCity,
      siteLocation: project.siteLocation,
      projectAddress: project.projectAddress,
      content,
      estimatedAmount: detail?.estimatedAmount ?? null,
    }),
    [project, content, detail],
  );

  /** 模块内置文档 HTML（含 {{占位符}}，未替换；统一管线内完成模板优先与变量替换） */
  const rawDocHtml = useMemo(() => {
    if (!currentTask) return '';
    const title = `${project.nameAbbr || project.name || ''}-${content}-成交报告`;
    return buildResultReportDocHtml(reportData, reportCtx, title);
  }, [reportData, reportCtx, currentTask, project, content]);

  /** 变量取值（统一预览 / 导出共用） */
  const varValues = useMemo(
    () => buildResultReportVariableValues(reportData, reportCtx),
    [reportData, reportCtx],
  );

  const exportFilename = `${project.nameAbbr || project.name || '项目'}-${content}-成交报告.docx`;

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

  /* ---------------- 表格列 ---------------- */

  const estAmount = fmtAmount(detail?.estimatedAmount) || '-';

  const summaryColumns: ColumnsType<ResultSupplier> = [
    { title: '序号', width: 60, render: (_v, _r, i) => i + 1 },
    { title: '参与响应单位', dataIndex: 'name', render: (v: string | null) => v || '-' },
    { title: '响应保证金是否缴纳', dataIndex: 'depositPaid', width: 160, render: (v: string | null) => v || '-' },
    { title: '响应文件密封是否完整', dataIndex: 'sealed', width: 180, render: (v: string | null) => v || '-' },
    { title: '备注', dataIndex: 'remark', width: 160, render: (v: string | null) => v || '-' },
  ];

  const firstRoundColumns: ColumnsType<RankedSupplier> = [
    { title: '排名', dataIndex: 'rank', width: 70, render: (v: number) => <Tag color="blue">{v}</Tag> },
    { title: '参与响应单位', width: 220, render: (_v, r) => r.supplier.name || '-' },
    {
      title: '第一次报价不含税总额',
      width: 190,
      align: 'right',
      render: (_v, r) => fmtAmount(r.supplier.firstPreTaxTotal) || '-',
    },
    { title: '预计采购金额', width: 150, align: 'right', render: () => estAmount },
    {
      title: '第一轮报价税金',
      width: 140,
      align: 'right',
      render: (_v, r) => fmtAmount(r.supplier.firstTax) || '-',
    },
  ];

  const secondRoundColumns: ColumnsType<RankedSupplier> = [
    {
      title: '拟推荐',
      width: 80,
      align: 'center',
      render: (_v, r) => (
        <Tooltip title="勾选后自动填入「拟推荐成交候选人表」">
          <Checkbox
            disabled={!editable}
            checked={isChecked(r.index)}
            onChange={(e) => toggleCandidate(r, e.target.checked)}
          />
        </Tooltip>
      ),
    },
    { title: '排名', dataIndex: 'rank', width: 70, render: (v: number) => <Tag color="blue">{v}</Tag> },
    { title: '参与响应单位', width: 220, render: (_v, r) => r.supplier.name || '-' },
    {
      title: '第二次报价不含税总额',
      width: 190,
      align: 'right',
      render: (_v, r) => fmtAmount(r.supplier.secondPreTaxTotal) || '-',
    },
    { title: '预计采购金额', width: 150, align: 'right', render: () => estAmount },
    {
      title: '第二轮报价税金',
      width: 140,
      align: 'right',
      render: (_v, r) => fmtAmount(r.supplier.secondTax) || '-',
    },
  ];

  const candidateColumns: ColumnsType<ResultCandidate> = [
    { title: '序号', width: 60, render: (_v, _r, i) => i + 1 },
    { title: '拟推荐成交候选人', dataIndex: 'name', render: (v: string) => v || '-' },
    {
      title: '最终确认不含税价格',
      width: 220,
      render: (v: number | null | undefined, _r, i) =>
        editable ? (
          <InputNumber
            style={{ width: '100%' }}
            min={0}
            precision={2}
            value={v ?? null}
            placeholder="请输入"
            onChange={(val) => patchCandidate(i, { finalPreTaxPrice: val ?? null })}
          />
        ) : (
          fmtAmount(v) || '-'
        ),
    },
    {
      title: '备注',
      width: 220,
      render: (v: string | null | undefined, _r, i) =>
        editable ? (
          <Input
            value={v ?? ''}
            placeholder="请输入"
            onChange={(e) => patchCandidate(i, { remark: e.target.value })}
          />
        ) : (
          v || '-'
        ),
    },
    {
      title: '操作',
      width: 90,
      render: (_v, r) => (
        <Button
          type="link"
          size="small"
          danger
          disabled={!editable}
          onClick={() =>
            setCandidates((list) => list.filter((c) => c.supplierIndex !== r.supplierIndex))
          }
        >
          移除
        </Button>
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
            placeholder="选择采购任务（仅显示采购文件已完成的任务）"
            loading={tasksLoading}
            value={taskId ?? undefined}
            onChange={selectTask}
            options={reportTasks.map((t) => ({
              value: t.id,
              label: `${t.taskNo} · ${t.content}`,
            }))}
            notFoundContent={
              tasksLoading
                ? '加载中…'
                : '暂无可编辑任务（需先完成采购文件，任务状态为「成交报告编制中」）'
            }
          />
          {currentTask && (
            <>
              <Tag color="cyan">{taskTypeLabel(currentTask.type)}</Tag>
              <Tag color={detail?.published ? 'green' : 'orange'}>
                成交报告：{detail?.statusLabel ?? '编辑中'}
              </Tag>
              <Tag>{taskStatusLabel(currentTask.status)}</Tag>
            </>
          )}
        </Space>
      </Card>

      {!currentTask && (
        <Card>
          <Empty description="请先在上方选择「采购文件已完成」的采购任务" />
        </Card>
      )}

      {/* 只读详情（需求修正 · 修改二）：默认展示，编辑在下方弹窗进行 */}
      {currentTask && (
        <ModuleDetailCard
          title="成交报告 · 任务详情"
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
        title={`成交报告 · 编辑${currentTask ? ` · ${currentTask.taskNo}` : ''}`}
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
                  message="该采购任务尚未进入成交报告阶段（需先完成采购文件）。"
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
                <Descriptions.Item label="采购内容">{content || '-'}</Descriptions.Item>
                <Descriptions.Item label="预计采购金额">
                  {detail?.estimatedAmount == null ? '-' : `${estAmount} 元`}
                </Descriptions.Item>
                <Descriptions.Item label="采购开启时间">{form.openTime || '-'}</Descriptions.Item>
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

            {/* 一、成交报告基本信息 */}
            <Card size="small" title="一、成交报告基本信息">
              <Row gutter={[16, 16]}>
                <Col span={6}>
                  <div style={{ color: '#8c8c8c', fontSize: 12, marginBottom: 4 }}>成交单位数量</div>
                  {editable ? (
                    <InputNumber
                      style={{ width: '100%' }}
                      min={0}
                      precision={0}
                      value={form.unitCount}
                      placeholder="请输入"
                      onChange={(v) => patchForm({ unitCount: v ?? null })}
                    />
                  ) : (
                    <div style={{ minHeight: 22 }}>{form.unitCount ?? '-'}</div>
                  )}
                </Col>
                <Col span={6}>
                  <div style={{ color: '#8c8c8c', fontSize: 12, marginBottom: 4 }}>采购开启时间</div>
                  {editable ? (
                    <DatePicker
                      style={{ width: '100%' }}
                      value={form.openTime ? dayjs(form.openTime) : null}
                      onChange={(d) => patchForm({ openTime: d ? d.format('YYYY-MM-DD') : null })}
                    />
                  ) : (
                    <div style={{ minHeight: 22 }}>{form.openTime || '-'}</div>
                  )}
                </Col>
                <Col span={6}>
                  <div style={{ color: '#8c8c8c', fontSize: 12, marginBottom: 4 }}>开启地点</div>
                  {editable ? (
                    <Input
                      value={form.openPlace}
                      placeholder="请输入"
                      onChange={(e) => patchForm({ openPlace: e.target.value })}
                    />
                  ) : (
                    <div style={{ minHeight: 22 }}>{form.openPlace || '-'}</div>
                  )}
                </Col>
                <Col span={6}>
                  <div style={{ color: '#8c8c8c', fontSize: 12, marginBottom: 4 }}>评审小组成员</div>
                  {editable ? (
                    <Input
                      value={form.reviewMembers}
                      placeholder="请输入"
                      onChange={(e) => patchForm({ reviewMembers: e.target.value })}
                    />
                  ) : (
                    <div style={{ minHeight: 22 }}>{form.reviewMembers || '-'}</div>
                  )}
                </Col>
                <Col span={6}>
                  <div style={{ color: '#8c8c8c', fontSize: 12, marginBottom: 4 }}>
                    审核通过响应单位数量
                  </div>
                  {editable ? (
                    <InputNumber
                      style={{ width: '100%' }}
                      min={0}
                      precision={0}
                      value={form.approvedCount}
                      placeholder="请输入"
                      onChange={(v) => patchForm({ approvedCount: v ?? null })}
                    />
                  ) : (
                    <div style={{ minHeight: 22 }}>{form.approvedCount ?? '-'}</div>
                  )}
                </Col>
                <Col span={6}>
                  <div style={{ color: '#8c8c8c', fontSize: 12, marginBottom: 4 }}>
                    参与响应单位数量
                  </div>
                  {editable ? (
                    <InputNumber
                      style={{ width: '100%' }}
                      min={0}
                      precision={0}
                      value={form.participantCount}
                      placeholder="请输入"
                      onChange={(v) => patchForm({ participantCount: v ?? null })}
                    />
                  ) : (
                    <div style={{ minHeight: 22 }}>{form.participantCount ?? '-'}</div>
                  )}
                </Col>
                <Col span={6}>
                  <div style={{ color: '#8c8c8c', fontSize: 12, marginBottom: 4 }}>
                    弃权响应单位数量
                  </div>
                  {editable ? (
                    <InputNumber
                      style={{ width: '100%' }}
                      min={0}
                      precision={0}
                      value={form.abstainCount}
                      placeholder="请输入"
                      onChange={(v) => patchForm({ abstainCount: v ?? null })}
                    />
                  ) : (
                    <div style={{ minHeight: 22 }}>{form.abstainCount ?? '-'}</div>
                  )}
                </Col>
                <Col span={6}>
                  <div style={{ color: '#8c8c8c', fontSize: 12, marginBottom: 4 }}>
                    有效响应文件数量
                  </div>
                  {editable ? (
                    <InputNumber
                      style={{ width: '100%' }}
                      min={0}
                      precision={0}
                      value={form.validFileCount}
                      placeholder="请输入"
                      onChange={(v) => patchForm({ validFileCount: v ?? null })}
                    />
                  ) : (
                    <div style={{ minHeight: 22 }}>{form.validFileCount ?? '-'}</div>
                  )}
                </Col>
              </Row>
            </Card>

            {/* 二、导入响应单位情况汇总表 */}
            <Card
              size="small"
              title="二、响应单位情况汇总表（导入）"
              extra={
                <span style={{ color: '#8c8c8c', fontSize: 12 }}>
                  导入后自动生成下方四张表；重复导入将覆盖已有明细
                </span>
              }
            >
              <Space wrap>
                <ImportButton
                  moduleName="响应单位情况汇总表"
                  templateUrl={
                    taskId ? () => procurementTaskApi.resultReportTemplateUrl(taskId) : undefined
                  }
                  onUpload={(file) => procurementTaskApi.importResultReport(taskId!, file)}
                  onDone={() => taskId && loadDetail(taskId)}
                  disabled={!editable}
                  extraHint="导入将覆盖已有的响应单位明细。"
                />
                <span style={{ color: '#8c8c8c', fontSize: 12 }}>
                  已导入 {suppliers.length} 家响应单位
                </span>
              </Space>
              <Table
                style={{ marginTop: 12 }}
                size="small"
                rowKey={(_r, i) => String(i)}
                columns={summaryColumns}
                dataSource={suppliers}
                pagination={false}
                scroll={{ x: 900 }}
                locale={{ emptyText: '暂无数据，请点击上方「导入」上传响应单位情况汇总表' }}
              />
            </Card>

            {/* 三、开启报价情况表 */}
            <Card
              size="small"
              title="三、开启报价情况表"
              extra={
                <span style={{ color: '#8c8c8c', fontSize: 12 }}>
                  排序规则：按第一轮报价不含税总额由小到大
                </span>
              }
            >
              <Table
                size="small"
                rowKey={(r) => `first-${r.index}`}
                columns={firstRoundColumns}
                dataSource={firstRoundRows}
                pagination={false}
                scroll={{ x: 900 }}
                locale={{ emptyText: '暂无数据' }}
              />
            </Card>

            {/* 四、第二轮报价情况表（勾选生成候选人） */}
            <Card
              size="small"
              title="四、第二轮报价情况表"
              extra={
                <span style={{ color: '#8c8c8c', fontSize: 12 }}>
                  仅「通过第一轮报价=是」的单位；按第二轮报价不含税总额由小到大；勾选后生成候选人表
                </span>
              }
            >
              <Table
                size="small"
                rowKey={(r) => `second-${r.index}`}
                columns={secondRoundColumns}
                dataSource={secondRoundRows}
                pagination={false}
                scroll={{ x: 950 }}
                locale={{ emptyText: '暂无通过第一轮报价的单位' }}
              />
            </Card>

            {/* 五、拟推荐成交候选人表 */}
            <Card
              size="small"
              title="五、拟推荐成交候选人表"
              extra={
                <span style={{ color: '#8c8c8c', fontSize: 12 }}>
                  在第二轮报价情况表中勾选后自动填入
                </span>
              }
            >
              <Table
                size="small"
                rowKey={(r) => `cand-${r.supplierIndex ?? r.name}`}
                columns={candidateColumns}
                dataSource={candidates}
                pagination={false}
                scroll={{ x: 800 }}
                locale={{ emptyText: '暂无数据，请在第二轮报价情况表中勾选' }}
              />
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
        confirmTitle="确认发布成交报告？"
        confirmDescription="发布前将自动保存当前内容；发布后状态变更为「已完成」，任务状态流转到下一阶段。"
        tipMessage="请核对成交报告内容与四张表，确认无误后点击「确认发布」。"
        onPublish={handlePublish}
        onClose={() => setModalMode(null)}
      />
    </Space>
  );
}
