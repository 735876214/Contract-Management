import { useMemo } from 'react';
import { formatNumber } from '@/utils/money';
import { Alert, Button, Card, Col, DatePicker, Descriptions, Input, Row, Space, Spin, Table } from 'antd';
import { message } from '@/utils/antdStatic';
import type { ColumnsType } from 'antd/es/table';
import { DeleteOutlined, EyeOutlined, FileWordOutlined, PlusOutlined, SendOutlined } from '@ant-design/icons';
import dayjs from 'dayjs';
import { procurementTaskApi } from '@/api/modules';
import { taskStatusLabel, taskTypeLabel } from '@/constants/procurementWorkflow';
import RichTextEditor from '@/components/RichTextEditor';
import PreviewPublishModal from '@/components/PreviewPublishModal';
import TaskViewModal from '@/components/procurement/TaskViewModal';
import ModuleListPage, { moduleStatusOf, type ModuleListFilterField, type ModuleListRow } from '@/components/procurement/ModuleListPage';
import { exportProcurementWord } from '@/utils/procurementExport';
import EditorTabPage from '@/components/editor/EditorTabPage';
import { useProcurementStageForm } from '@/hooks/useProcurementStageForm';

/** 列表与编辑器是同一路由的两种形态（`?editor=<taskId>`），见 `useEditorTab` 的注释 */
const LIST_PATH = '/procurement/notice';
import { buildNoticeDocHtml, buildNoticeVariableValues, contactEntries, type NoticeData, type NoticePurchaseItem } from '@/utils/procurementNotice';

/** 模块类型（与采购模板 moduleType、变量占位符前缀一致） */
const MODULE_TYPE = 'NOTICE';

/** 采购任务行（列表精简） */
interface TaskRow {
  id: string;
  taskNo: string;
  type: string;
  content: string;
  status: string;
  stage: number;
  preMeetingRequired: boolean;
  /** 补充二：采购发起填写、随任务下发的三个标准（公告/文件/合同模板只读引用） */
  techQuality?: string;
  acceptanceMethod?: string;
  paymentMethod?: string;
}

/** 可编辑行：带前端 key 供 Table 渲染（保存时剔除） */
type Keyed<T> = T & { key: string };

/** 联系人 / 联系电话（成对动态增加，按位置自动编号 联系人1 / 联系电话1） */
interface ContactRow {
  name: string;
  phone: string;
}

interface NoticeForm {
  procurementNo: string;
  procurementTime: string | null;
  content: string;
  contacts: Keyed<ContactRow>[];
}

interface NoticeDetail {
  task: TaskRow;
  /** 公告阶段在阶段链中的下标 */
  stageIndex: number;
  /** 是否已进入或完成公告阶段 */
  reached: boolean;
  editable: boolean;
  published: boolean;
  status: string;
  statusLabel: string;
  /** 采购清单（只读，来自总采购清单） */
  purchaseItems: NoticePurchaseItem[];
  data:
    | (Omit<NoticeForm, 'contacts'> & {
        id?: string;
        contacts?: string[];
        contactPhones?: string[];
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
/** 联系人列表至少保留一行，便于直接录入 */
const normalizeContacts = (rows: Keyed<ContactRow>[]): Keyed<ContactRow>[] =>
  rows.length ? rows : withKeys<ContactRow>([{ name: '', phone: '' }]);

const EMPTY_FORM: NoticeForm = {
  procurementNo: '',
  procurementTime: null,
  content: '',
  contacts: withKeys<ContactRow>([{ name: '', phone: '' }]),
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
      <div style={{ color: 'var(--cms-muted-soft)', fontSize: 12, marginBottom: 4 }}>{label}</div>
      {editable ? (
        <Input value={value} placeholder={placeholder ?? `请填写${label}`} onChange={(e) => onChange(e.target.value)} />
      ) : (
        <div style={{ minHeight: 22 }}>{value || '-'}</div>
      )}
    </div>
  );
}

/** 详情 → 表单（采购公告） */
function noticeInitForm(d: NoticeDetail): NoticeForm {
  const data = (d?.data ?? {}) as NonNullable<NoticeDetail['data']>;
  return {
    procurementNo: data.procurementNo || String(d?.task?.taskNo ?? ''),
    procurementTime: data.procurementTime ? dayjs(data.procurementTime).format('YYYY-MM-DD') : null,
    // 采购内容默认带出采购任务内容
    content: data.content || String(d?.task?.content ?? ''),
    contacts: normalizeContacts(withKeys(contactEntries(data.contacts ?? [], data.contactPhones ?? []))),
  };
}

export default function Notice() {
  const sf = useProcurementStageForm<NoticeDetail, NoticeForm>({
    moduleType: MODULE_TYPE,
    listPath: LIST_PATH,
    load: (id) => procurementTaskApi.notice(id) as unknown as Promise<NoticeDetail>,
    initForm: noticeInitForm,
    buildSavePayload: (form) => ({
      procurementNo: form.procurementNo,
      procurementTime: form.procurementTime || null,
      content: form.content,
      contacts: form.contacts.map((r) => String(r.name ?? '').trim()),
      contactPhones: form.contacts.map((r) => String(r.phone ?? '').trim()),
    }),
    save: (id, payload) => procurementTaskApi.saveNotice(id, payload as any),
    emptyForm: EMPTY_FORM,
    validatePublish: (form) => {
      if (!String(form.procurementNo ?? '').trim()) return '请先填写「采购编号」再发布';
      if (!form.procurementTime) return '请先选择「采购时间」再发布';
      if (!String(form.content ?? '').trim()) return '请先填写「采购内容」再发布';
      return null;
    },
    publishSuccessMessage: '已发布，采购公告状态变更为「已完成」',
  });
  const {
    tabRefresh,
    taskId,
    listRefresh,
    handleDeleteModule,
    handleViewRow,
    editRow,
    handleRowExport,
    detail,
    detailLoading,
    form,
    patchForm,
    currentTask: currentTaskRaw,
    editable,
    dirty,
    saving,
    publishing,
    modalMode,
    setModalMode,
    openPublishPreview,
    handlePublish,
    handleSave,
    project,
    viewRow,
    setViewRow,
  } = sf;
  const setForm = sf.setForm;
  const currentTask = currentTaskRaw as NoticeDetail['task'] | null;

  /* ---------------- 联系人 / 联系电话（动态增加） ---------------- */

  const updateContact = (key: string, patch: Partial<ContactRow>) =>
    setForm((f) => ({
      ...f,
      contacts: f.contacts.map((r) => (r.key === key ? { ...r, ...patch } : r)),
    }));

  const addContact = () =>
    setForm((f) => ({ ...f, contacts: [...f.contacts, { key: nextKey(), name: '', phone: '' }] }));

  const removeContact = (key: string) =>
    setForm((f) => ({ ...f, contacts: normalizeContacts(f.contacts.filter((r) => r.key !== key)) }));

  /** 文档数据（联系人转事件对数组） */
  const docData = useMemo<NoticeData>(
    () => ({
      procurementNo: form.procurementNo,
      procurementTime: form.procurementTime,
      content: form.content,
      // 补充二：技术质量/验收/付款标准取自采购发起填写的任务三字段（只读）
      techQuality: currentTask?.techQuality ?? '',
      acceptanceMethod: currentTask?.acceptanceMethod ?? '',
      paymentMethod: currentTask?.paymentMethod ?? '',
      contacts: form.contacts.map((r) => String(r.name ?? '').trim()),
      contactPhones: form.contacts.map((r) => String(r.phone ?? '').trim()),
      purchaseItems: detail?.purchaseItems ?? [],
    }),
    [form, detail, currentTask],
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
    }),
    [project, currentTask],
  );

  /** 模块内置文档 HTML（含 {{占位符}}，未替换；统一管线内完成模板优先与变量替换） */
  const rawDocHtml = useMemo(() => {
    if (!currentTask) return '';
    const content = docData.content || currentTask.content;
    const title = `${project.nameAbbr || project.name || ''}-${content}-采购公告`;
    // {{采购公告-采购清单}} / {{采购编号}} / {{采购时间}} / {{联系人1}} / {{联系电话1}} 等
    return buildNoticeDocHtml(docData, docCtx, title);
  }, [docData, docCtx, currentTask, project]);

  /** 变量取值（统一预览 / 导出共用） */
  const varValues = useMemo(
    () => buildNoticeVariableValues(docData, docCtx),
    [docData, docCtx],
  );

  const exportFilename = `${
    project.nameAbbr || project.name || '项目'
  }-${form.content || currentTask?.content || '采购'}-采购公告.docx`;

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

  const purchaseColumns: ColumnsType<NoticePurchaseItem> = [
    { title: '序号', width: 60, render: (_v, _r, i) => i + 1 },
    { title: '物资名称', dataIndex: 'materialName', render: (v: string | null) => v || '-' },
    { title: '规格型号', dataIndex: 'spec', render: (v: string | null) => v || '-' },
    { title: '计量单位', dataIndex: 'unit', width: 110, render: (v: string | null) => v || '-' },
    {
      title: '暂定数量',
      dataIndex: 'qty',
      width: 130,
      render: (v: number | null) => (v != null ? formatNumber(v) : '-'),
    },
    { title: '备注', dataIndex: 'remark', width: 160, render: (v: string | null) => v || '-' },
  ];

  /* ---------------- 渲染 ---------------- */

  const richSection = (
    label: string,
    field: 'techQuality' | 'acceptanceMethod' | 'paymentMethod',
  ) => (
    <Card
      size="small"
      title={label}
      extra={<span style={{ color: 'var(--cms-muted-soft)', fontSize: 12 }}>取自采购发起填写的标准（只读）</span>}
    >
      <RichTextEditor
        value={currentTask?.[field] ?? ''}
        disabled
        minHeight={180}
        placeholder="（采购发起未填写技术质量/验收/付款标准）"
      />
    </Card>
  );

  /** 公告模块特有筛选项 */
  const extraFilters: ModuleListFilterField[] = [
    { key: 'procTime', label: '采购时间', control: 'dateRange' },
    { key: 'contact', label: '联系人', control: 'input' },
  ];

  /** 公告模块特有表格列 */
  const extraColumns: ColumnsType<ModuleListRow> = [
    {
      title: '采购时间',
      key: 'procurementTime',
      width: 120,
      render: (_v, row) =>
        row.module?.procurementTime ? dayjs(row.module.procurementTime).format('YYYY-MM-DD') : '-',
    },
    {
      title: '联系人',
      key: 'contacts',
      width: 150,
      ellipsis: { showTitle: true },
      render: (_v, row) =>
        Array.isArray(row.module?.contacts) && row.module.contacts.length
          ? row.module.contacts.join('、')
          : '-',
    },
  ];

  return (
    <Space direction="vertical" size={12} style={{ width: '100%' }}>
      {/* 标准列表页（批次五）：筛选区 + 工具栏 + 数据表格 */}
      <ModuleListPage
        moduleKey="NOTICE"
        baseParams={{ type: 'SINGLE' }}
        extraFilters={extraFilters}
        extraColumns={extraColumns}
        toolbarLeft={
          <span style={{ color: 'var(--cms-muted-soft)', fontSize: 13 }}>
            仅显示单项采购类型的任务；编辑与发布以任务所处阶段为准
          </span>
        }
        refreshKey={listRefresh + tabRefresh}
        editPermission="procurement:edit"
        onView={handleViewRow}
        onEdit={editRow}
        onDelete={handleDeleteModule}
        rowMenuItems={(row, { canEdit }) => {
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
                ...(canEdit ? [{ key: 'reEdit', label: '重新编辑', onClick: () => editRow(row, true) }] : []),
              ]
            : [];
        }}
      />

      {/* 任务查看弹窗（问题一：已完成行「查看」→ 居中弹窗：任务信息+采购明细+Word 文档） */}
      <TaskViewModal task={viewRow} open={!!viewRow} onClose={() => setViewRow(null)} />

      {/* 编辑弹窗（问题一：未填写/编辑中行「编辑」直接进入；问题三：居中弹窗） */}
      {/* 编辑器页签（未填写/编辑中行「编辑」直接进入；底部操作栏 sticky） */}
      {taskId && (
        <EditorTabPage
          listPath={LIST_PATH}
          title={`采购公告 · 编辑${currentTask ? ` · ${currentTask.taskNo}` : ''}`}
          saving={saving}
          saveText="保 存"
          onSave={editable ? handleSave : undefined}
          // 本页有独立的「发布」流程，保存不关标签
          closeOnSave={false}
          dirty={dirty}
          footerLeft={
            <Space wrap size={8}>
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
            </Space>
          }
          footerExtra={
            detail && !detail.published && editable ? (
              <Button type="primary" icon={<SendOutlined />} onClick={openPublishPreview}>
                发布
              </Button>
            ) : null
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
                  message="该采购任务尚未进入采购公告阶段（需先发布总采购清单，如有采前会会议纪要亦需先发布）。"
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
                <Descriptions.Item label="采购内容">{form.content || currentTask.content}</Descriptions.Item>
                <Descriptions.Item label="采购编号">{form.procurementNo || '-'}</Descriptions.Item>
                <Descriptions.Item label="采购时间">{form.procurementTime || '-'}</Descriptions.Item>
                <Descriptions.Item label="采购类型">{taskTypeLabel(currentTask.type)}</Descriptions.Item>
                <Descriptions.Item label="任务状态">{taskStatusLabel(currentTask.status)}</Descriptions.Item>
                <Descriptions.Item label="发布时间">
                  {detail?.data?.publishedAt ? dayjs(detail.data.publishedAt).format('YYYY-MM-DD HH:mm') : '-'}
                </Descriptions.Item>
              </Descriptions>
            </Card>

            {/* 一、公告基本信息 */}
            <Card size="small" title="一、公告基本信息">
              <Row gutter={[16, 16]}>
                <Col xs={24} md={8}>
                  <Field
                    label="采购编号"
                    value={form.procurementNo}
                    editable={editable}
                    onChange={(v) => patchForm({ procurementNo: v })}
                  />
                </Col>
                <Col xs={24} md={8}>
                  <div style={{ color: 'var(--cms-muted-soft)', fontSize: 12, marginBottom: 4 }}>采购时间</div>
                  {editable ? (
                    <DatePicker
                      style={{ width: '100%' }}
                      value={form.procurementTime ? dayjs(form.procurementTime) : null}
                      onChange={(d) => patchForm({ procurementTime: d ? d.format('YYYY-MM-DD') : null })}
                    />
                  ) : (
                    <div style={{ minHeight: 22 }}>{form.procurementTime || '-'}</div>
                  )}
                </Col>
                <Col xs={24} md={8}>
                  <Field
                    label="采购内容"
                    value={form.content}
                    editable={editable}
                    onChange={(v) => patchForm({ content: v })}
                  />
                </Col>
                <Col xs={24}>
                  <div style={{ color: 'var(--cms-muted-soft)', fontSize: 12, marginBottom: 8 }}>
                    联系人 / 联系电话（可动态增加，多个时自动编号 联系人1、联系人2… / 联系电话1、联系电话2…）
                  </div>
                  <Space direction="vertical" size={8} style={{ width: '100%' }}>
                    {form.contacts.map((row, idx) => (
                      <Row gutter={8} key={row.key} align="middle">
                        <Col xs={24} md={9}>
                          {editable ? (
                            <Input
                              addonBefore={`联系人${idx + 1}`}
                              value={row.name}
                              placeholder="请输入联系人姓名"
                              onChange={(e) => updateContact(row.key, { name: e.target.value })}
                            />
                          ) : (
                            <div>
                              联系人{idx + 1}：{row.name || '-'}
                            </div>
                          )}
                        </Col>
                        <Col xs={24} md={12}>
                          {editable ? (
                            <Input
                              addonBefore={`联系电话${idx + 1}`}
                              value={row.phone}
                              placeholder="请输入联系电话"
                              onChange={(e) => updateContact(row.key, { phone: e.target.value })}
                            />
                          ) : (
                            <div>
                              联系电话{idx + 1}：{row.phone || '-'}
                            </div>
                          )}
                        </Col>
                        <Col xs={24} md={3}>
                          {editable && form.contacts.length > 1 && (
                            <Button
                              type="link"
                              danger
                              size="small"
                              icon={<DeleteOutlined />}
                              onClick={() => removeContact(row.key)}
                            />
                          )}
                        </Col>
                      </Row>
                    ))}
                  </Space>
                  {editable && (
                    <Button style={{ marginTop: 8 }} size="small" icon={<PlusOutlined />} onClick={addContact}>
                      添加联系人
                    </Button>
                  )}
                </Col>
              </Row>
            </Card>

            {/* 二、采购清单（只读，来自总采购清单） */}
            <Card
              size="small"
              title="二、采购清单"
              extra={<span style={{ color: 'var(--cms-muted-soft)', fontSize: 12 }}>数据来自总采购清单，不可编辑</span>}
            >
              <Table
                size="small"
                rowKey={(_r, i) => String(i)}
                columns={purchaseColumns}
                dataSource={detail?.purchaseItems ?? []}
                scroll={{ x: 'max-content' }}
                pagination={false}
                locale={{ emptyText: '暂无数据（总采购清单为空或尚未编制）' }}
              />
            </Card>

            {richSection('三、技术质量标准', 'techQuality')}
            {richSection('四、验收方式', 'acceptanceMethod')}
            {richSection('五、付款方式', 'paymentMethod')}
          </Space>
          )}
        </Spin>
        </EditorTabPage>
      )}

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
        confirmTitle="确认发布采购公告？"
        confirmDescription="发布前将自动保存当前内容；发布后状态变更为「已完成」，任务状态流转到下一阶段。"
        tipMessage="请核对公告内容与采购清单，确认无误后点击「确认发布」。"
        onPublish={handlePublish}
        onClose={() => setModalMode(null)}
      />
    </Space>
  );
}
