import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import {
  Alert,
  Button,
  Card,
  Input,
  InputNumber,
  Modal,
  Popconfirm,
  Select,
  Space,
  Spin,
  Table,
  Tooltip,
  Upload,
  message,
} from 'antd';
import type { ColumnsType } from 'antd/es/table';
import type { UploadFile } from 'antd/es/upload/interface';
import {
  DeleteOutlined,
  EyeOutlined,
  FileWordOutlined,
  PlusOutlined,
  SaveOutlined,
  SendOutlined,
} from '@ant-design/icons';
import http from '@/api/http';
import { procurementTaskApi } from '@/api/modules';
import { projectApi } from '@/api/business';
import { useAuthStore } from '@/store/auth';
import PreviewPublishModal from '@/components/PreviewPublishModal';
import TaskViewModal from '@/components/procurement/TaskViewModal';
import ModuleListPage, {
  moduleStatusOf,
  type ModuleListFilterField,
  type ModuleListRow,
  useModuleDelete,
} from '@/components/procurement/ModuleListPage';
import { exportProcurementWord } from '@/utils/procurementExport';
import { exportTaskModuleWord } from '@/utils/procurementTaskDocs';
import {
  buildExplanationDocHtml,
  buildExplanationVariableValues,
  type CostRow,
  type InquiryRow,
  type PriceCompareRow,
} from '@/utils/frameworkExplanation';

/** 采购任务行（列表精简） */
interface TaskRow {
  id: string;
  taskNo: string;
  type: string;
  content: string;
  status: string;
  stage: number;
}

/** 可编辑行：带前端 key 供 Table 渲染（保存时剔除） */
type Keyed<T> = T & { key: string };

/** 问题五：引用供应商及金额（可从询价情况自动填充最低价单位） */
export interface ReferenceSupplier {
  supplier: string;
  amount: number | null;
}

interface ExplanationForm {
  frameworkIntro: string;
  negotiation: string;
  inquiryRows: Keyed<InquiryRow>[];
  priceCompareRows: Keyed<PriceCompareRow>[];
  execution: string;
  costRows: Keyed<CostRow>[];
  referenceSuppliers: Keyed<ReferenceSupplier>[];
}

interface ExplanationDetail {
  task: TaskRow;
  editable: boolean;
  published: boolean;
  status: string;
  statusLabel: string;
  data: {
    frameworkIntro?: string;
    negotiation?: string;
    inquiryRows?: InquiryRow[];
    priceCompareRows?: PriceCompareRow[];
    execution?: string;
    costRows?: CostRow[];
    referenceSuppliers?: ReferenceSupplier[];
    attachments?: { fileName?: string; url?: string; size?: number | null }[];
    publishedAt?: string | null;
  } | null;
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

const EMPTY_FORM: ExplanationForm = {
  frameworkIntro: '',
  negotiation: '',
  inquiryRows: [],
  priceCompareRows: [],
  execution: '',
  costRows: [],
  referenceSuppliers: [],
};

export default function FrameworkExplanation() {
  const [searchParams, setSearchParams] = useSearchParams();
  const currentProjectId = useAuthStore((s) => s.currentProjectId);

  const [taskId, setTaskId] = useState<string | null>(searchParams.get('taskId') || null);
  /** 列表刷新键：编辑弹窗关闭后重查，反映最新模块状态 */
  const [listRefresh, setListRefresh] = useState(0);
  /** 问题二：删除模块记录并回退流程 */
  const handleDeleteModule = useModuleDelete('FRAMEWORK_EXPLANATION', () => setListRefresh((k) => k + 1));

  const [detail, setDetail] = useState<ExplanationDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);

  const [form, setForm] = useState<ExplanationForm>(EMPTY_FORM);
  const [fileList, setFileList] = useState<UploadFile[]>([]);
  const [saving, setSaving] = useState(false);
  const [publishing, setPublishing] = useState(false);
  /** 发布后默认预览（只读）；点「重新编辑」解锁 */
  const [reEditing, setReEditing] = useState(false);
  /** 统一预览/发布弹窗（批次四 · 任务 4.2）：publish=发布前确认；preview=纯预览 */
  const [modalMode, setModalMode] = useState<'preview' | 'publish' | null>(null);
  /** 编辑弹窗（问题一：未填写/编辑中行「编辑」直接进入；带 taskId 进入页面时直接打开） */
  const [editOpen, setEditOpen] = useState(!!searchParams.get('taskId'));
  /** 任务查看弹窗（问题一：已完成行「查看」→ 任务信息+采购明细+Word 文档） */
  const [viewRow, setViewRow] = useState<ModuleListRow | null>(null);
  /** 重新编辑标记：loadDetail 完成后按此恢复可编辑（已发布行「重新编辑」） */
  const reEditRef = useRef(false);

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
      .frameworkExplanation(id)
      .then((res: any) => {
        const d: ExplanationDetail = res; // 响应拦截器已解开 body.data，res 即完整 payload（含 task 与 data 记录）
        setDetail(d);
        const data = d?.data ?? {};
        setForm({
          frameworkIntro: data.frameworkIntro ?? '',
          negotiation: data.negotiation ?? '',
          inquiryRows: withKeys(data.inquiryRows ?? []),
          priceCompareRows: withKeys(data.priceCompareRows ?? []),
          execution: data.execution ?? '',
          costRows: withKeys(data.costRows ?? []),
          referenceSuppliers: withKeys(data.referenceSuppliers ?? []),
        });
        setFileList(
          (data.attachments ?? []).map((f, i) => ({
            uid: f.url || `att-${i}`,
            name: f.fileName || `附件${i + 1}`,
            status: 'done' as const,
            response: f,
          })),
        );
        setReEditing(reEditRef.current && !!d.published);
        reEditRef.current = false;
      })
      .catch(() => {
        setDetail(null);
        setForm(EMPTY_FORM);
      })
      .finally(() => setDetailLoading(false));
  }, []);

  useEffect(() => {
    if (taskId) loadDetail(taskId);
  }, [taskId, loadDetail]);

  /** 列表行操作（问题一）：已完成行 → 任务查看弹窗；未填写/编辑中 → 直接进入编辑界面 */
  const handleViewRow = (row: ModuleListRow) => {
    if (moduleStatusOf(row).value === 'PUBLISHED') setViewRow(row);
    else editRow(row);
  };
  /** 列表行操作：编辑（reEdit=true 为已发布后的重新编辑） */
  const editRow = (row: ModuleListRow, reEdit = false) => {
    setTaskId(row.id);
    setSearchParams({ taskId: row.id }, { replace: true });
    reEditRef.current = reEdit;
    setEditOpen(true);
  };
  /** 关闭编辑弹窗后刷新列表（反映保存/发布后的最新模块状态） */
  const closeEdit = () => {
    setEditOpen(false);
    setListRefresh((x) => x + 1);
  };

  /** 行「更多 → 导出Word」（问题二）：按任务直接构建并导出本模块文档 */
  const handleRowExport = async (row: ModuleListRow) => {
    try {
      const filename = await exportTaskModuleWord('FRAMEWORK', row.id);
      message.success(`已导出：${filename}`);
    } catch (e: any) {
      message.error(e?.message || '导出失败，请稍后重试');
    }
  };

  const patchForm = (patch: Partial<ExplanationForm>) => setForm((f) => ({ ...f, ...patch }));

  const updateRow = (
    field: 'inquiryRows' | 'priceCompareRows' | 'costRows' | 'referenceSuppliers',
    key: string,
    patch: Record<string, unknown>,
  ) => {
    setForm((f) => ({
      ...f,
      [field]: (f[field] as Keyed<unknown>[]).map((r) => (r.key === key ? { ...r, ...patch } : r)),
    }));
  };
  const removeRow = (
    field: 'inquiryRows' | 'priceCompareRows' | 'costRows' | 'referenceSuppliers',
    key: string,
  ) => {
    setForm((f) => ({
      ...f,
      [field]: (f[field] as Keyed<unknown>[]).filter((r) => r.key !== key),
    }));
  };

  /** 附表：Upload fileList 中的成功响应即附件元数据 */
  const attachmentsFromList = (list: UploadFile[]) =>
    list
      .map((f) => f.response as { fileName?: string; url?: string; size?: number | null } | undefined)
      .filter((f): f is { fileName?: string; url?: string; size?: number | null } => !!f?.url);

  const buildSavePayload = () => ({
    frameworkIntro: form.frameworkIntro,
    negotiation: form.negotiation,
    inquiryRows: form.inquiryRows.map(stripKey),
    priceCompareRows: form.priceCompareRows.map(stripKey),
    execution: form.execution,
    costRows: form.costRows.map(stripKey),
    referenceSuppliers: form.referenceSuppliers
      .map(stripKey)
      .filter((r) => String(r.supplier ?? '').trim()),
    attachments: attachmentsFromList(fileList),
  });

  const handleSave = async () => {
    if (!taskId) return;
    setSaving(true);
    try {
      await procurementTaskApi.saveFrameworkExplanation(taskId, buildSavePayload());
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
    if (!String(form.frameworkIntro ?? '').trim()) {
      message.warning('请先填写「框架简介」再发布');
      return;
    }
    setModalMode('publish');
  };

  /** 发布流程第 2 步：确认发布（先落库当前编辑内容） */
  const handlePublish = async () => {
    if (!taskId) return;
    setPublishing(true);
    try {
      await procurementTaskApi.saveFrameworkExplanation(taskId, buildSavePayload());
      await procurementTaskApi.publish(taskId);
      message.success('已发布，框架协议事前说明状态变更为「已完成」');
      setModalMode(null);
      closeEdit();
    } finally {
      setPublishing(false);
    }
  };

  /** 模块内置文档 HTML（含 {{占位符}}，未替换；统一管线内完成模板优先与变量替换） */
  const rawDocHtml = useMemo(() => {
    if (!currentTask) return '';
    const ctx = {
      projectName: project.name,
      projectAbbr: project.nameAbbr,
      undertaker: project.undertaker,
      provinceCity: project.provinceCity,
      siteLocation: project.siteLocation,
      projectAddress: project.projectAddress,
      content: currentTask.content,
    };
    const title = `${project.nameAbbr || project.name || ''}-${currentTask.content}-框架协议事前说明`;
    return buildExplanationDocHtml(form, ctx, title);
  }, [form, currentTask, project]);

  /** 变量取值（统一预览 / 导出共用） */
  const varValues = useMemo(() => {
    const ctx = {
      projectName: project.name,
      projectAbbr: project.nameAbbr,
      undertaker: project.undertaker,
      provinceCity: project.provinceCity,
      siteLocation: project.siteLocation,
      projectAddress: project.projectAddress,
      content: currentTask?.content,
    };
    return buildExplanationVariableValues(form, ctx);
  }, [form, currentTask]);

  const exportFilename = `${
    project.nameAbbr || project.name || '项目'
  }-${currentTask?.content || '采购'}-框架协议事前说明.docx`;

  const handleExport = async () => {
    if (!currentTask) return;
    await exportProcurementWord({
      moduleType: 'FRAMEWORK',
      taskId: taskId ?? undefined,
      docHtml: rawDocHtml,
      values: varValues,
      filename: exportFilename,
    });
    message.success(`已导出：${exportFilename}`);
  };

  /** 只读详情文档（模板优先 + 变量替换，需求修正 · 修改二） */
  /** ---------- 表格编辑渲染 ---------- */
  const numberCell = (
    value: number | null | undefined,
    onChange: (v: number | null) => void,
    suffix?: string,
  ) => (
    <InputNumber
      size="small"
      style={{ width: '100%' }}
      min={0}
      precision={2}
      addonAfter={suffix}
      value={value ?? undefined}
      disabled={!editable}
      onChange={(v) => onChange(typeof v === 'number' ? v : null)}
    />
  );
  const textCell = (value: string | null | undefined, onChange: (v: string) => void) =>
    editable ? (
      <Input size="small" value={value ?? undefined} onChange={(e) => onChange(e.target.value)} />
    ) : (
      value ?? '-'
    );

  const opColumn = <T,>(field: 'inquiryRows' | 'priceCompareRows' | 'costRows' | 'referenceSuppliers') =>
    editable
      ? [
          {
            title: '',
            key: 'op',
            width: 50,
            render: (_: unknown, row: Keyed<T>) => (
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

  const inquiryColumns: ColumnsType<Keyed<InquiryRow>> = [
    {
      title: '排名',
      dataIndex: 'rank',
      width: 90,
      render: (v: string | null, row) => textCell(v, (val) => updateRow('inquiryRows', row.key, { rank: val })),
    },
    {
      title: '单位',
      dataIndex: 'unit',
      render: (v: string | null, row) => textCell(v, (val) => updateRow('inquiryRows', row.key, { unit: val })),
    },
    {
      title: '总价（元）',
      dataIndex: 'totalPrice',
      width: 150,
      render: (v: number | null, row) =>
        editable
          ? numberCell(v, (n) => updateRow('inquiryRows', row.key, { totalPrice: n }))
          : v != null
            ? v.toLocaleString('zh-CN')
            : '-',
    },
    {
      title: '含税',
      dataIndex: 'taxIncluded',
      width: 120,
      render: (v: string | null, row) =>
        editable ? (
          <Select
            size="small"
            style={{ width: '100%' }}
            value={v ?? undefined}
            allowClear
            placeholder="—"
            options={[
              { value: '含税', label: '含税' },
              { value: '不含税', label: '不含税' },
            ]}
            onChange={(val) => updateRow('inquiryRows', row.key, { taxIncluded: val ?? null })}
          />
        ) : (
          v ?? '-'
        ),
    },
    {
      title: '类型',
      dataIndex: 'type',
      width: 130,
      render: (v: string | null, row) => textCell(v, (val) => updateRow('inquiryRows', row.key, { type: val })),
    },
    ...opColumn<InquiryRow>('inquiryRows'),
  ];

  const priceColumns: ColumnsType<Keyed<PriceCompareRow>> = [
    { title: '序号', width: 60, render: (_v, _r, i) => i + 1 },
    {
      title: '单位',
      dataIndex: 'unit',
      render: (v: string | null, row) => textCell(v, (val) => updateRow('priceCompareRows', row.key, { unit: val })),
    },
    {
      title: '合同内容',
      dataIndex: 'content',
      render: (v: string | null, row) => textCell(v, (val) => updateRow('priceCompareRows', row.key, { content: val })),
    },
    {
      title: '执行合同价（元）',
      dataIndex: 'execPrice',
      width: 160,
      render: (v: number | null, row) =>
        editable
          ? numberCell(v, (n) => updateRow('priceCompareRows', row.key, { execPrice: n }))
          : v != null
            ? v.toLocaleString('zh-CN')
            : '-',
    },
    {
      title: '备注',
      dataIndex: 'note',
      render: (v: string | null, row) => textCell(v, (val) => updateRow('priceCompareRows', row.key, { note: val })),
    },
    ...opColumn<PriceCompareRow>('priceCompareRows'),
  ];

  const costColumns: ColumnsType<Keyed<CostRow>> = [
    {
      title: '成本项目',
      dataIndex: 'item',
      render: (v: string | null, row) => textCell(v, (val) => updateRow('costRows', row.key, { item: val })),
    },
    {
      title: '金额（万元）',
      dataIndex: 'amount',
      width: 140,
      render: (v: number | null, row) =>
        editable
          ? numberCell(v, (n) => updateRow('costRows', row.key, { amount: n }))
          : v != null
            ? v.toLocaleString('zh-CN')
            : '-',
    },
    {
      title: '占比（%）',
      dataIndex: 'ratio',
      width: 120,
      render: (v: number | null, row) =>
        editable
          ? numberCell(v, (n) => updateRow('costRows', row.key, { ratio: n }), '%')
          : v != null
            ? `${v}%`
            : '-',
    },
    {
      title: '备注',
      dataIndex: 'note',
      render: (v: string | null, row) => textCell(v, (val) => updateRow('costRows', row.key, { note: val })),
    },
    ...opColumn<CostRow>('costRows'),
  ];

  const addRow = (field: 'inquiryRows' | 'priceCompareRows' | 'costRows' | 'referenceSuppliers') => {
    setForm((f) => {
      if (field === 'inquiryRows') {
        const blank: Keyed<InquiryRow> = {
          key: nextKey(),
          rank: String(f.inquiryRows.length + 1),
          unit: '',
          totalPrice: null,
          taxIncluded: '含税',
          type: '',
        };
        return { ...f, inquiryRows: [...f.inquiryRows, blank] };
      }
      if (field === 'priceCompareRows') {
        const blank: Keyed<PriceCompareRow> = { key: nextKey(), unit: '', content: '', execPrice: null, note: '' };
        return { ...f, priceCompareRows: [...f.priceCompareRows, blank] };
      }
      if (field === 'referenceSuppliers') {
        const blank: Keyed<ReferenceSupplier> = { key: nextKey(), supplier: '', amount: null };
        return { ...f, referenceSuppliers: [...f.referenceSuppliers, blank] };
      }
      const blank: Keyed<CostRow> = { key: nextKey(), item: '', amount: null, ratio: null, note: '' };
      return { ...f, costRows: [...f.costRows, blank] };
    });
  };

  /** ---------- 引用供应商及金额（问题五） ---------- */

  const refSupplierColumns: ColumnsType<Keyed<ReferenceSupplier>> = [
    {
      title: '供应商',
      dataIndex: 'supplier',
      render: (v: string | null, row) => textCell(v, (val) => updateRow('referenceSuppliers', row.key, { supplier: val })),
    },
    {
      title: '引用金额（元）',
      dataIndex: 'amount',
      width: 160,
      render: (v: number | null, row) =>
        editable
          ? numberCell(v, (n) => updateRow('referenceSuppliers', row.key, { amount: n }))
          : v != null
            ? v.toLocaleString('zh-CN')
            : '-',
    },
    ...opColumn<ReferenceSupplier>('referenceSuppliers'),
  ];

  /** 自动填充：从询价情况表取报价最低的单位与金额（可多行手动增改） */
  const autoFillRefSuppliers = () => {
    const priced = form.inquiryRows.filter((r) => String(r.unit ?? '').trim() && r.totalPrice != null);
    if (!priced.length) {
      message.warning('询价情况表中暂无有效报价（单位 + 总价），无法自动填充');
      return;
    }
    const min = Math.min(...priced.map((r) => Number(r.totalPrice)));
    const winners = priced.filter((r) => Number(r.totalPrice) === min);
    setForm((f) => ({
      ...f,
      referenceSuppliers: winners.map((r) => ({
        key: nextKey(),
        supplier: String(r.unit),
        amount: Number(r.totalPrice),
      })),
    }));
    message.success(
      `已自动填充询价最低价供应商 ${winners.length} 家（最低价 ${min.toLocaleString('zh-CN')} 元），可继续手动增改`,
    );
  };

  const refSupplierSection = (
    <Card
      size="small"
      title="引用供应商及金额"
      extra={
        editable && (
          <Space size={8}>
            <Button size="small" onClick={autoFillRefSuppliers}>
              自动填充最低价
            </Button>
            <Button size="small" icon={<PlusOutlined />} onClick={() => addRow('referenceSuppliers')}>
              添加行
            </Button>
          </Space>
        )
      }
    >
      <Table
        size="small"
        rowKey="key"
        columns={refSupplierColumns}
        dataSource={form.referenceSuppliers as unknown as any[]}
        pagination={false}
        locale={{ emptyText: '暂无数据（可点击「自动填充最低价」从询价情况带出，或手动添加行）' }}
      />
    </Card>
  );

  /** ---------- 渲染 ---------- */
  const textSection = (
    label: string,
    field: 'frameworkIntro' | 'negotiation' | 'execution',
    rows = 5,
  ) => (
    <Card size="small" title={label}>
      {editable ? (
        <Input.TextArea
          rows={rows}
          value={form[field]}
          maxLength={5000}
          placeholder={`请填写${label}`}
          onChange={(e) => patchForm({ [field]: e.target.value } as Partial<ExplanationForm>)}
        />
      ) : (
        <div style={{ whiteSpace: 'pre-wrap', color: form[field] ? undefined : '#999' }}>
          {form[field] || '（待填写）'}
        </div>
      )}
    </Card>
  );

  const tableSection = (
    label: string,
    field: 'inquiryRows' | 'priceCompareRows' | 'costRows',
    columns: ColumnsType<any>,
  ) => (
    <Card
      size="small"
      title={label}
      extra={
        editable && (
          <Button size="small" icon={<PlusOutlined />} onClick={() => addRow(field)}>
            添加行
          </Button>
        )
      }
    >
      <Table
        size="small"
        rowKey="key"
        columns={columns}
        dataSource={form[field] as unknown as any[]}
        pagination={false}
        locale={{ emptyText: '暂无数据' }}
      />
    </Card>
  );

  /* ---------------- 渲染 ---------------- */

  /** 问题五：模块特有筛选（采购内容为公共筛选，这里补「供应商」） */
  const extraFilters: ModuleListFilterField[] = [
    { key: 'supplier', label: '供应商', control: 'input', placeholder: '请输入供应商' },
  ];

  /** 问题五：模块特有表格列（采购内容后：供应商 / 引用金额） */
  const extraColumns: ColumnsType<ModuleListRow> = [
    {
      title: '供应商',
      key: 'supplier',
      width: 200,
      ellipsis: { showTitle: true },
      render: (_v, row) => {
        const names: string[] = (row.module?.referenceSuppliers ?? [])
          .map((r: any) => String(r?.supplier ?? '').trim())
          .filter(Boolean);
        return names.length ? names.join('、') : '-';
      },
    },
    {
      title: '引用金额（元）',
      key: 'refAmount',
      width: 150,
      align: 'right',
      render: (_v, row) => {
        const list: any[] = row.module?.referenceSuppliers ?? [];
        if (!list.length) return '-';
        const sum = list.reduce((s, r) => s + (Number(r?.amount) || 0), 0);
        return sum.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
      },
    },
  ];

  return (
    <Space direction="vertical" size={12} style={{ width: '100%' }}>
      {/* 标准列表页（批次五）：筛选区 + 工具栏 + 数据表格（无模块特有列/筛选项） */}
      <ModuleListPage
        moduleKey="FRAMEWORK_EXPLANATION"
        baseParams={{ type: 'FRAMEWORK' }}
        extraFilters={extraFilters}
        extraColumns={extraColumns}
        toolbarLeft={
          <span style={{ color: '#8c8c8c', fontSize: 13 }}>
            仅显示引用框架协议类型的任务；编辑与发布以任务所处阶段为准
          </span>
        }
        refreshKey={listRefresh}
        onView={handleViewRow}
        onEdit={editRow}
        onDelete={handleDeleteModule}
        emptyText="暂无数据（仅「引用框架协议」类型的采购任务可使用框架协议事前说明模块）"
        rowMenuItems={(row) => {
          const published = moduleStatusOf(row).value === 'PUBLISHED';
          return published
            ? [
                {
                  key: 'exportWord',
                  label: (
                    <span>
                      <FileWordOutlined /> 导出Word
                    </span>
                  ),
                  onClick: () => handleRowExport(row),
                },
                { key: 'reEdit', label: '重新编辑', onClick: () => editRow(row, true) },
              ]
            : [];
        }}
      />

      {/* 任务查看弹窗（问题一：已完成行「查看」→ 居中弹窗：任务信息+采购明细+Word 文档） */}
      <TaskViewModal task={viewRow} open={!!viewRow} onClose={() => setViewRow(null)} />

      {/* 编辑弹窗（问题一：未填写/编辑中行「编辑」直接进入；问题三：居中弹窗） */}
      <Modal
        title={`框架协议事前说明 · 编辑${currentTask ? ` · ${currentTask.taskNo}` : ''}`}
        width={1100}
        centered
        open={editOpen}
        onCancel={closeEdit}
        destroyOnClose
        styles={{ body: { maxHeight: 'calc(100vh - 220px)', overflowY: 'auto' } }}
        footer={
          <Space style={{ float: 'right' }}>
            <Button onClick={closeEdit}>取消</Button>
            {currentTask && (
              <Button icon={<EyeOutlined />} onClick={() => setModalMode('preview')}>
                预览
              </Button>
            )}
            {currentTask && (
              <Button icon={<FileWordOutlined />} onClick={handleExport}>
                导出Word
              </Button>
            )}
            {editable && (
              <Button type="primary" icon={<SaveOutlined />} loading={saving} onClick={handleSave}>
                保存
              </Button>
            )}
            {detail && !detail.published && editable && (
              <Button type="primary" icon={<SendOutlined />} onClick={openPublishPreview}>
                发布
              </Button>
            )}
          </Space>
        }
      >
        <Spin spinning={detailLoading}>
          {!currentTask && !detailLoading && (
            <Alert type="warning" showIcon message="任务详情加载失败，请关闭后重试。" />
          )}
          {currentTask && (
            <Space direction="vertical" size={12} style={{ width: '100%' }}>
            {editable && detail?.published && (
              <Alert
                type="warning"
                showIcon
                message="重新编辑模式：修改后请保存，发布状态保持「已完成」。"
              />
            )}

            {textSection('一、框架简介', 'frameworkIntro', 6)}
            {textSection('二、谈判情况', 'negotiation')}
            {tableSection('三、询价情况', 'inquiryRows', inquiryColumns)}
            {refSupplierSection}
            {tableSection('四、同城/相邻城市局其他单位执行合同价', 'priceCompareRows', priceColumns)}
            {textSection('五、执行情况', 'execution')}
            {tableSection('六、成本分析', 'costRows', costColumns)}

            <Card
              size="small"
              title="七、附表"
              extra={
                editable && (
                  <Upload
                    name="files"
                    multiple
                    showUploadList={false}
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
                    <Button size="small" icon={<PlusOutlined />}>
                      上传附件
                    </Button>
                  </Upload>
                )
              }
            >
              {fileList.length === 0 ? (
                <span style={{ color: '#999' }}>（无附表）</span>
              ) : (
                <Space direction="vertical" size={4}>
                  {fileList.map((f) => (
                    <Space key={f.uid}>
                      <FileWordOutlined />
                      <span>{f.name}</span>
                      {editable && (
                        <Button
                          type="link"
                          size="small"
                          danger
                          icon={<DeleteOutlined />}
                          onClick={() => setFileList((l) => l.filter((x) => x.uid !== f.uid))}
                        >
                          移除
                        </Button>
                      )}
                    </Space>
                  ))}
                </Space>
              )}
            </Card>
          </Space>
          )}
        </Spin>
      </Modal>

      {/* 统一预览 / 发布流程（批次四 · 任务 4.2）：发布前确认与发布后预览共用 */}
      <PreviewPublishModal
        open={modalMode !== null}
        mode={modalMode ?? 'preview'}
        moduleType="FRAMEWORK"
        taskId={taskId ?? undefined}
        docHtml={rawDocHtml}
        values={varValues}
        publishing={publishing}
        filename={exportFilename}
        projectAbbr={project.nameAbbr}
        content={currentTask?.content}
        confirmTitle="确认发布框架协议事前说明？"
        confirmDescription="发布前将自动保存当前内容；发布后状态变更为「已完成」，仍可预览与重新编辑。"
        onPublish={handlePublish}
        onClose={() => setModalMode(null)}
      />
    </Space>
  );
}
