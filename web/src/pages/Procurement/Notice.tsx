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
  DeleteOutlined,
  DownloadOutlined,
  EyeOutlined,
  PlusOutlined,
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
  replaceProcurementVariables,
} from '@/constants/procurementVariables';
import RichTextEditor from '@/components/RichTextEditor';
import PreviewPublishModal from '@/components/PreviewPublishModal';
import ModuleDetailCard, { useModuleDetailDoc } from '@/components/procurement/ModuleDetailCard';
import ModuleListPage, {
  type ModuleListFilterField,
  type ModuleListRow,
} from '@/components/procurement/ModuleListPage';
import { exportProcurementWord } from '@/utils/procurementExport';
import {
  buildNoticeDocHtml,
  buildNoticeVariableValues,
  contactEntries,
  type NoticeData,
  type NoticePurchaseItem,
} from '@/utils/procurementNotice';

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
  techQuality: string;
  acceptanceMethod: string;
  paymentMethod: string;
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
const stripKey = <T,>(row: Keyed<T>): T => {
  const { key: _key, ...rest } = row;
  return rest as unknown as T;
};
/** 联系人列表至少保留一行，便于直接录入 */
const normalizeContacts = (rows: Keyed<ContactRow>[]): Keyed<ContactRow>[] =>
  rows.length ? rows : withKeys<ContactRow>([{ name: '', phone: '' }]);

const EMPTY_FORM: NoticeForm = {
  procurementNo: '',
  procurementTime: null,
  content: '',
  techQuality: '',
  acceptanceMethod: '',
  paymentMethod: '',
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
      <div style={{ color: '#8c8c8c', fontSize: 12, marginBottom: 4 }}>{label}</div>
      {editable ? (
        <Input value={value} placeholder={placeholder ?? `请填写${label}`} onChange={(e) => onChange(e.target.value)} />
      ) : (
        <div style={{ minHeight: 22 }}>{value || '-'}</div>
      )}
    </div>
  );
}

export default function Notice() {
  const [searchParams, setSearchParams] = useSearchParams();
  const currentProjectId = useAuthStore((s) => s.currentProjectId);

  const [taskId, setTaskId] = useState<string | null>(searchParams.get('taskId') || null);
  /** 列表化（批次五）：详情抽屉开关；带 taskId 进入页面时直接打开 */
  const [detailOpen, setDetailOpen] = useState(!!searchParams.get('taskId'));
  /** 列表刷新键：详情抽屉关闭后重查，反映最新模块状态 */
  const [listRefresh, setListRefresh] = useState(0);

  const [detail, setDetail] = useState<NoticeDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);

  const [form, setForm] = useState<NoticeForm>(EMPTY_FORM);
  const [saving, setSaving] = useState(false);
  const [publishing, setPublishing] = useState(false);
  /** 发布后默认只读；点「重新编辑」解锁 */
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
  /** 当前是否可编辑：公告编制中，或已发布后主动点「重新编辑」 */
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
      .notice(id)
      .then((res: any) => {
        const d: NoticeDetail = res?.data ?? res;
        setDetail(d);
        const data = (d?.data ?? {}) as NonNullable<NoticeDetail['data']>;
        setForm({
          procurementNo: data.procurementNo || String(d?.task?.taskNo ?? ''),
          procurementTime: data.procurementTime ? dayjs(data.procurementTime).format('YYYY-MM-DD') : null,
          // 采购内容默认带出采购任务内容
          content: data.content || String(d?.task?.content ?? ''),
          techQuality: data.techQuality ?? '',
          acceptanceMethod: data.acceptanceMethod ?? '',
          paymentMethod: data.paymentMethod ?? '',
          contacts: normalizeContacts(
            withKeys(contactEntries(data.contacts ?? [], data.contactPhones ?? [])),
          ),
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

  const patchForm = (patch: Partial<NoticeForm>) => setForm((f) => ({ ...f, ...patch }));

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

  /* ---------------- 保存 / 发布 / 导出 ---------------- */

  const buildSavePayload = () => ({
    procurementNo: form.procurementNo,
    procurementTime: form.procurementTime || null,
    content: form.content,
    techQuality: form.techQuality,
    acceptanceMethod: form.acceptanceMethod,
    paymentMethod: form.paymentMethod,
    contacts: form.contacts.map((r) => String(r.name ?? '').trim()),
    contactPhones: form.contacts.map((r) => String(r.phone ?? '').trim()),
  });

  const handleSave = async () => {
    if (!taskId) return;
    setSaving(true);
    try {
      await procurementTaskApi.saveNotice(taskId, buildSavePayload());
      message.success('已保存');
      setEditOpen(false);
      loadDetail(taskId);
    } finally {
      setSaving(false);
    }
  };

  /** 发布流程第 1 步：校验必填 → 打开「发布前预览」 */
  const openPublishPreview = () => {
    if (!String(form.procurementNo ?? '').trim()) {
      message.warning('请先填写「采购编号」再发布');
      return;
    }
    if (!form.procurementTime) {
      message.warning('请先选择「采购时间」再发布');
      return;
    }
    if (!String(form.content ?? '').trim()) {
      message.warning('请先填写「采购内容」再发布');
      return;
    }
    setModalMode('publish');
  };

  /** 发布流程第 2 步：确认发布（先落库当前编辑内容，避免「发布的内容 ≠ 已保存的内容」） */
  const handlePublish = async () => {
    if (!taskId) return;
    setPublishing(true);
    try {
      await procurementTaskApi.saveNotice(taskId, buildSavePayload());
      await procurementTaskApi.publish(taskId);
      message.success('已发布，采购公告状态变更为「已完成」');
      setModalMode(null);
      loadDetail(taskId);
    } finally {
      setPublishing(false);
    }
  };

  /** 文档数据（联系人转事件对数组） */
  const docData = useMemo<NoticeData>(
    () => ({
      procurementNo: form.procurementNo,
      procurementTime: form.procurementTime,
      content: form.content,
      techQuality: form.techQuality,
      acceptanceMethod: form.acceptanceMethod,
      paymentMethod: form.paymentMethod,
      contacts: form.contacts.map((r) => String(r.name ?? '').trim()),
      contactPhones: form.contacts.map((r) => String(r.phone ?? '').trim()),
      purchaseItems: detail?.purchaseItems ?? [],
    }),
    [form, detail],
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

  /** 只读详情文档（模板优先 + 变量替换，需求修正 · 修改二） */
  const detailDoc = useModuleDetailDoc(
    !!currentTask,
    MODULE_TYPE,
    taskId ?? undefined,
    rawDocHtml,
    varValues,
  );

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
      render: (v: number | null) => (v != null ? Number(v).toLocaleString('zh-CN') : '-'),
    },
    { title: '备注', dataIndex: 'remark', width: 160, render: (v: string | null) => v || '-' },
  ];

  /* ---------------- 渲染 ---------------- */

  const richSection = (
    label: string,
    field: 'techQuality' | 'acceptanceMethod' | 'paymentMethod',
  ) => (
    <Card size="small" title={label}>
      <RichTextEditor
        value={form[field]}
        onChange={(html) => patchForm({ [field]: html } as Partial<NoticeForm>)}
        variableGroups={getProcurementVariableGroups(MODULE_TYPE)}
        disabled={!editable}
        minHeight={180}
        placeholder={`请填写${label}`}
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
          <span style={{ color: '#8c8c8c', fontSize: 13 }}>
            仅显示单项采购类型的任务；编辑与发布以任务所处阶段为准
          </span>
        }
        refreshKey={listRefresh}
        onView={openRow}
        onEdit={editRow}
      />

      {/* 只读详情抽屉（需求修正 · 修改二）：由列表行「查看」进入，编辑在弹窗进行 */}
      <Drawer
        title={`采购公告 · 任务详情${currentTask ? ` · ${currentTask.taskNo}` : ''}`}
        width={1200}
        open={detailOpen && !!currentTask}
        onClose={closeDetail}
        destroyOnClose
      >
        {currentTask && (
          <ModuleDetailCard
            title="采购公告 · 任务详情"
            taskNo={currentTask.taskNo}
            content={form.content || currentTask.content}
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
      </Drawer>

      {/* 编辑弹窗（需求修正 · 修改二）：保存后关闭返回只读详情 */}
      <Drawer
        title={`采购公告 · 编辑${currentTask ? ` · ${currentTask.taskNo}` : ''}`}
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
                <Col span={8}>
                  <Field
                    label="采购编号"
                    value={form.procurementNo}
                    editable={editable}
                    onChange={(v) => patchForm({ procurementNo: v })}
                  />
                </Col>
                <Col span={8}>
                  <div style={{ color: '#8c8c8c', fontSize: 12, marginBottom: 4 }}>采购时间</div>
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
                <Col span={8}>
                  <Field
                    label="采购内容"
                    value={form.content}
                    editable={editable}
                    onChange={(v) => patchForm({ content: v })}
                  />
                </Col>
                <Col span={24}>
                  <div style={{ color: '#8c8c8c', fontSize: 12, marginBottom: 8 }}>
                    联系人 / 联系电话（可动态增加，多个时自动编号 联系人1、联系人2… / 联系电话1、联系电话2…）
                  </div>
                  <Space direction="vertical" size={8} style={{ width: '100%' }}>
                    {form.contacts.map((row, idx) => (
                      <Row gutter={8} key={row.key} align="middle">
                        <Col span={9}>
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
                        <Col span={12}>
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
                        <Col span={3}>
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
              extra={<span style={{ color: '#8c8c8c', fontSize: 12 }}>数据来自总采购清单，不可编辑</span>}
            >
              <Table
                size="small"
                rowKey={(_r, i) => String(i)}
                columns={purchaseColumns}
                dataSource={detail?.purchaseItems ?? []}
                pagination={false}
                locale={{ emptyText: '暂无数据（总采购清单为空或尚未编制）' }}
              />
            </Card>

            {richSection('三、技术质量标准', 'techQuality')}
            {richSection('四、验收方式', 'acceptanceMethod')}
            {richSection('五、付款方式', 'paymentMethod')}

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
        confirmTitle="确认发布采购公告？"
        confirmDescription="发布前将自动保存当前内容；发布后状态变更为「已完成」，任务状态流转到下一阶段。"
        tipMessage="请核对公告内容与采购清单，确认无误后点击「确认发布」。"
        onPublish={handlePublish}
        onClose={() => setModalMode(null)}
      />
    </Space>
  );
}
