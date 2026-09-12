import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import {
  Alert,
  Button,
  Card,
  Col,
  DatePicker,
  Descriptions,
  InputNumber,
  Modal,
  Popconfirm,
  Row,
  Space,
  Spin,
  Table,
  Tooltip,
  message,
} from 'antd';
import type { ColumnsType } from 'antd/es/table';
import {
  EyeOutlined,
  FileWordOutlined,
  SaveOutlined,
  SendOutlined,
} from '@ant-design/icons';
import dayjs from 'dayjs';
import { procurementTaskApi } from '@/api/modules';
import { projectApi } from '@/api/business';
import { useAuthStore } from '@/store/auth';
import { taskStatusLabel, taskTypeLabel } from '@/constants/procurementWorkflow';
import {
  getProcurementVariableGroups,
} from '@/constants/procurementVariables';
import RichTextEditor from '@/components/RichTextEditor';
import PreviewPublishModal from '@/components/PreviewPublishModal';
import TaskViewModal from '@/components/procurement/TaskViewModal';
import ModuleListPage, {
  moduleStatusOf,
  type ModuleListFilterField,
  type ModuleListRow,
  useModuleDelete,
} from '@/components/procurement/ModuleListPage';
import { buildProcurementDoc, exportProcurementWord } from '@/utils/procurementExport';
import { highlightPlaceholders } from '@/utils/docExport';
import { exportTaskModuleWord } from '@/utils/procurementTaskDocs';
import {
  buildDocumentDocHtml,
  buildDocumentVariableValues,
  fmtAmount,
  stripHtml,
  sumAmount,
  type DocumentData,
  type DocumentPurchaseItem,
} from '@/utils/procurementDocument';

/** 模块类型（与采购模板 moduleType、变量占位符前缀一致） */
const MODULE_TYPE = 'DOCUMENT';
/** 补充四：合同模板预览/导出专用 moduleType（不对应任何采购模板，确保以合同模板内容为底稿） */
const CONTRACT_TPL_MODULE = 'CONTRACT_TEMPLATE';

/** 采购任务行（列表精简） */
interface TaskRow {
  id: string;
  taskNo: string;
  type: string;
  content: string;
  status: string;
  stage: number;
  preMeetingRequired: boolean;
}

/** 采购文件编辑字段 */
interface DocumentForm {
  /** 采购时间（日期） */
  procurementTime: string | null;
  /** 响应保证金（金额，元） */
  responseDeposit: number | null;
  /** 报价说明（富文本 HTML） */
  quoteDescription: string;
}

interface DocumentDetail {
  task: TaskRow;
  /** 采购文件阶段在阶段链中的下标 */
  stageIndex: number;
  /** 采购公告阶段下标 */
  noticeStageIndex: number;
  /** 采购公告是否已完成（本模块入口条件） */
  noticeCompleted: boolean;
  reached: boolean;
  editable: boolean;
  published: boolean;
  status: string;
  statusLabel: string;
  /** 来自采购公告的取值 */
  notice: {
    procurementNo: string;
    content: string;
    techQuality: string;
    acceptanceMethod: string;
    paymentMethod: string;
  } | null;
  /** 采购清单（只读，来自总采购清单；价格列留空） */
  purchaseItems: DocumentPurchaseItem[];
  data:
    | {
        id?: string;
        procurementTime?: string | null;
        responseDeposit?: number | null;
        quoteDescription?: string;
        publishedAt?: string | null;
      }
    | null;
}

const EMPTY_FORM: DocumentForm = {
  procurementTime: null,
  responseDeposit: null,
  quoteDescription: '',
};

/** 补充二/补充四：将采购发起填写的技术质量/验收/付款标准注入合同模板 HTML（替换占位符，无占位符时在末尾追加章节） */
function injectContractThreeFields(
  content: string,
  techQuality: string,
  acceptanceMethod: string,
  paymentMethod: string,
): string {
  let html = content || '';
  const map: Record<string, string> = {
    技术质量标准: techQuality,
    验收方式: acceptanceMethod,
    付款方式: paymentMethod,
  };
  for (const [k, v] of Object.entries(map)) {
    html = html.split(`{{${k}}}`).join(v || '');
  }
  // 模板未含对应占位符时，追加三字段章节，确保技术质量/验收/付款标准随合同模板导出（补充二）
  if (!html.includes('技术质量标准') && (techQuality || acceptanceMethod || paymentMethod)) {
    html +=
      '<h2>技术质量标准、验收方式与付款方式</h2>' +
      `<p><strong>技术质量标准：</strong></p>${techQuality || ''}` +
      `<p><strong>验收方式：</strong></p>${acceptanceMethod || ''}` +
      `<p><strong>付款方式：</strong></p>${paymentMethod || ''}`;
  }
  return html;
}

export default function Document() {
  const [searchParams, setSearchParams] = useSearchParams();
  const currentProjectId = useAuthStore((s) => s.currentProjectId);

  const [taskId, setTaskId] = useState<string | null>(searchParams.get('taskId') || null);
  /** 列表刷新键：编辑弹窗关闭后重查，反映最新模块状态 */
  const [listRefresh, setListRefresh] = useState(0);
  /** 问题二：删除模块记录并回退流程 */
  const handleDeleteModule = useModuleDelete('DOCUMENT', () => setListRefresh((k) => k + 1));

  const [detail, setDetail] = useState<DocumentDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);

  const [form, setForm] = useState<DocumentForm>(EMPTY_FORM);
  const [saving, setSaving] = useState(false);
  const [publishing, setPublishing] = useState(false);
  /** 发布后默认只读；点「重新编辑」解锁 */
  const [reEditing, setReEditing] = useState(false);
  /** 统一预览/发布弹窗（批次四 · 任务 4.2）：publish=发布前确认；preview=纯预览 */
  const [modalMode, setModalMode] = useState<'preview' | 'publish' | null>(null);
  /** 编辑弹窗（问题一：未填写/编辑中行「编辑」直接进入；带 taskId 进入页面时直接打开） */
  const [editOpen, setEditOpen] = useState(!!searchParams.get('taskId'));
  /** 任务查看弹窗（问题一：已完成行「查看」→ 任务信息+采购明细+Word 文档） */
  const [viewRow, setViewRow] = useState<ModuleListRow | null>(null);
  /** 重新编辑标记：loadDetail 完成后按此恢复可编辑（已发布行「重新编辑」） */
  const reEditRef = useRef(false);
  /** 补充四：合同模板预览 */
  const [contractPreviewOpen, setContractPreviewOpen] = useState(false);
  const [contractHtml, setContractHtml] = useState('');

  const [project, setProject] = useState<{
    name?: string;
    nameAbbr?: string;
    undertaker?: string;
    provinceCity?: string;
    siteLocation?: string;
    projectAddress?: string;
  }>({});

  const currentTask = detail?.task ?? null;
  /** 当前是否可编辑：采购文件编制中，或已发布后主动点「重新编辑」 */
  const editable = !!detail && (detail.editable || (detail.published && reEditing));
  /** 采购内容（默认取采购公告内容 / 采购任务内容） */
  const content = detail?.notice?.content || currentTask?.content || '';

  /** 采购清单（只读） */
  const purchaseItems = useMemo(() => detail?.purchaseItems ?? [], [detail]);

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
      .document(id)
      .then((res: any) => {
        const d: DocumentDetail = res?.data ?? res;
        setDetail(d);
        const data = (d?.data ?? {}) as NonNullable<DocumentDetail['data']>;
        setForm({
          procurementTime: data.procurementTime
            ? dayjs(data.procurementTime).format('YYYY-MM-DD')
            : null,
          responseDeposit: data.responseDeposit ?? null,
          quoteDescription: data.quoteDescription ?? '',
        });
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
      const filename = await exportTaskModuleWord(MODULE_TYPE, row.id);
      message.success(`已导出：${filename}`);
    } catch (e: any) {
      message.error(e?.message || '导出失败，请稍后重试');
    }
  };

  const patchForm = (patch: Partial<DocumentForm>) => setForm((f) => ({ ...f, ...patch }));

  /* ---------------- 保存 / 发布 / 导出 ---------------- */

  const buildSavePayload = () => ({
    procurementTime: form.procurementTime || null,
    responseDeposit: form.responseDeposit,
    quoteDescription: form.quoteDescription,
  });

  const handleSave = async () => {
    if (!taskId) return;
    setSaving(true);
    try {
      await procurementTaskApi.saveDocument(taskId, buildSavePayload());
      message.success('已保存');
      setEditOpen(false);
      loadDetail(taskId);
    } finally {
      setSaving(false);
    }
  };

  /** 发布流程第 1 步：校验必填 → 打开「发布前预览」 */
  const openPublishPreview = () => {
    if (!form.procurementTime) {
      message.warning('请先选择「采购时间」再发布');
      return;
    }
    if (form.responseDeposit == null) {
      message.warning('请先填写「响应保证金」再发布');
      return;
    }
    setModalMode('publish');
  };

  /** 发布流程第 2 步：确认发布（先落库当前编辑内容） */
  const handlePublish = async () => {
    if (!taskId) return;
    setPublishing(true);
    try {
      await procurementTaskApi.saveDocument(taskId, buildSavePayload());
      await procurementTaskApi.publish(taskId);
      message.success('已发布，采购文件状态变更为「已完成」');
      setModalMode(null);
      closeEdit();
    } finally {
      setPublishing(false);
    }
  };

  const docData = useMemo<DocumentData>(
    () => ({
      procurementTime: form.procurementTime,
      responseDeposit: form.responseDeposit,
      quoteDescription: form.quoteDescription,
      purchaseItems,
    }),
    [form, purchaseItems],
  );

  const docCtx = useMemo(
    () => ({
      projectName: project.name,
      projectAbbr: project.nameAbbr,
      undertaker: project.undertaker,
      provinceCity: project.provinceCity,
      siteLocation: project.siteLocation,
      projectAddress: project.projectAddress,
      content,
      procurementNo: detail?.notice?.procurementNo,
      techQuality: detail?.notice?.techQuality,
      acceptanceMethod: detail?.notice?.acceptanceMethod,
      paymentMethod: detail?.notice?.paymentMethod,
    }),
    [project, content, detail],
  );

  /** 模块内置文档 HTML（含 {{占位符}}，未替换；统一管线内完成模板优先与变量替换） */
  const rawDocHtml = useMemo(() => {
    if (!currentTask) return '';
    const title = `${project.nameAbbr || project.name || ''}-${content}-采购文件`;
    return buildDocumentDocHtml(docData, docCtx, title);
  }, [docData, docCtx, currentTask, project, content]);

  /** 变量取值（统一预览 / 导出共用） */
  const varValues = useMemo(
    () => buildDocumentVariableValues(docData, docCtx),
    [docData, docCtx],
  );

  const exportFilename = `${project.nameAbbr || project.name || '项目'}-${content}-采购文件.docx`;

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

  /**
   * 补充四：拉取「与采购文件关联的合同模板」内容，并把采购发起填写的
   * 技术质量/验收/付款标准注入（替换占位符或追加章节），返回注入后 HTML 与导出文件名。
   */
  const getContractTemplateHtml = useCallback(async (): Promise<{ html: string; filename: string }> => {
    if (!taskId) return { html: '', filename: '' };
    const res: any = await procurementTaskApi.contractTemplate(taskId);
    const ct = res?.data ?? res ?? {};
    const injected = injectContractThreeFields(
      ct?.content || '',
      ct?.techQuality || '',
      ct?.acceptanceMethod || '',
      ct?.paymentMethod || '',
    );
    const tmplName = ct?.templateName || '合同模板';
    const filename = `${project.nameAbbr || project.name || '项目'}-${content}-${tmplName}.docx`;
    return { html: injected, filename };
  }, [taskId, project.nameAbbr, project.name, content]);

  /** 补充四：预览采购合同模板（注入三标准后渲染） */
  const handlePreviewContractTemplate = async () => {
    if (!taskId) return;
    try {
      const { html } = await getContractTemplateHtml();
      const built = await buildProcurementDoc(
        { moduleType: CONTRACT_TPL_MODULE, docHtml: html, values: {} },
        { inlineImages: false },
      );
      setContractHtml(built.html || html);
      setContractPreviewOpen(true);
    } catch (e: any) {
      message.error(e?.message || '合同模板预览失败');
    }
  };

  /** 补充四：导出采购合同模板 Word（注入三标准后导出） */
  const handleExportContractTemplate = async () => {
    if (!taskId) return;
    try {
      const { html, filename } = await getContractTemplateHtml();
      await exportProcurementWord({
        moduleType: CONTRACT_TPL_MODULE,
        docHtml: html,
        values: {},
        filename,
      });
      message.success(`已导出：${filename}`);
    } catch (e: any) {
      message.error(e?.message || '合同模板导出失败');
    }
  };

  /* ---------------- 采购清单（只读）列 ---------------- */

  /** 价格类列由投标方填写，系统内留空 */
  const priceCell = (v: number | null | undefined) => (v == null ? '-' : fmtAmount(v));

  const purchaseColumns: ColumnsType<DocumentPurchaseItem> = [
    { title: '序号', width: 56, render: (_v, _r, i) => i + 1 },
    { title: '物资名称', dataIndex: 'materialName', render: (v: string | null) => v || '-' },
    { title: '规格型号', dataIndex: 'spec', render: (v: string | null) => v || '-' },
    { title: '计量单位', dataIndex: 'unit', width: 90, render: (v: string | null) => v || '-' },
    {
      title: '暂定数量',
      dataIndex: 'qty',
      width: 100,
      render: (v: number | null) => (v != null ? Number(v).toLocaleString('zh-CN') : '-'),
    },
    // 以下四列留空（由投标方填写）
    { title: '税前单价', dataIndex: 'preTaxPrice', width: 100, render: priceCell },
    { title: '税率', dataIndex: 'taxRate', width: 80, render: priceCell },
    { title: '综合单价', dataIndex: 'unitPrice', width: 100, render: priceCell },
    { title: '合价', dataIndex: 'amount', width: 110, render: priceCell },
    { title: '备注', dataIndex: 'remark', width: 140, render: (v: string | null) => v || '-' },
  ];

  /* ---------------- 渲染 ---------------- */

  /** 采购文件模块特有筛选项 */
  const extraFilters: ModuleListFilterField[] = [{ key: 'procTime', label: '采购时间', control: 'dateRange' }];

  /** 采购文件模块特有表格列 */
  const extraColumns: ColumnsType<ModuleListRow> = [
    {
      title: '采购时间',
      key: 'procurementTime',
      width: 120,
      render: (_v, row) =>
        row.module?.procurementTime ? dayjs(row.module.procurementTime).format('YYYY-MM-DD') : '-',
    },
    {
      title: '响应保证金（元）',
      key: 'responseDeposit',
      width: 140,
      render: (_v, row) =>
        row.module?.responseDeposit != null
          ? Number(row.module.responseDeposit).toLocaleString('zh-CN')
          : '-',
    },
  ];

  return (
    <Space direction="vertical" size={12} style={{ width: '100%' }}>
      {/* 标准列表页（批次五）：筛选区 + 工具栏 + 数据表格 */}
      <ModuleListPage
        moduleKey="DOCUMENT"
        baseParams={{ type: 'SINGLE' }}
        extraFilters={extraFilters}
        extraColumns={extraColumns}
        toolbarLeft={
          <span style={{ color: '#8c8c8c', fontSize: 13 }}>
            仅显示单项采购类型的任务；编辑与发布以任务所处阶段为准（需先完成采购公告）
          </span>
        }
        refreshKey={listRefresh}
        onView={handleViewRow}
        onEdit={editRow}
        onDelete={handleDeleteModule}
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
        title={`采购文件 · 编辑${currentTask ? ` · ${currentTask.taskNo}` : ''}`}
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
                预览采购文件
              </Button>
            )}
            {currentTask && (
              <Button icon={<FileWordOutlined />} onClick={handleExport}>
                导出采购文件
              </Button>
            )}
            {currentTask && (
              <Button icon={<EyeOutlined />} onClick={handlePreviewContractTemplate}>
                预览合同模板
              </Button>
            )}
            {currentTask && (
              <Button icon={<FileWordOutlined />} onClick={handleExportContractTemplate}>
                导出合同模板
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
              {detail && !detail.reached && (
                <Alert
                  type="info"
                  showIcon
                  message="该采购任务尚未进入采购文件阶段（需先完成采购公告）。"
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
                <Descriptions.Item label="采购编号">
                  {detail?.notice?.procurementNo || '-'}
                </Descriptions.Item>
                <Descriptions.Item label="采购时间">{form.procurementTime || '-'}</Descriptions.Item>
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

            {/* 一、采购文件基本信息 */}
            <Card size="small" title="一、采购文件基本信息">
              <Row gutter={[16, 16]}>
                <Col span={8}>
                  <div style={{ color: '#8c8c8c', fontSize: 12, marginBottom: 4 }}>采购时间</div>
                  {editable ? (
                    <DatePicker
                      style={{ width: '100%' }}
                      value={form.procurementTime ? dayjs(form.procurementTime) : null}
                      onChange={(d) =>
                        patchForm({ procurementTime: d ? d.format('YYYY-MM-DD') : null })
                      }
                    />
                  ) : (
                    <div style={{ minHeight: 22 }}>{form.procurementTime || '-'}</div>
                  )}
                </Col>
                <Col span={8}>
                  <div style={{ color: '#8c8c8c', fontSize: 12, marginBottom: 4 }}>
                    响应保证金（元）
                  </div>
                  {editable ? (
                    <InputNumber
                      style={{ width: '100%' }}
                      min={0}
                      precision={2}
                      placeholder="请输入响应保证金金额"
                      value={form.responseDeposit}
                      onChange={(v) => patchForm({ responseDeposit: v ?? null })}
                    />
                  ) : (
                    <div style={{ minHeight: 22 }}>
                      {form.responseDeposit == null ? '-' : `${fmtAmount(form.responseDeposit)} 元`}
                    </div>
                  )}
                </Col>
                <Col span={8}>
                  <div style={{ color: '#8c8c8c', fontSize: 12, marginBottom: 4 }}>采购编号</div>
                  <div style={{ minHeight: 22 }}>{detail?.notice?.procurementNo || '-'}</div>
                </Col>
              </Row>
            </Card>

            {/* 二、采购清单（只读，来自总采购清单） */}
            <Card
              size="small"
              title="二、采购清单"
              extra={
                <span style={{ color: '#8c8c8c', fontSize: 12 }}>
                  数据来自总采购清单，不可编辑；价格列由投标方填写
                </span>
              }
            >
              <Table
                size="small"
                rowKey={(_r, i) => String(i)}
                columns={purchaseColumns}
                dataSource={purchaseItems}
                pagination={false}
                scroll={{ x: 1100 }}
                locale={{ emptyText: '暂无数据（总采购清单为空或尚未编制）' }}
                summary={() =>
                  purchaseItems.length ? (
                    <>
                      <Table.Summary.Row>
                        <Table.Summary.Cell index={0} colSpan={8} align="center">
                          <strong>合价合计</strong>
                        </Table.Summary.Cell>
                        <Table.Summary.Cell index={8}>
                          <strong>{sumAmount(purchaseItems) || '-'}</strong>
                        </Table.Summary.Cell>
                        <Table.Summary.Cell index={9} />
                      </Table.Summary.Row>
                      <Table.Summary.Row>
                        <Table.Summary.Cell index={0} colSpan={2} align="center">
                          <strong>报价说明</strong>
                        </Table.Summary.Cell>
                        <Table.Summary.Cell index={2} colSpan={8}>
                          {stripHtml(form.quoteDescription) || '-'}
                        </Table.Summary.Cell>
                      </Table.Summary.Row>
                    </>
                  ) : null
                }
              />
            </Card>

            {/* 三、报价说明（富文本） */}
            <Card size="small" title="三、报价说明">
              <RichTextEditor
                value={form.quoteDescription}
                onChange={(html) => patchForm({ quoteDescription: html })}
                variableGroups={getProcurementVariableGroups(MODULE_TYPE)}
                disabled={!editable}
                minHeight={200}
                placeholder="请填写报价说明"
              />
            </Card>

          </Space>
          )}
        </Spin>
      </Modal>

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
        confirmTitle="确认发布采购文件？"
        confirmDescription="发布前将自动保存当前内容；发布后状态变更为「已完成」，任务状态流转到下一阶段。"
        tipMessage="请核对采购文件内容与采购清单，确认无误后点击「确认发布」。"
        onPublish={handlePublish}
        onClose={() => setModalMode(null)}
      />

      {/* 补充四：合同模板预览（注入技术质量/验收/付款标准后渲染，与导出所见即所得） */}
      <Modal
        title={`合同模板 · 预览${currentTask ? ` · ${currentTask.taskNo}` : ''}`}
        width={1000}
        centered
        open={contractPreviewOpen}
        onCancel={() => setContractPreviewOpen(false)}
        styles={{ body: { maxHeight: 'calc(100vh - 220px)', overflowY: 'auto' } }}
        footer={
          <Space style={{ float: 'right' }}>
            <Button onClick={() => setContractPreviewOpen(false)}>关闭</Button>
            <Button icon={<FileWordOutlined />} onClick={handleExportContractTemplate}>
              导出合同模板
            </Button>
          </Space>
        }
      >
        <div
          style={{
            maxHeight: '60vh',
            minHeight: 120,
            overflow: 'auto',
            border: '1px solid #eee',
            padding: 24,
          }}
          dangerouslySetInnerHTML={{
            __html: highlightPlaceholders(contractHtml) || '<p style="color:#999">暂无内容</p>',
          }}
        />
      </Modal>
    </Space>
  );
}
