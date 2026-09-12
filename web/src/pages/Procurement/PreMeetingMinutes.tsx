import { useCallback, useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import {
  Alert,
  Button,
  Card,
  Col,
  DatePicker,
  Descriptions,
  Drawer,
  Input,
  InputNumber,
  Modal,
  Popconfirm,
  Row,
  Space,
  Spin,
  Table,
  Upload,
  message,
} from 'antd';
import type { ColumnsType } from 'antd/es/table';
import type { UploadFile } from 'antd/es/upload/interface';
import {
  DeleteOutlined,
  DownloadOutlined,
  EyeOutlined,
  ImportOutlined,
  PlusOutlined,
  SaveOutlined,
  SendOutlined,
} from '@ant-design/icons';
import dayjs from 'dayjs';
import http from '@/api/http';
import { procurementTaskApi } from '@/api/modules';
import { projectApi } from '@/api/business';
import { useAuthStore } from '@/store/auth';
import {
  getProcurementVariableGroups,
} from '@/constants/procurementVariables';
import RichTextEditor from '@/components/RichTextEditor';
import PreviewPublishModal from '@/components/PreviewPublishModal';
import ModuleDetailCard, { useModuleDetailDoc } from '@/components/procurement/ModuleDetailCard';
import ModuleListPage, {
  type ModuleListFilterField,
  type ModuleListRow,
  useModuleDelete,
} from '@/components/procurement/ModuleListPage';
import { exportProcurementWord } from '@/utils/procurementExport';
import {
  buildPreMeetingDocHtml,
  buildPreMeetingVariableValues,
  costRowsFromTotalList,
  deriveCostRow,
  fmtRate,
  fmtWan,
  summarizeCost,
  type CostAnalysisRow,
  type PreMeetingData,
  type PurchaseItemRow,
} from '@/utils/preMeetingMinutes';

/** 模块类型（与采购模板 moduleType、变量占位符前缀一致） */
const MODULE_TYPE = 'PRE_MEETING';

/** 采购任务行（列表精简） */
interface TaskRow {
  id: string;
  taskNo: string;
  type: string;
  content: string;
  status: string;
  stage: number;
  preMeetingRequired: boolean;
  estimatedAmountWan?: number;
}

/** 可编辑行：带前端 key 供 Table 渲染（保存时剔除） */
type Keyed<T> = T & { key: string };

interface MinutesForm {
  meetingTime: string | null;
  content: string;
  host: string;
  attendees: string;
  writer: string;
  reviewer: string;
  purchaseItems: Keyed<PurchaseItemRow>[];
  techQuality: string;
  acceptance: string;
  paymentTerms: string;
  costRows: Keyed<CostAnalysisRow>[];
}

interface MinutesDetail {
  task: TaskRow;
  /** 是否生成采前会会议纪要模块（单项采购且预计采购金额 ≥ 100 万） */
  generated: boolean;
  thresholdWan: number;
  estimatedAmountWan: number;
  editable: boolean;
  published: boolean;
  status: string;
  statusLabel: string;
  data:
    | (Omit<MinutesForm, 'purchaseItems' | 'costRows'> & {
        id?: string;
        purchaseItems?: PurchaseItemRow[];
        costRows?: CostAnalysisRow[];
        inquirySheets?: { fileName?: string; url?: string; size?: number | null }[];
        publishedAt?: string | null;
      })
    | null;
}

let rowSeq = 0;
const nextKey = (): string => {
  rowSeq += 1;
  return `row-${Date.now()}-${rowSeq}`;
};
const withKeys = <T,>(rows: T[] = []): Keyed<T>[] => rows.map((r) => ({ ...r, key: nextKey() }));
const stripKey = <T,>(row: Keyed<T>): T => {
  const { key: _key, ...rest } = row;
  return rest as unknown as T;
};

const EMPTY_FORM: MinutesForm = {
  meetingTime: null,
  content: '',
  host: '',
  attendees: '',
  writer: '',
  reviewer: '',
  purchaseItems: [],
  techQuality: '',
  acceptance: '',
  paymentTerms: '',
  costRows: [],
};

/** 带标签的表单块（只读时降级为文本） */
function Field({
  label,
  value,
  editable,
  onChange,
  placeholder,
}: {
  label: string;
  value: string;
  editable: boolean;
  onChange: (v: string) => void;
  placeholder?: string;
}) {
  return (
    <div>
      <div style={{ color: '#8c8c8c', fontSize: 12, marginBottom: 4 }}>{label}</div>
      {editable ? (
        <Input value={value} placeholder={placeholder ?? `请填写${label}`} onChange={(e) => onChange(e.target.value)} />
      ) : (
        <div style={{ minHeight: 22 }}>{value || '-'}</div>
      )}
    </div>
  );
}

export default function PreMeetingMinutes() {
  const [searchParams, setSearchParams] = useSearchParams();
  const currentProjectId = useAuthStore((s) => s.currentProjectId);

  const [taskId, setTaskId] = useState<string | null>(searchParams.get('taskId') || null);
  /** 列表化（批次五）：详情抽屉开关；带 taskId 进入页面时直接打开 */
  const [detailOpen, setDetailOpen] = useState(!!searchParams.get('taskId'));
  /** 列表刷新键：详情抽屉关闭后重查，反映最新模块状态 */
  const [listRefresh, setListRefresh] = useState(0);
  /** 问题二：删除模块记录并回退流程 */
  const handleDeleteModule = useModuleDelete('PRE_MEETING', () => setListRefresh((k) => k + 1));

  const [detail, setDetail] = useState<MinutesDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);

  const [form, setForm] = useState<MinutesForm>(EMPTY_FORM);
  const [fileList, setFileList] = useState<UploadFile[]>([]);
  const [saving, setSaving] = useState(false);
  const [publishing, setPublishing] = useState(false);
  /** 发布后默认预览（只读）；点「重新编辑」解锁 */
  const [reEditing, setReEditing] = useState(false);
  /** 统一预览/发布弹窗（批次四 · 任务 4.2）：publish=发布前确认；preview=纯预览 */
  const [modalMode, setModalMode] = useState<'preview' | 'publish' | null>(null);
  /** 编辑弹窗（需求修正 · 修改二）：主视图只读详情，编辑在弹窗中进行 */
  const [editOpen, setEditOpen] = useState(false);
  const [imgPreview, setImgPreview] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);

  const [project, setProject] = useState<{
    name?: string;
    nameAbbr?: string;
    undertaker?: string;
    provinceCity?: string;
    siteLocation?: string;
    projectAddress?: string;
  }>({});

  const currentTask = detail?.task ?? null;
  /** 当前是否可编辑：编辑中阶段，或已发布后主动点「重新编辑」 */
  const editable = !!detail && (detail.editable || (detail.published && reEditing));

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
      .preMeetingMinutes(id)
      .then((res: any) => {
        const d: MinutesDetail = res?.data ?? res;
        setDetail(d);
        const data = (d?.data ?? {}) as NonNullable<MinutesDetail['data']>;
        setForm({
          meetingTime: data.meetingTime ? dayjs(data.meetingTime).format('YYYY-MM-DD') : null,
          // 采购内容默认带出采购任务内容
          content: data.content || String(d?.task?.content ?? ''),
          host: data.host ?? '',
          attendees: data.attendees ?? '',
          writer: data.writer ?? '',
          reviewer: data.reviewer ?? '',
          purchaseItems: withKeys(data.purchaseItems ?? []),
          techQuality: data.techQuality ?? '',
          acceptance: data.acceptance ?? '',
          paymentTerms: data.paymentTerms ?? '',
          costRows: withKeys(data.costRows ?? []),
        });
        setFileList(
          (data.inquirySheets ?? []).map((f, i) => ({
            uid: f.url || `sheet-${i}`,
            name: f.fileName || `询价单${i + 1}`,
            status: 'done' as const,
            url: f.url,
            response: f,
          })),
        );
        setReEditing(false);
        // 首次进入（尚未保存过）时，采购清单与成本分析表自动从总采购清单带出
        const empty = (data.purchaseItems ?? []).length === 0 && (data.costRows ?? []).length === 0;
        if (empty && d?.editable) void importFromTotalList(id, { silent: true });
      })
      .catch(() => {
        setDetail(null);
        setForm(EMPTY_FORM);
        setFileList([]);
      })
      .finally(() => setDetailLoading(false));
    // importFromTotalList 为稳定引用（依赖 setState），此处不纳入依赖
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (taskId) loadDetail(taskId);
  }, [taskId, loadDetail]);

  /** 列表行操作：查看（进入只读详情抽屉） */
  const openRow = (row: ModuleListRow) => {
    setTaskId(row.id);
    setSearchParams({ taskId: row.id }, { replace: true });
    setDetailOpen(true);
  };
  /** 列表行操作：编辑（打开详情抽屉并叠加编辑弹窗） */
  const editRow = (row: ModuleListRow) => {
    setTaskId(row.id);
    setSearchParams({ taskId: row.id }, { replace: true });
    setDetailOpen(true);
    setEditOpen(true);
  };
  /** 关闭详情抽屉后刷新列表（反映保存/发布后的最新模块状态） */
  const closeDetail = () => {
    setDetailOpen(false);
    setListRefresh((x) => x + 1);
  };

  const patchForm = (patch: Partial<MinutesForm>) => setForm((f) => ({ ...f, ...patch }));

  const updateRow = (
    field: 'purchaseItems' | 'costRows',
    key: string,
    patch: Record<string, unknown>,
  ) => {
    setForm((f) => ({
      ...f,
      [field]: (f[field] as Keyed<unknown>[]).map((r) => (r.key === key ? { ...r, ...patch } : r)),
    }));
  };
  const removeRow = (field: 'purchaseItems' | 'costRows', key: string) => {
    setForm((f) => ({
      ...f,
      [field]: (f[field] as Keyed<unknown>[]).filter((r) => r.key !== key),
    }));
  };

  /** 询价单：Upload fileList 中的成功响应即图片元数据 */
  const sheetsFromList = (list: UploadFile[]) =>
    list
      .map((f) => f.response as { fileName?: string; url?: string; size?: number | null } | undefined)
      .filter((f): f is { fileName?: string; url?: string; size?: number | null } => !!f?.url);

  /** 从「总采购清单」导入采购清单 / 成本分析表初始值 */
  const importFromTotalList = useCallback(
    async (id: string, opts: { silent?: boolean } = {}) => {
      setImporting(true);
      try {
        const res: any = await procurementTaskApi.totalList(id);
        const items: any[] = res?.data?.items ?? res?.items ?? [];
        if (!items.length) {
          if (!opts.silent) {
            message.warning('总采购清单暂无明细，请先在「采购发起 → 总采购清单」中编制并发布');
          }
          return;
        }
        setForm((f) => ({
          ...f,
          purchaseItems: withKeys(
            items.map((i) => ({
              materialName: i.materialName ?? '',
              spec: i.spec ?? '',
              unit: i.unit ?? '',
              qty: i.qty ?? null,
            })),
          ),
          costRows: withKeys(costRowsFromTotalList(items)),
        }));
        if (!opts.silent) message.success(`已从总采购清单导入 ${items.length} 条明细（收入/成本按万元换算）`);
      } catch {
        if (!opts.silent) message.error('导入总采购清单失败');
      } finally {
        setImporting(false);
      }
    },
    [],
  );

  const buildSavePayload = () => ({
    meetingTime: form.meetingTime || null,
    content: form.content,
    host: form.host,
    attendees: form.attendees,
    writer: form.writer,
    reviewer: form.reviewer,
    purchaseItems: form.purchaseItems.map(stripKey),
    techQuality: form.techQuality,
    acceptance: form.acceptance,
    paymentTerms: form.paymentTerms,
    costRows: form.costRows.map(stripKey),
    inquirySheets: sheetsFromList(fileList),
  });

  const handleSave = async () => {
    if (!taskId) return;
    setSaving(true);
    try {
      await procurementTaskApi.savePreMeetingMinutes(taskId, buildSavePayload());
      message.success('已保存');
      setEditOpen(false);
      loadDetail(taskId);
    } finally {
      setSaving(false);
    }
  };

  /** 发布流程第 1 步：校验必填 → 打开「发布前预览」（统一预览发布流程） */
  const openPublishPreview = () => {
    if (!taskId) return;
    if (!form.meetingTime || !String(form.content ?? '').trim()) {
      message.warning('请先填写「会议时间」与「采购内容」再发布');
      return;
    }
    setModalMode('publish');
  };

  /** 发布流程第 2 步：确认发布（先落库当前编辑内容） */
  const handlePublish = async () => {
    if (!taskId) return;
    setPublishing(true);
    try {
      await procurementTaskApi.savePreMeetingMinutes(taskId, buildSavePayload());
      await procurementTaskApi.publish(taskId);
      message.success('已发布，采前会会议纪要状态变更为「已完成」');
      setModalMode(null);
      loadDetail(taskId);
    } finally {
      setPublishing(false);
    }
  };

  /** 文档数据（Dayjs → Date；剔除表格 key） */
  const docData = useMemo<PreMeetingData>(
    () => ({
      ...form,
      meetingTime: form.meetingTime,
      purchaseItems: form.purchaseItems.map(stripKey),
      costRows: form.costRows.map(stripKey),
    }),
    [form],
  );

  const docCtx = useMemo(
    () => ({
      projectName: project.name,
      projectAbbr: project.nameAbbr,
      undertaker: project.undertaker,
      provinceCity: project.provinceCity,
      siteLocation: project.siteLocation,
      projectAddress: project.projectAddress,
      content: currentTask?.content,
      estimatedAmountWan: detail?.estimatedAmountWan ?? null,
    }),
    [project, currentTask, detail],
  );

  /** 模块内置文档 HTML（含 {{占位符}}，未替换；统一管线内完成模板优先与变量替换） */
  const rawDocHtml = useMemo(() => {
    if (!currentTask) return '';
    const content = docData.content || currentTask.content;
    const title = `${project.nameAbbr || project.name || ''}-${content}-采前会会议纪要`;
    // {{采前会-采购清单}} / {{采前会-采购成本分析表}} / {{会议时间}} / {{主持人}} / {{参会人员}} 等
    return buildPreMeetingDocHtml(docData, docCtx, title);
  }, [docData, docCtx, currentTask, project]);

  /** 变量取值（统一预览 / 导出共用） */
  const varValues = useMemo(
    () => buildPreMeetingVariableValues(docData, docCtx),
    [docData, docCtx],
  );

  const exportFilename = `${
    project.nameAbbr || project.name || '项目'
  }-${form.content || currentTask?.content || '采购'}-采前会会议纪要.docx`;

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

  const textCell = (value: string | null | undefined, onChange: (v: string) => void) =>
    editable ? (
      <Input size="small" value={value ?? undefined} onChange={(e) => onChange(e.target.value)} />
    ) : (
      value ?? '-'
    );

  const numberCell = (
    value: number | null | undefined,
    onChange: (v: number | null) => void,
    opts: { precision?: number; suffix?: string; min?: number } = {},
  ) => (
    <InputNumber
      size="small"
      style={{ width: '100%' }}
      min={opts.min ?? 0}
      precision={opts.precision ?? 2}
      addonAfter={opts.suffix}
      value={value ?? undefined}
      disabled={!editable}
      onChange={(v) => onChange(typeof v === 'number' ? v : null)}
    />
  );

  const opColumn = (field: 'purchaseItems' | 'costRows') =>
    editable
      ? [
          {
            title: '',
            key: 'op',
            width: 50,
            render: (_: unknown, row: Keyed<unknown>) => (
              <Button
                type="link"
                size="small"
                danger
                icon={<DeleteOutlined />}
                onClick={() => removeRow(field, row.key)}
              />
            ),
          },
        ]
      : [];

  const purchaseColumns: ColumnsType<Keyed<PurchaseItemRow>> = [
    { title: '序号', width: 60, render: (_v, _r, i) => i + 1 },
    {
      title: '物资名称',
      dataIndex: 'materialName',
      render: (v: string | null, row) =>
        textCell(v, (val) => updateRow('purchaseItems', row.key, { materialName: val })),
    },
    {
      title: '规格型号',
      dataIndex: 'spec',
      render: (v: string | null, row) => textCell(v, (val) => updateRow('purchaseItems', row.key, { spec: val })),
    },
    {
      title: '计量单位',
      dataIndex: 'unit',
      width: 120,
      render: (v: string | null, row) => textCell(v, (val) => updateRow('purchaseItems', row.key, { unit: val })),
    },
    {
      title: '暂定数量',
      dataIndex: 'qty',
      width: 140,
      render: (v: number | null, row) =>
        editable
          ? numberCell(v, (n) => updateRow('purchaseItems', row.key, { qty: n }), { precision: 3 })
          : v != null
            ? v.toLocaleString('zh-CN')
            : '-',
    },
    ...opColumn('purchaseItems'),
  ];

  const costColumns: ColumnsType<Keyed<CostAnalysisRow>> = [
    { title: '序号', width: 56, render: (_v, _r, i) => i + 1 },
    {
      title: '物资名称',
      dataIndex: 'materialName',
      render: (v: string | null, row) => textCell(v, (val) => updateRow('costRows', row.key, { materialName: val })),
    },
    {
      title: '规格型号',
      dataIndex: 'spec',
      render: (v: string | null, row) => textCell(v, (val) => updateRow('costRows', row.key, { spec: val })),
    },
    {
      title: '清单收入（万元）',
      dataIndex: 'income',
      width: 150,
      render: (v: number | null, row) =>
        editable
          ? numberCell(v, (n) => updateRow('costRows', row.key, { income: n ?? 0 }), { suffix: '万元' })
          : fmtWan(v),
    },
    {
      title: '预计采购成本（万元）',
      dataIndex: 'cost',
      width: 170,
      render: (v: number | null, row) =>
        editable
          ? numberCell(v, (n) => updateRow('costRows', row.key, { cost: n ?? 0 }), { suffix: '万元' })
          : fmtWan(v),
    },
    {
      title: '预计效益额（万元）',
      key: 'benefit',
      width: 150,
      render: (_v, row) => fmtWan(deriveCostRow(row).benefit),
    },
    {
      title: '效益率',
      key: 'rate',
      width: 110,
      render: (_v, row) => fmtRate(deriveCostRow(row).rate),
    },
    ...opColumn('costRows'),
  ];

  const addRow = (field: 'purchaseItems' | 'costRows') => {
    setForm((f) => {
      if (field === 'purchaseItems') {
        const blank: Keyed<PurchaseItemRow> = { key: nextKey(), materialName: '', spec: '', unit: '', qty: null };
        return { ...f, purchaseItems: [...f.purchaseItems, blank] };
      }
      const blank: Keyed<CostAnalysisRow> = { key: nextKey(), materialName: '', spec: '', income: 0, cost: 0 };
      return { ...f, costRows: [...f.costRows, blank] };
    });
  };

  /* ---------------- 渲染 ---------------- */

  const richSection = (
    label: string,
    field: 'techQuality' | 'acceptance' | 'paymentTerms',
    tip?: string,
  ) => (
    <Card size="small" title={label}>
      {tip && <div style={{ color: '#8c8c8c', fontSize: 12, marginBottom: 8 }}>{tip}</div>}
      <RichTextEditor
        value={form[field]}
        onChange={(html) => patchForm({ [field]: html } as Partial<MinutesForm>)}
        variableGroups={getProcurementVariableGroups(MODULE_TYPE)}
        disabled={!editable}
        minHeight={180}
        placeholder={`请填写${label}`}
      />
    </Card>
  );

  const totals = useMemo(() => summarizeCost(form.costRows.map(stripKey)), [form.costRows]);

  /** 采前会模块特有筛选项 */
  const extraFilters: ModuleListFilterField[] = [
    { key: 'meeting', label: '会议时间', control: 'dateRange' },
    { key: 'host', label: '主持人', control: 'input' },
  ];

  /** 采前会模块特有表格列 */
  const extraColumns: ColumnsType<ModuleListRow> = [
    {
      title: '会议时间',
      key: 'meetingTime',
      width: 120,
      render: (_v, row) =>
        row.module?.meetingTime ? dayjs(row.module.meetingTime).format('YYYY-MM-DD') : '-',
    },
    { title: '主持人', key: 'host', width: 120, ellipsis: { showTitle: true }, render: (_v, row) => row.module?.host || '-' },
    { title: '编写人', key: 'writer', width: 120, ellipsis: { showTitle: true }, render: (_v, row) => row.module?.writer || '-' },
  ];

  return (
    <Space direction="vertical" size={12} style={{ width: '100%' }}>
      {/* 标准列表页（批次五）：筛选区 + 工具栏 + 数据表格 */}
      <ModuleListPage
        moduleKey="PRE_MEETING"
        baseParams={{ type: 'SINGLE', preMeetingRequired: 'true' }}
        extraFilters={extraFilters}
        extraColumns={extraColumns}
        toolbarLeft={
          <span style={{ color: '#8c8c8c', fontSize: 13 }}>
            仅显示单项采购且需要采前会（预计采购金额 ≥ 100 万）的任务
          </span>
        }
        refreshKey={listRefresh}
        onView={openRow}
        onEdit={editRow}
        onDelete={handleDeleteModule}
        emptyText="暂无数据（仅「单项采购」类型且预计采购金额 ≥ 100 万元的采购任务才生成采前会会议纪要）"
      />

      {/* 只读详情抽屉（需求修正 · 修改二）：由列表行「查看」进入，编辑在弹窗进行 */}
      <Drawer
        title={`采前会会议纪要 · 任务详情${currentTask ? ` · ${currentTask.taskNo}` : ''}`}
        width={1200}
        open={detailOpen && !!currentTask}
        onClose={closeDetail}
        destroyOnClose
      >
        {currentTask && (
          <ModuleDetailCard
            title="采前会会议纪要 · 任务详情"
            taskNo={currentTask.taskNo}
            content={form.content || currentTask.content}
            statusLabel={detail?.statusLabel ?? '编辑中'}
            publishedAt={detail?.data?.publishedAt ?? null}
            extraDescriptions={
              <Descriptions.Item label="预计采购金额">
                {fmtWan(detail?.estimatedAmountWan ?? 0)} 万元
              </Descriptions.Item>
            }
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
      </Drawer>

      {/* 编辑弹窗（需求修正 · 修改二）：保存后关闭返回只读详情 */}
      <Drawer
        title={`采前会会议纪要 · 编辑${currentTask ? ` · ${currentTask.taskNo}` : ''}`}
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
            {editable && detail?.published && (
              <Alert
                type="warning"
                showIcon
                message="重新编辑模式：修改后请保存，发布状态保持「已完成」。"
              />
            )}

            {/* 展示信息 */}
            <Card size="small" title="展示信息">
              <Descriptions column={2} size="small" bordered>
                <Descriptions.Item label="采购内容">{form.content || currentTask.content}</Descriptions.Item>
                <Descriptions.Item label="预计采购金额">
                  {fmtWan(detail?.estimatedAmountWan ?? 0)} 万元
                </Descriptions.Item>
                <Descriptions.Item label="会议时间">{form.meetingTime || '-'}</Descriptions.Item>
                <Descriptions.Item label="发布时间">
                  {detail?.data?.publishedAt ? dayjs(detail.data.publishedAt).format('YYYY-MM-DD HH:mm') : '-'}
                </Descriptions.Item>
              </Descriptions>
            </Card>

            {/* 基本信息 */}
            <Card size="small" title="一、会议基本信息">
              <Row gutter={[16, 16]}>
                <Col span={8}>
                  <div style={{ color: '#8c8c8c', fontSize: 12, marginBottom: 4 }}>项目名称（自动带出）</div>
                  <Input value={project.name ?? ''} disabled placeholder="（项目名称）" />
                </Col>
                <Col span={8}>
                  <div style={{ color: '#8c8c8c', fontSize: 12, marginBottom: 4 }}>会议时间</div>
                  {editable ? (
                    <DatePicker
                      style={{ width: '100%' }}
                      value={form.meetingTime ? dayjs(form.meetingTime) : null}
                      onChange={(d) => patchForm({ meetingTime: d ? d.format('YYYY-MM-DD') : null })}
                    />
                  ) : (
                    <div style={{ minHeight: 22 }}>{form.meetingTime || '-'}</div>
                  )}
                </Col>
                <Col span={8}>
                  <Field
                    label="采购内容"
                    value={form.content}
                    editable={editable}
                    onChange={(v) => patchForm({ content: v })}
                  />
                </Col>
                <Col span={6}>
                  <Field label="主持人" value={form.host} editable={editable} onChange={(v) => patchForm({ host: v })} />
                </Col>
                <Col span={6}>
                  <Field
                    label="参会人员"
                    value={form.attendees}
                    editable={editable}
                    onChange={(v) => patchForm({ attendees: v })}
                  />
                </Col>
                <Col span={6}>
                  <Field
                    label="会议纪要编写人"
                    value={form.writer}
                    editable={editable}
                    onChange={(v) => patchForm({ writer: v })}
                  />
                </Col>
                <Col span={6}>
                  <Field
                    label="审核人"
                    value={form.reviewer}
                    editable={editable}
                    onChange={(v) => patchForm({ reviewer: v })}
                  />
                </Col>
              </Row>
            </Card>

            {/* 采购清单 */}
            <Card
              size="small"
              title="二、采购清单"
              extra={
                editable && (
                  <Space>
                    <Button
                      size="small"
                      icon={<ImportOutlined />}
                      loading={importing}
                      onClick={() => taskId && importFromTotalList(taskId)}
                    >
                      从总采购清单导入
                    </Button>
                    <Button size="small" icon={<PlusOutlined />} onClick={() => addRow('purchaseItems')}>
                      添加行
                    </Button>
                  </Space>
                )
              }
            >
              <Table
                size="small"
                rowKey="key"
                columns={purchaseColumns}
                dataSource={form.purchaseItems as unknown as Keyed<PurchaseItemRow>[]}
                pagination={false}
                locale={{ emptyText: '暂无数据（可点击「从总采购清单导入」自动带出）' }}
              />
            </Card>

            {richSection('三、技术质量要求', 'techQuality')}
            {richSection('四、验收标准', 'acceptance')}
            {richSection('五、付款条件', 'paymentTerms')}

            {/* 采购成本分析表 */}
            <Card
              size="small"
              title="六、采购成本分析表"
              extra={
                editable && (
                  <Space>
                    <Button
                      size="small"
                      icon={<ImportOutlined />}
                      loading={importing}
                      onClick={() => taskId && importFromTotalList(taskId)}
                    >
                      从总采购清单导入
                    </Button>
                    <Button size="small" icon={<PlusOutlined />} onClick={() => addRow('costRows')}>
                      添加行
                    </Button>
                  </Space>
                )
              }
            >
              <Alert
                type="info"
                showIcon
                style={{ marginBottom: 12 }}
                message="计算规则：清单收入 = 收入单价 × 暂定数量；预计采购成本 = 控制价 × 暂定数量；预计效益额 = 清单收入 − 预计采购成本；效益率 = 预计效益额 ÷ 清单收入。金额按万元保留 2 位小数，效益率按百分比保留 2 位小数。"
              />
              <Table
                size="small"
                rowKey="key"
                columns={costColumns}
                dataSource={form.costRows as unknown as Keyed<CostAnalysisRow>[]}
                pagination={false}
                locale={{ emptyText: '暂无数据（可点击「从总采购清单导入」自动带出）' }}
                summary={() => (
                  <Table.Summary.Row style={{ background: '#fafafa', fontWeight: 600 }}>
                    <Table.Summary.Cell index={0} colSpan={3}>
                      合计
                    </Table.Summary.Cell>
                    <Table.Summary.Cell index={3}>{fmtWan(totals.income)}</Table.Summary.Cell>
                    <Table.Summary.Cell index={4}>{fmtWan(totals.cost)}</Table.Summary.Cell>
                    <Table.Summary.Cell index={5}>{fmtWan(totals.benefit)}</Table.Summary.Cell>
                    <Table.Summary.Cell index={6}>{fmtRate(totals.rate)}</Table.Summary.Cell>
                    <Table.Summary.Cell index={7} />
                  </Table.Summary.Row>
                )}
              />
            </Card>

            {/* 询价单 */}
            <Card size="small" title="七、询价单（图片，支持多张）">
              <Upload
                listType="picture-card"
                accept="image/*"
                multiple
                disabled={!editable}
                fileList={fileList}
                onPreview={(file) => setImgPreview(file.url || (file.response as any)?.url || null)}
                customRequest={async (options: any) => {
                  try {
                    const fd = new FormData();
                    fd.append('files', options.file);
                    const res: any = await http.post('/files/upload', fd);
                    const arr = Array.isArray(res) ? res : res?.data ?? [];
                    options.onSuccess?.(arr[0]);
                  } catch (e) {
                    options.onError?.(e);
                  }
                }}
                onChange={(info) => {
                  const list = info.fileList.filter((f) => f.status !== 'removed');
                  setFileList(list);
                  if (info.file.status === 'done') message.success(`「${info.file.name}」上传成功`);
                  if (info.file.status === 'error') message.error(`「${info.file.name}」上传失败`);
                }}
              >
                {editable && (
                  <div>
                    <PlusOutlined />
                    <div style={{ marginTop: 8 }}>上传询价单</div>
                  </div>
                )}
              </Upload>
              {fileList.length === 0 && <div style={{ color: '#999' }}>（暂无询价单）</div>}
            </Card>

            {/* 操作 */}
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
        content={form.content || currentTask?.content}
        confirmTitle="确认发布采前会会议纪要？"
        confirmDescription="发布前将自动保存当前内容；发布后状态变更为「已完成」，仍可预览与重新编辑。"
        onPublish={handlePublish}
        onClose={() => setModalMode(null)}
      />

      <Modal
        title="询价单预览"
        open={!!imgPreview}
        footer={null}
        width={720}
        onCancel={() => setImgPreview(null)}
      >
        {imgPreview && <img src={imgPreview} style={{ width: '100%' }} alt="询价单" />}
      </Modal>

      <style>{`
        .ant-table-summary { font-weight: 600; }
      `}</style>
    </Space>
  );
}
