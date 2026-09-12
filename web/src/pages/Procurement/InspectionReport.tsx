import { useCallback, useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import {
  Alert,
  Button,
  Card,
  Col,
  DatePicker,
  Empty,
  Input,
  Modal,
  Popconfirm,
  Row,
  Space,
  Spin,
  Table,
  Tag,
  Tooltip,
  Upload,
  message,
} from 'antd';
import type { ColumnsType } from 'antd/es/table';
import type { UploadFile } from 'antd';
import {
  ArrowLeftOutlined,
  DownloadOutlined,
  EyeOutlined,
  PlusOutlined,
  RollbackOutlined,
  SaveOutlined,
  SendOutlined,
} from '@ant-design/icons';
import dayjs from 'dayjs';
import { inspectionReportApi } from '@/api/modules';
import { projectApi } from '@/api/business';
import { fileApi } from '@/api/auth';
import { useAuthStore } from '@/store/auth';
import {
  getProcurementVariableGroups,
} from '@/constants/procurementVariables';
import RichTextEditor from '@/components/RichTextEditor';
import PreviewPublishModal from '@/components/PreviewPublishModal';
import { exportProcurementWord } from '@/utils/procurementExport';
import {
  buildInspectionDocHtml,
  buildInspectionVariableValues,
  inlineImageUrls,
  inspectionExportFilename,
  type InspectionPhoto,
  type InspectionReportData,
} from '@/utils/inspectionReport';

/** 模块类型（与采购模板 moduleType、变量占位符前缀一致） */
const MODULE_TYPE = 'INSPECTION';

interface ReportRow {
  id: string;
  unitName: string;
  inspectionTime?: string | null;
  inspectionPlace?: string | null;
  inspectors?: string | null;
  content?: string | null;
  conclusion?: string | null;
  photos?: InspectionPhoto[];
  published?: boolean;
  status?: string;
  statusLabel?: string;
  publishedAt?: string | null;
  updatedAt?: string;
}

type EditMode = 'create' | 'edit';

const EMPTY_FORM = {
  unitName: '',
  inspectionTime: null as dayjs.Dayjs | null,
  inspectionPlace: '',
  inspectors: '',
  content: '',
  conclusion: '',
};

export default function InspectionReport() {
  const [searchParams, setSearchParams] = useSearchParams();
  const currentProjectId = useAuthStore((s) => s.currentProjectId);

  const [rows, setRows] = useState<ReportRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [keyword, setKeyword] = useState('');

  /** null = 列表模式；'create' = 新建；ReportRow = 编辑 */
  const [editing, setEditing] = useState<EditMode | ReportRow | null>(null);
  const [formValues, setFormValues] = useState(EMPTY_FORM);
  const [photos, setPhotos] = useState<InspectionPhoto[]>([]);
  const [detail, setDetail] = useState<ReportRow | null>(null);

  const [saving, setSaving] = useState(false);
  const [publishing, setPublishing] = useState(false);
  /** 统一预览/发布弹窗（批次四 · 任务 4.2）：publish=发布前确认；preview=纯预览 */
  const [modalMode, setModalMode] = useState<'preview' | 'publish' | null>(null);
  const [uploadingCount, setUploadingCount] = useState(0);

  const [project, setProject] = useState<{
    name?: string;
    code?: string;
    nameAbbr?: string;
    undertaker?: string;
    provinceCity?: string;
    siteLocation?: string;
    projectAddress?: string;
  }>({});

  const ctx = useMemo(
    () => ({
      projectName: project.name,
      projectCode: project.code,
      projectAbbr: project.nameAbbr,
      undertaker: project.undertaker,
      provinceCity: project.provinceCity,
      siteLocation: project.siteLocation,
      projectAddress: project.projectAddress,
    }),
    [project],
  );

  const currentData: InspectionPhoto extends never ? never : any = useMemo(
    () => ({
      unitName: formValues.unitName,
      inspectionTime: formValues.inspectionTime ? formValues.inspectionTime.toISOString() : null,
      inspectionPlace: formValues.inspectionPlace,
      inspectors: formValues.inspectors,
      content: formValues.content,
      conclusion: formValues.conclusion,
      photos,
    }),
    [formValues, photos],
  );

  const loadList = useCallback(
    (kw?: string) => {
      setLoading(true);
      inspectionReportApi
        .list(kw ? { keyword: kw, pageSize: 200 } : { pageSize: 200 })
        .then((res: any) => setRows(res?.list ?? res?.data?.list ?? []))
        .catch(() => setRows([]))
        .finally(() => setLoading(false));
    },
    [],
  );

  useEffect(() => {
    loadList();
  }, [loadList, currentProjectId]);

  useEffect(() => {
    if (!currentProjectId) return;
    projectApi
      .detail(currentProjectId)
      .then((res: any) => setProject(res ?? {}))
      .catch(() => setProject({}));
  }, [currentProjectId]);

  const resetForm = (row?: ReportRow) => {
    setFormValues(
      row
        ? {
            unitName: row.unitName ?? '',
            inspectionTime: row.inspectionTime ? dayjs(row.inspectionTime) : null,
            inspectionPlace: row.inspectionPlace ?? '',
            inspectors: row.inspectors ?? '',
            content: row.content ?? '',
            conclusion: row.conclusion ?? '',
          }
        : EMPTY_FORM,
    );
    setPhotos(Array.isArray(row?.photos) ? row!.photos! : []);
    setDetail(row ?? null);
  };

  const openCreate = () => {
    resetForm();
    setEditing('create');
    setSearchParams({}, { replace: true });
  };

  const openEdit = (row: ReportRow) => {
    resetForm(row);
    setEditing(row);
    setSearchParams({ id: row.id }, { replace: true });
  };

  const backToList = () => {
    setEditing(null);
    setDetail(null);
    setSearchParams({}, { replace: true });
    loadList(keyword);
  };

  /** URL 直达编辑（可选：?id=xxx） */
  useEffect(() => {
    const id = searchParams.get('id');
    if (id && !editing) {
      inspectionReportApi
        .detail(id)
        .then((res: any) => {
          const row = res?.data ?? res;
          if (row?.id) openEdit(row);
        })
        .catch(() => undefined);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const buildPayload = () => ({
    unitName: formValues.unitName.trim(),
    inspectionTime: formValues.inspectionTime ? formValues.inspectionTime.toISOString() : null,
    inspectionPlace: formValues.inspectionPlace,
    inspectors: formValues.inspectors,
    content: formValues.content,
    conclusion: formValues.conclusion,
    photos,
  });

  const handleSave = async () => {
    if (!formValues.unitName.trim()) {
      message.warning('请先填写「考察单位名称」');
      return;
    }
    setSaving(true);
    try {
      if (editing === 'create') {
        const res: any = await inspectionReportApi.create(buildPayload());
        const row = res?.data ?? res;
        message.success('已保存');
        if (row?.id) openEdit(row);
        else backToList();
      } else if (editing) {
        await inspectionReportApi.update((editing as ReportRow).id, buildPayload());
        message.success('已保存');
        setDetail({ ...(editing as ReportRow), ...buildPayload() });
      }
    } finally {
      setSaving(false);
    }
  };

  /** 发布流程第 1 步：校验 → 打开「发布前预览」（统一预览发布流程） */
  const openPublishPreview = () => {
    if (editing === 'create' || !editing) {
      message.warning('请先保存考察报告');
      return;
    }
    if (!formValues.unitName.trim()) {
      message.warning('请先填写「考察单位名称」再发布');
      return;
    }
    setModalMode('publish');
  };

  /** 发布流程第 2 步：确认发布（先落库当前编辑内容） */
  const handlePublish = async () => {
    if (editing === 'create' || !editing) {
      message.warning('请先保存考察报告');
      setModalMode(null);
      return;
    }
    setPublishing(true);
    try {
      const targetId = (editing as ReportRow).id;
      await inspectionReportApi.update(targetId, buildPayload());
      const res: any = await inspectionReportApi.publish(targetId);
      const row = res?.data ?? res;
      message.success('已发布，考察报告状态变更为「已完成」');
      setModalMode(null);
      if (row?.id) {
        resetForm(row);
        setEditing(row);
      }
    } finally {
      setPublishing(false);
    }
  };

  const handleUnpublish = async () => {
    if (editing === 'create' || !editing) return;
    const res: any = await inspectionReportApi.unpublish((editing as ReportRow).id);
    const row = res?.data ?? res;
    message.success('已撤回发布，状态变更为「编辑中」');
    if (row?.id) {
      resetForm(row);
      setEditing(row);
    }
  };

  const published = !!detail?.published;

  /** 预览 / 导出共用：模块内置文档 HTML（含 {{占位符}}，未替换；统一管线内完成模板优先、变量替换与图片内联） */
  const rawDocHtml = useMemo(() => {
    const filenameBase = inspectionExportFilename(currentData, ctx).replace(/\.docx$/, '');
    return buildInspectionDocHtml(currentData, ctx, filenameBase);
  }, [currentData, ctx]);

  /** 变量取值（统一预览 / 导出共用） */
  const varValues = useMemo(
    () => buildInspectionVariableValues(currentData, ctx),
    [currentData, ctx],
  );

  const exportFilename = inspectionExportFilename(currentData, ctx);

  const handleExport = async () => {
    await exportProcurementWord({
      moduleType: MODULE_TYPE,
      taskId: undefined,
      docHtml: rawDocHtml,
      values: varValues,
      filename: exportFilename,
    });
    message.success(`已导出：${exportFilename}`);
  };

  /* ---------------- 照片上传 ---------------- */

  const customRequest = async ({ file, onSuccess, onError }: any) => {
    setUploadingCount((c) => c + 1);
    try {
      const [f] = await fileApi.upload([file as File]);
      setPhotos((prev) => {
        if (prev.length >= 20) {
          message.warning('考察照片最多上传 20 张');
          return prev;
        }
        return [...prev, f];
      });
      onSuccess?.(f);
    } catch (e) {
      onError?.(e);
    } finally {
      setUploadingCount((c) => c - 1);
    }
  };

  const fileList: UploadFile[] = photos.map((p, i) => ({
    uid: `photo-${i}`,
    name: p.fileName || `考察照片${i + 1}`,
    status: 'done',
    url: p.url,
  }));

  /* ---------------- 列表视图 ---------------- */

  const columns: ColumnsType<ReportRow> = [
    {
      title: '考察单位名称',
      dataIndex: 'unitName',
      width: 220,
      render: (v: string) => v || '-',
    },
    {
      title: '考察时间',
      dataIndex: 'inspectionTime',
      width: 110,
      render: (v: string | null | undefined) => (v ? dayjs(v).format('YYYY-MM-DD') : '-'),
    },
    { title: '考察地点', dataIndex: 'inspectionPlace', width: 160, render: (v) => v || '-' },
    { title: '考察人员', dataIndex: 'inspectors', width: 160, render: (v) => v || '-' },
    {
      title: '考察照片',
      dataIndex: 'photos',
      width: 90,
      render: (v: InspectionPhoto[] | undefined) => `${v?.length ?? 0} 张`,
    },
    {
      title: '状态',
      dataIndex: 'statusLabel',
      width: 90,
      render: (_v, r) => (
        <Tag color={r.published ? 'green' : 'orange'}>{r.statusLabel ?? '编辑中'}</Tag>
      ),
    },
    {
      title: '更新时间',
      dataIndex: 'updatedAt',
      width: 150,
      render: (v: string | undefined) => (v ? dayjs(v).format('YYYY-MM-DD HH:mm') : '-'),
    },
    {
      title: '操作',
      key: 'action',
      width: 90,
      fixed: 'right',
      render: (_v, r) => (
        <Button type="link" size="small" onClick={() => openEdit(r)}>
          编辑
        </Button>
      ),
    },
  ];

  /* ---------------- 编辑视图 ---------------- */

  if (editing) {
    const isCreate = editing === 'create';
    return (
      <Space direction="vertical" size={12} style={{ width: '100%' }}>
        <Card size="small">
          <Space wrap>
            <Button icon={<ArrowLeftOutlined />} onClick={backToList}>
              返回列表
            </Button>
            <Tag color="cyan">考察报告</Tag>
            <Tag color={published ? 'green' : 'orange'}>
              状态：{published ? '已完成' : '编辑中'}
            </Tag>
            {detail?.publishedAt && (
              <span style={{ color: '#8c8c8c', fontSize: 12 }}>
                发布时间：{dayjs(detail.publishedAt).format('YYYY-MM-DD HH:mm')}
              </span>
            )}
          </Space>
        </Card>

        {published && (
          <Alert
            type="success"
            showIcon
            message="考察报告已发布（已完成）。内容修改后保存即可更新，也可撤回发布回到「编辑中」。"
          />
        )}

        <Card size="small" title="基本信息">
          <Row gutter={16} style={{ maxWidth: 960 }}>
            <Col span={12}>
              <div style={{ color: '#8c8c8c', fontSize: 12, marginBottom: 4 }}>
                考察单位名称 <span style={{ color: '#ff4d4f' }}>*</span>
              </div>
              <Input
                placeholder="请输入考察单位（供应商）名称"
                value={formValues.unitName}
                onChange={(e) => setFormValues((f) => ({ ...f, unitName: e.target.value }))}
              />
              <div style={{ color: '#8c8c8c', fontSize: 12, marginTop: 4 }}>
                即供应商名称，导出 Word 命名：{'{项目简称}-'}{'{供应商名称}'}-考察报告.docx
              </div>
            </Col>
            <Col span={6}>
              <div style={{ color: '#8c8c8c', fontSize: 12, marginBottom: 4 }}>考察时间</div>
              <DatePicker
                style={{ width: '100%' }}
                value={formValues.inspectionTime}
                onChange={(v) => setFormValues((f) => ({ ...f, inspectionTime: v }))}
              />
            </Col>
            <Col span={6}>
              <div style={{ color: '#8c8c8c', fontSize: 12, marginBottom: 4 }}>考察地点</div>
              <Input
                placeholder="请输入考察地点"
                value={formValues.inspectionPlace}
                onChange={(e) => setFormValues((f) => ({ ...f, inspectionPlace: e.target.value }))}
              />
            </Col>
            <Col span={24} style={{ marginTop: 12 }}>
              <div style={{ color: '#8c8c8c', fontSize: 12, marginBottom: 4 }}>考察人员</div>
              <Input
                placeholder="请输入考察人员（多人以顿号或逗号分隔）"
                value={formValues.inspectors}
                onChange={(e) => setFormValues((f) => ({ ...f, inspectors: e.target.value }))}
              />
            </Col>
          </Row>
        </Card>

        <Card size="small" title="考察内容">
          <RichTextEditor
            value={formValues.content}
            onChange={(html) => setFormValues((f) => ({ ...f, content: html }))}
            variableGroups={getProcurementVariableGroups(MODULE_TYPE)}
            minHeight={200}
            placeholder="请填写考察内容（可插入变量占位符）"
          />
        </Card>

        <Card size="small" title="考察结论">
          <RichTextEditor
            value={formValues.conclusion}
            onChange={(html) => setFormValues((f) => ({ ...f, conclusion: html }))}
            variableGroups={getProcurementVariableGroups(MODULE_TYPE)}
            minHeight={160}
            placeholder="请填写考察结论（可插入变量占位符）"
          />
        </Card>

        <Card
          size="small"
          title="考察照片"
          extra={<span style={{ color: '#8c8c8c', fontSize: 12 }}>支持多张上传（最多 20 张），导出 Word 时自动嵌入文档</span>}
        >
          <Upload
            accept="image/*"
            multiple
            listType="picture-card"
            fileList={fileList}
            customRequest={customRequest}
            onRemove={(file) => {
              setPhotos((prev) => prev.filter((_, i) => `photo-${i}` !== file.uid));
              return true;
            }}
          >
            {photos.length < 20 && (
              <div>
                <PlusOutlined />
                <div style={{ marginTop: 8 }}>上传照片</div>
              </div>
            )}
          </Upload>
          {uploadingCount > 0 && <span style={{ color: '#8c8c8c' }}>照片上传中…</span>}
        </Card>

        <Card size="small">
          <Space wrap>
            <Button icon={<SaveOutlined />} type="primary" loading={saving} onClick={handleSave}>
              保存
            </Button>
            <Tooltip title="按文档版式预览（变量已替换）">
              <Button icon={<EyeOutlined />} onClick={() => setModalMode('preview')}>
                预览
              </Button>
            </Tooltip>
            {!published && !isCreate && (
              <Button type="primary" icon={<SendOutlined />} onClick={openPublishPreview}>
                发布
              </Button>
            )}
            {published && (
              <Popconfirm
                title="确认撤回发布？"
                description="撤回后考察报告状态回到「编辑中」。"
                onConfirm={handleUnpublish}
              >
                <Button icon={<RollbackOutlined />}>撤回发布</Button>
              </Popconfirm>
            )}
            <Button icon={<DownloadOutlined />} onClick={handleExport}>
              导出 Word
            </Button>
          </Space>
        </Card>

        {/* 统一预览 / 发布流程（批次四 · 任务 4.2）：发布前确认与发布后预览共用 */}
        <PreviewPublishModal
          open={modalMode !== null}
          mode={modalMode ?? 'preview'}
          moduleType={MODULE_TYPE}
          docHtml={rawDocHtml}
          values={varValues}
          publishing={publishing}
          filename={exportFilename}
          confirmTitle="确认发布考察报告？"
          confirmDescription="发布前将自动保存当前内容；发布后状态变更为「已完成」，可随时撤回。"
          tipMessage="发布前将自动保存当前内容；发布后状态变更为「已完成」，可随时撤回。"
          onPublish={handlePublish}
          onClose={() => setModalMode(null)}
        />
      </Space>
    );
  }

  /* ---------------- 列表视图渲染 ---------------- */

  return (
    <Space direction="vertical" size={12} style={{ width: '100%' }}>
      <Card size="small">
        <Space wrap>
          <Button type="primary" icon={<PlusOutlined />} onClick={openCreate}>
            新建考察报告
          </Button>
          <Input.Search
            allowClear
            style={{ width: 280 }}
            placeholder="按考察单位名称搜索"
            value={keyword}
            onChange={(e) => setKeyword(e.target.value)}
            onSearch={(v) => loadList(v)}
          />
        </Space>
      </Card>

      <Card size="small" title="考察报告列表">
        <Table<ReportRow>
          size="small"
          rowKey="id"
          loading={loading}
          columns={columns}
          dataSource={rows}
          pagination={{ pageSize: 10, showTotal: (t) => `共 ${t} 条` }}
          scroll={{ x: 1100 }}
          locale={{ emptyText: <Empty description="暂无考察报告，点击「新建考察报告」创建" /> }}
        />
      </Card>
    </Space>
  );
}
