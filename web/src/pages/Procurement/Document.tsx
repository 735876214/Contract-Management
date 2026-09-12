import { useCallback, useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import {
  Alert,
  Button,
  Card,
  Col,
  DatePicker,
  Descriptions,
  Empty,
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
} from '@/constants/procurementVariables';
import RichTextEditor from '@/components/RichTextEditor';
import PreviewPublishModal from '@/components/PreviewPublishModal';
import { exportProcurementWord } from '@/utils/procurementExport';
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

export default function Document() {
  const [searchParams, setSearchParams] = useSearchParams();
  const currentProjectId = useAuthStore((s) => s.currentProjectId);

  const [tasks, setTasks] = useState<TaskRow[]>([]);
  const [tasksLoading, setTasksLoading] = useState(true);
  const [taskId, setTaskId] = useState<string | null>(searchParams.get('taskId') || null);

  const [detail, setDetail] = useState<DocumentDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);

  const [form, setForm] = useState<DocumentForm>(EMPTY_FORM);
  const [saving, setSaving] = useState(false);
  const [publishing, setPublishing] = useState(false);
  /** 发布后默认只读；点「重新编辑」解锁 */
  const [reEditing, setReEditing] = useState(false);
  /** 统一预览/发布弹窗（批次四 · 任务 4.2）：publish=发布前确认；preview=纯预览 */
  const [modalMode, setModalMode] = useState<'preview' | 'publish' | null>(null);

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

  /** 仅「采购公告已完成」（采购文件编制中）的任务可进入编辑 */
  const documentTasks = useMemo(
    () => tasks.filter((t) => t.status === 'DOCUMENT_EDITING'),
    [tasks],
  );
  /** 采购清单（只读） */
  const purchaseItems = useMemo(() => detail?.purchaseItems ?? [], [detail]);

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
        setReEditing(false);
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

  const selectTask = (id: string) => {
    setTaskId(id);
    setSearchParams({ taskId: id }, { replace: true });
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
      loadDetail(taskId);
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

  return (
    <Space direction="vertical" size={12} style={{ width: '100%' }}>
      <Card size="small">
        <Space wrap>
          <Select
            showSearch
            optionFilterProp="label"
            style={{ width: 460 }}
            placeholder="选择采购任务（仅显示采购公告已完成的任务）"
            loading={tasksLoading}
            value={taskId ?? undefined}
            onChange={selectTask}
            options={documentTasks.map((t) => ({
              value: t.id,
              label: `${t.taskNo} · ${t.content}`,
            }))}
            notFoundContent={
              tasksLoading
                ? '加载中…'
                : '暂无可编辑任务（需先完成采购公告，任务状态为「采购文件编制中」）'
            }
          />
          {currentTask && (
            <>
              <Tag color="cyan">{taskTypeLabel(currentTask.type)}</Tag>
              <Tag color={detail?.published ? 'green' : 'orange'}>
                采购文件：{detail?.statusLabel ?? '编辑中'}
              </Tag>
              <Tag>{taskStatusLabel(currentTask.status)}</Tag>
            </>
          )}
        </Space>
      </Card>

      <Spin spinning={detailLoading}>
        {!currentTask ? (
          <Card>
            <Empty description="请先在上方选择「采购公告已完成」的采购任务" />
          </Card>
        ) : (
          <Space direction="vertical" size={12} style={{ width: '100%' }}>
            {detail?.published && !editable && (
              <Alert
                type="success"
                showIcon
                message="采购文件已发布（已完成）。可预览、导出 Word，或点击「重新编辑」修改内容。"
                action={
                  <Button size="small" onClick={() => setReEditing(true)}>
                    重新编辑
                  </Button>
                }
              />
            )}
            {detail?.published && editable && (
              <Alert
                type="warning"
                showIcon
                message="重新编辑模式：修改后请保存，发布状态保持「已完成」。"
              />
            )}
            {detail && !detail.reached && (
              <Alert
                type="info"
                showIcon
                message="该采购任务尚未进入采购文件阶段（需先完成采购公告）。"
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

            {/* 操作 */}
            <Card size="small">
              <Space wrap>
                {editable && (
                  <Button icon={<SaveOutlined />} loading={saving} onClick={handleSave}>
                    保存
                  </Button>
                )}
                <Tooltip title="按文档版式预览（变量已替换）">
                  <Button icon={<EyeOutlined />} onClick={() => setModalMode('preview')}>
                    预览
                  </Button>
                </Tooltip>
                {detail?.editable && (
                  <Button type="primary" icon={<SendOutlined />} onClick={openPublishPreview}>
                    发布
                  </Button>
                )}
                <Button icon={<DownloadOutlined />} onClick={handleExport}>
                  导出 Word
                </Button>
              </Space>
            </Card>
          </Space>
        )}
      </Spin>

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
    </Space>
  );
}
