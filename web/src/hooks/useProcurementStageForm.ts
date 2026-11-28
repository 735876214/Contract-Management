import { useCallback, useEffect, useRef, useState } from 'react';
import { useSearchParams, useNavigate } from 'react-router-dom';
import { message } from '@/utils/antdStatic';
import { projectApi } from '@/api/business';
import { procurementTaskApi } from '@/api/modules';
import { useAuthStore } from '@/store/auth';
import { useModuleDelete, moduleStatusOf, type ModuleListRow } from '@/components/procurement/ModuleListPage';
import { exportTaskModuleWord } from '@/utils/procurementTaskDocs';
import { useEditorTab, useTabRefresh } from '@/hooks/useTabs';
import { editorTabKey } from '@/utils/tabs';

/**
 * 采购六阶段表单页（公告 / 采购文件 / 成交报告 / 价格对比 / 框架事前说明 / 采前会纪要）
 * 的**共用编辑器生命周期**（P1 同构收敛）。
 *
 * 这六个页面此前是 720–990 行的同构粘贴：`?editor=<taskId>` 页签态、项目详情拉取、
 * 详情加载 / 脏标记、保存 / 发布（先落库再 publish）/ 行导出 / 列表刷新 / 删除回退……
 * 逐页各写一遍。本 hook 把这些**与具体表单字段无关**的状态与流程收敛到一处，
 * 页面只保留：表单类型 + `EMPTY_FORM` + `initForm/bindForm`（详情 → 表单）+
 * `buildSavePayload`（表单 → 保存 body）+ `validatePublish`（必填校验）+ JSX + 文档构建。
 *
 * 不抽 JSX：六个模块的正文区域差异（表格列、富文本区、联系人动态行…）远大于共性，
 * 强行组件化只会让每页塞满 `render`/`slot` 回调，反而更难读——这是**有意的边界**。
 */

/** 阶段详情外壳里必然有的公共字段（各模块 data 形状不同，task 公共）。 */
export interface StageFormDetailBase {
  task: { taskNo?: string; content?: string; type?: string; status?: string } | null;
  editable: boolean;
  published: boolean;
  status: string;
  statusLabel: string;
  data: unknown;
}

export interface UseProcurementStageFormOptions<TDetail extends StageFormDetailBase, TForm> {
  /** 模块类型（与采购模板 moduleType、导出 Word 一致） */
  moduleType: string;
  /**
   * 导出 Word 用的模块类型（默认同 moduleType）。框架协议事前说明的列表/删除模块键是
   * `FRAMEWORK_EXPLANATION`，但导出 Word 走的是 `FRAMEWORK`，故允许单独指定。
   */
  exportModuleType?: string;
  /** 所属列表路径（`/procurement/notice` 等），用于页签与刷新 */
  listPath: string;
  /** 拉详情（各模块的 `procurementTaskApi.xxx(id)`） */
  load: (id: string) => Promise<TDetail>;
  /** 详情 → 表单（页面自己实现：默认带出/格式化） */
  initForm: (detail: TDetail) => TForm;
  /**
   * 可选：详情加载成功后的自定义副作用（如成交报告的 suppliers/candidates 额外状态）。
   * 提供时**由它负责 setForm**（hook 不再调用 initForm），用于带额外表单状态的页面。
   */
  onLoaded?: (detail: TDetail, setForm: (f: TForm) => void) => void;
  /** 表单 → 保存 body */
  buildSavePayload: (form: TForm) => Record<string, unknown> | unknown;
  /** 真正落库的保存方法（各模块 `saveNotice` / `saveDocument`…） */
  save: (id: string, payload: any) => Promise<unknown>;
  /** 空表单（初始值） */
  emptyForm: TForm;
  /** 发布前必填校验：返回错误文案则不发布（预检），返回 null 放行 */
  validatePublish: (form: TForm) => string | null;
  /** 发布成功提示 */
  publishSuccessMessage: string;
}

export function useProcurementStageForm<TDetail extends StageFormDetailBase, TForm>(
  opts: UseProcurementStageFormOptions<TDetail, TForm>,
) {
  const {
    moduleType,
    listPath,
    load,
    initForm,
    onLoaded,
    buildSavePayload,
    save,
    emptyForm,
    validatePublish,
    publishSuccessMessage,
    exportModuleType,
  } = opts;

  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const currentProjectId = useAuthStore((s) => s.currentProjectId);

  const editorTab = useEditorTab(listPath);
  const tabRefresh = useTabRefresh(listPath);
  const taskId = editorTab.editorId === 'new' ? null : editorTab.editorId;

  // 兼容旧深链 `?taskId=xxx`：归一成编辑器页签
  useEffect(() => {
    const legacy = searchParams.get('taskId');
    if (legacy && !editorTab.isEditor) navigate(editorTabKey(listPath, legacy), { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** 列表刷新键：编辑器页签关闭后由 closeEditor 的 bump 触发；本键用于页内（删除等） */
  const [listRefresh, setListRefresh] = useState(0);
  const handleDeleteModule = useModuleDelete(moduleType, () => setListRefresh((k) => k + 1));

  const [detail, setDetail] = useState<TDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [form, setForm] = useState<TForm>(emptyForm);
  const [saving, setSaving] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const [reEditing, setReEditing] = useState(false);
  const [modalMode, setModalMode] = useState<'preview' | 'publish' | null>(null);
  const [dirty, setDirty] = useState(false);
  const [viewRow, setViewRow] = useState<ModuleListRow | null>(null);
  const reEditRef = useRef(false);

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

  useEffect(() => {
    if (!currentProjectId) return;
    projectApi
      .detail(currentProjectId)
      .then((res: any) => setProject(res ?? {}))
      .catch(() => setProject({}));
  }, [currentProjectId]);

  const loadDetail = useCallback(
    (id: string) => {
      setDetailLoading(true);
      load(id)
        .then((res) => {
          const d = res;
          setDetail(d);
          if (d && onLoaded) onLoaded(d, setForm);
          else setForm(d ? initForm(d) : emptyForm);
          setReEditing(reEditRef.current && !!d?.published);
          reEditRef.current = false;
        })
        .catch(() => {
          setDetail(null);
          setForm(emptyForm);
        })
        .finally(() => setDetailLoading(false));
    },
    [load, initForm, onLoaded, emptyForm],
  );

  const handleViewRow = (row: ModuleListRow) => {
    if (moduleStatusOf(row).value === 'PUBLISHED') setViewRow(row);
    else editRow(row);
  };
  const editRow = (row: ModuleListRow, reEdit = false) => {
    editorTab.openEdit(row.id, { reEdit });
  };

  useEffect(() => {
    if (!taskId) return;
    reEditRef.current = !!(editorTab.seed as { reEdit?: boolean } | undefined)?.reEdit;
    loadDetail(taskId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [taskId]);

  const handleRowExport = async (row: ModuleListRow) => {
    try {
      const filename = await exportTaskModuleWord((exportModuleType ?? moduleType) as any, row.id);
      message.success(`已导出：${filename}`);
    } catch (e: any) {
      message.error(e?.message || '导出失败，请稍后重试');
    }
  };

  const patchForm = (patch: Partial<TForm>) => {
    setForm((f) => ({ ...f, ...patch }));
    setDirty(true);
  };

  /**
   * 保存 body 注入乐观锁 version：详情 data 里带回了 version（服务端记录版本），
   * 保存时原样回传，服务端据此做并发互斥（缺失则兼容旧行为）。
   */
  const withVersion = (payload: unknown): any => {
    const ver = (detail?.data as { version?: number } | null | undefined)?.version;
    if (ver === undefined || payload == null || typeof payload !== 'object') return payload;
    return { ...(payload as Record<string, unknown>), version: ver };
  };

  const handleSave = async () => {
    if (!taskId) return;
    setSaving(true);
    try {
      await save(taskId, withVersion(buildSavePayload(form)));
      message.success('已保存');
      loadDetail(taskId);
      setDirty(false);
      setListRefresh((x) => x + 1);
    } finally {
      setSaving(false);
    }
  };

  const openPublishPreview = () => {
    const err = validatePublish(form);
    if (err) {
      message.warning(err);
      return;
    }
    setModalMode('publish');
  };

  const handlePublish = async () => {
    if (!taskId) return;
    setPublishing(true);
    try {
      await save(taskId, withVersion(buildSavePayload(form)));
      await procurementTaskApi.publish(taskId);
      message.success(publishSuccessMessage);
      setModalMode(null);
      setDirty(false);
      editorTab.closeEditor();
    } finally {
      setPublishing(false);
    }
  };

  return {
    // 页签 / 列表
    editorTab,
    tabRefresh,
    taskId,
    listRefresh,
    handleDeleteModule,
    handleViewRow,
    editRow,
    handleRowExport,
    // 详情 / 表单
    detail,
    detailLoading,
    loadDetail,
    form,
    setForm,
    patchForm,
    currentTask,
    editable,
    dirty,
    setDirty,
    reEditing,
    // 保存 / 发布
    saving,
    publishing,
    modalMode,
    setModalMode,
    openPublishPreview,
    handlePublish,
    handleSave,
    // 项目
    project,
    // 查看弹窗
    viewRow,
    setViewRow,
  };
}
