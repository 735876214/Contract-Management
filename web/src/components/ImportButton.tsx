import { useEffect, useRef, useState } from 'react';
import { Button, Modal, message, Alert, Typography, Progress, Table, Checkbox } from 'antd';
import { ImportOutlined, DownloadOutlined, UploadOutlined } from '@ant-design/icons';
import http, { stripApiBase } from '@/api/http';

/**
 * 通用「导入」二级菜单按钮（需求 3.1 / 3.2）
 *
 * 点击「导入」→ 弹出二级菜单：
 *  ① 📄 下载填写模板 —— 导出空白模板（表头带 * 必填标注、示例行、下拉/日期/数字验证、填写说明页）
 *  ② 📤 上传导入数据 —— 上传填写好的模板文件，先调用 validateUrl 预校验并逐行展示校验结果，
 *     全部通过后用户确认才真正导入（校验不写库；>1000 行导入仍转后台任务）
 */

export interface ImportRowError {
  /** Excel 中的实际行号 */
  row?: number;
  /** 出错字段（表头名） */
  field?: string;
  message?: string;
}

export interface ImportResult {
  total?: number;
  created?: number;
  updated?: number;
  errors?: (ImportRowError | string)[];
  /** 预校验结果：校验是否全部通过 */
  valid?: boolean;
  /** 异步导入：>1000 行时后端立即返回任务 ID */
  taskId?: string;
  async?: boolean;
  status?: 'PENDING' | 'RUNNING' | 'SUCCESS' | 'FAILED';
  processedRows?: number;
  totalRows?: number;
  successCount?: number;
  failCount?: number;
  errorFileUrl?: string;
}

/** 统一渲染一条错误（兼容旧的字符串格式） */
function renderError(e: ImportRowError | string): string {
  if (typeof e === 'string') return e;
  const parts: string[] = [];
  if (e.row) parts.push(`第 ${e.row} 行`);
  if (e.field) parts.push(`【${e.field}】`);
  return `${parts.join('')}${parts.length ? '：' : ''}${e.message || '未知错误'}`;
}

interface Props {
  /** 模块名称，如「合同物资清单」，用于弹窗标题 */
  moduleName: string;
  /** 填写模板下载地址（鉴权走 httpOnly Cookie；withToken 只补项目上下文） */
  templateUrl?: string | (() => string);
  /** 上传导入地址（POST multipart/form-data，字段名 file）；函数形式可动态构造（如携带 contractId） */
  uploadUrl?: string | ((file: File) => string);
  /** 预校验地址（POST multipart/form-data，字段名 file；不写库）。传入后上传前先校验并展示逐行结果 */
  validateUrl?: string | ((file: File) => string);
  /** 自定义上传实现（优先级高于 uploadUrl），返回 { created, updated, errors } */
  onUpload?: (file: File) => Promise<ImportResult>;
  disabled?: boolean;
  /** 导入成功后回调（如刷新列表） */
  onDone?: () => void;
  /** 上传完成的额外提示（如「重复行将被跳过」） */
  extraHint?: string;
  /** 允许「已存在则更新（覆盖模式）」：开启后弹窗里多一个勾选框，勾上则给导入地址追加 ?mode=upsert */
  allowUpsert?: boolean;
}

// withToken 已抽到 utils/download，供各页面导出按钮共用
import { withToken } from '../utils/download';

export default function ImportButton({
  moduleName,
  templateUrl,
  uploadUrl,
  validateUrl,
  onUpload,
  disabled,
  onDone,
  extraHint,
  allowUpsert,
}: Props) {
  const [open, setOpen] = useState(false);
  const [stage, setStage] = useState<'menu' | 'validating' | 'confirm' | 'result' | 'progress'>('menu');
  const [uploading, setUploading] = useState(false);
  const [upsert, setUpsert] = useState(false);
  /** 覆盖模式：给导入/预校验地址追加 mode=upsert（结算台账「导出→改→导回」用，第 22 轮审计 P1-1） */
  const withMode = (u: string) => {
    if (!upsert) return u;
    return u.includes('?') ? u + '&mode=upsert' : u + '?mode=upsert';
  };
  const [result, setResult] = useState<ImportResult | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const pendingFileRef = useRef<File | null>(null);

  const reset = () => {
    setStage('menu');
    setResult(null);
    setUploading(false);
    pendingFileRef.current = null;
    if (fileRef.current) fileRef.current.value = '';
  };

  const doDownload = () => {
    if (!templateUrl) return;
    const url = typeof templateUrl === 'function' ? templateUrl() : templateUrl;
    window.open(withToken(url));
    message.success('填写模板已开始下载');
  };

  const pickFile = () => {
    fileRef.current?.click();
  };

  /** 轮询异步导入任务进度（需求 2.7）。组件卸载（关标签/登出）时必须停表，
   *  否则对已卸载组件 setState 并永久轮询 /import-tasks/:id（卡住的任务尤其明显）。 */
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  useEffect(() => {
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, []);
  /** 关闭弹窗：必须同时停掉进度轮询（第 22 轮审计 P2-15），否则关掉后仍在打 /import-tasks/:id */
  const close = () => {
    if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
    setOpen(false);
  };

  const pollTask = (taskId: string) => {
    if (timerRef.current) clearInterval(timerRef.current);
    timerRef.current = setInterval(async () => {
      try {
        const t: any = await http.get(`/import-tasks/${taskId}`);
        setResult((r) => ({ ...(r || {}), ...t }));
        if (t?.status === 'SUCCESS' || t?.status === 'FAILED') {
          if (timerRef.current) clearInterval(timerRef.current);
          setStage('result');
          if (t.status === 'SUCCESS') {
            message.success(`后台导入完成：成功写入 ${t.successCount ?? 0} 行`);
            onDone?.();
          } else {
            message.warning(`后台导入未完成：${t.failCount ?? 0} 行校验失败，已全部回滚，未写入任何数据`);
          }
        }
      } catch (e: any) {
        if (timerRef.current) clearInterval(timerRef.current);
        /**
         * 第 8 轮审计：原来只 setStage('result') 不写失败状态，结果页没有 status，
         * 渲染分支落到「导入完成：新增 N 行」——断网/接口 500/服务端崩溃都会显示成导入成功。
         */
        setResult((r) => ({
          ...(r || {}),
          status: 'FAILED',
          message: e?.message ? `查询后台导入进度失败：${e.message}` : '查不到后台导入进度（网络或服务异常），请稍后到导入记录里确认结果',
        }));
        setStage('result');
        message.error('查不到后台导入进度，请稍后到导入记录里确认结果');
      }
    }, 1500);
  };

  const buildForm = (file: File) => {
    const fd = new FormData();
    fd.append('file', file);
    return fd;
  };

  /** 真正执行导入（校验通过后由用户确认触发） */
  const doUpload = async (file: File) => {
    setUploading(true);
    try {
      let res: ImportResult;
      if (onUpload) {
        res = await onUpload(file);
      } else {
        const url = stripApiBase(withMode(typeof uploadUrl === 'function' ? uploadUrl(file) : uploadUrl || ''));
        res = await http.post<any, ImportResult>(url, buildForm(file), {
          headers: { 'Content-Type': 'multipart/form-data' },
        });
      }
      if (res?.async && res?.taskId) {
        // 异步导入（>1000 行）：立即返回任务 ID，进入进度轮询
        message.info(`数据量较大（${res.totalRows ?? res.total ?? '-'} 行），已转为后台导入，请稍候…`);
        setStage('progress');
        pollTask(res.taskId);
        return;
      }
      setResult(res || {});
      setStage('result');
      const errs = res?.errors || [];
      if (errs.length) message.warning(`导入未完成：${errs.length} 行校验失败，已全部回滚，未写入任何数据`);
      else message.success(`导入成功：新增 ${res?.created ?? 0}${res?.updated != null ? `，更新 ${res?.updated}` : ''}`);
      onDone?.();
    } catch {
      // 错误已由 http 拦截器统一提示
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  };

  /** 选择文件：先预校验（不写库），全部通过后由用户确认导入 */
  const handleFile = async (file?: File) => {
    if (!file) return;
    if (!validateUrl) {
      // 未配置预校验地址：保持旧行为，直接导入
      await doUpload(file);
      return;
    }
    setUploading(true);
    setStage('validating');
    try {
      const url = stripApiBase(withMode(typeof validateUrl === 'function' ? validateUrl(file) : validateUrl));
      // 预校验恒定同步执行（最多 5000 行，逐行查库，不走 >1000 行异步任务的分支），
      // 耗时可能远超实例默认的 30s；60s 会在服务端仍在校验时先超时，用户既看不到问题行也无法继续导入。
      // 与部署代理（nginx proxy_read_timeout 300s）对齐，避免客户端比代理更早断开。
      const res: ImportResult = await http.post<any, ImportResult>(url, buildForm(file), {
        headers: { 'Content-Type': 'multipart/form-data' },
        timeout: 300000,
      });
      pendingFileRef.current = file;
      setResult(res || {});
      setStage('confirm');
    } catch {
      setStage('menu');
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  };

  const errCount = result?.errors?.length || 0;
  const pendingFile = pendingFileRef.current;
  const totalRows = result?.total ?? 0;

  const errorTable = errCount > 0 && (
    <Table
      size="small"
      rowKey={(_, i) => String(i)}
      dataSource={(result?.errors || []).map((e) => (typeof e === 'string' ? { message: e } : e))}
      columns={[
        { title: '行号', dataIndex: 'row', width: 70, render: (v) => (v ? `第 ${v} 行` : '-') },
        { title: '字段', dataIndex: 'field', width: 130, render: (v) => v || '-' },
        { title: '问题', dataIndex: 'message', render: (v) => v || '未知错误' },
      ]}
      pagination={{ pageSize: 8, showSizeChanger: false, showTotal: (t) => `共 ${t} 条` }}
      scroll={{ y: 240 }}
    />
  );

  return (
    <>
      <Button icon={<ImportOutlined />} disabled={disabled} onClick={() => { reset(); setOpen(true); }}>
        导入
      </Button>
      <Modal
        title={`【${moduleName}】导入数据`}
        open={open}
        onCancel={close}
        width={560}
        destroyOnHidden
        footer={
          stage === 'menu' || stage === 'validating'
            ? [<Button key="cancel" onClick={close}>取消</Button>]
            : stage === 'progress'
              ? [<Button key="close" onClick={close}>后台运行，关闭窗口</Button>]
              : stage === 'confirm'
                ? [
                    <Button key="back" onClick={reset}>返回重选</Button>,
                    <Button
                      key="ok"
                      type="primary"
                      icon={<UploadOutlined />}
                      disabled={errCount > 0 || !pendingFile}
                      loading={uploading}
                      onClick={() => pendingFile && doUpload(pendingFile)}
                    >
                      开始导入
                    </Button>,
                  ]
                : [
                    <Button key="back" onClick={reset}>返回</Button>,
                    <Button key="close" type="primary" onClick={close}>关闭</Button>,
                  ]
        }
      >
        <input
          ref={fileRef}
          type="file"
          accept=".xlsx,.xls"
          style={{ display: 'none' }}
          onChange={(e) => handleFile(e.target.files?.[0])}
        />
        {stage === 'progress' ? (
          <div style={{ padding: '16px 4px', textAlign: 'center' }}>
            <Progress
              percent={Math.min(99, Math.round(((result?.processedRows ?? 0) / Math.max(1, result?.totalRows ?? result?.total ?? 1)) * 100))}
              status="active"
            />
            <Typography.Text type="secondary">
              后台导入中…已校验 {result?.processedRows ?? 0} / {result?.totalRows ?? result?.total ?? '-'} 行，完成后将在消息中心通知
            </Typography.Text>
          </div>
        ) : stage === 'validating' ? (
          <div style={{ padding: '24px 4px', textAlign: 'center' }}>
            <Progress percent={99} status="active" showInfo={false} />
            <Typography.Text type="secondary">正在预校验文件数据，请稍候…（校验不写入任何数据）</Typography.Text>
          </div>
        ) : stage === 'confirm' ? (
          <div style={{ padding: '8px 0' }}>
            <Alert
              type={errCount ? 'error' : 'success'}
              showIcon
              message={
                errCount
                  ? `预校验未通过：${totalRows} 行数据中发现 ${errCount} 行存在问题，请修正后重新上传`
                  : `预校验通过：共 ${totalRows} 行数据，全部校验无问题，可开始导入`
              }
              style={{ marginBottom: 12 }}
            />
            {errorTable}
            <Typography.Text type="secondary" style={{ fontSize: 12, display: 'block', marginTop: 12 }}>
              文件名：{pendingFile?.name}；采用「全成功或全失败」策略：任一行校验失败即整体回滚，不会写入部分数据。{extraHint || ''}
            </Typography.Text>
          </div>
        ) : stage === 'menu' ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12, padding: '8px 0' }}>
            <div style={{ marginBottom: 4 }}>
              <Typography.Text type="secondary">请选择操作：</Typography.Text>
            </div>
            <Button
              size="large"
              style={{ textAlign: 'left', height: 72, display: 'flex', flexDirection: 'column', alignItems: 'flex-start', justifyContent: 'center' }}
              icon={<DownloadOutlined style={{ fontSize: 22, color: 'var(--cms-primary)' }} />}
              onClick={doDownload}
              disabled={!templateUrl}
            >
              <span style={{ fontWeight: 600 }}>下载填写模板</span>
              <span style={{ fontSize: 12, color: 'var(--cms-muted-soft)' }}>导出空白 Excel 模板，按格式要求填写数据</span>
            </Button>
            <Button
              size="large"
              style={{ textAlign: 'left', height: 72, display: 'flex', flexDirection: 'column', alignItems: 'flex-start', justifyContent: 'center' }}
              icon={<UploadOutlined style={{ fontSize: 22, color: 'var(--cms-success)' }} />}
              onClick={pickFile}
              loading={uploading}
              disabled={!uploadUrl && !onUpload}
            >
              <span style={{ fontWeight: 600 }}>上传导入数据</span>
              <span style={{ fontSize: 12, color: 'var(--cms-muted-soft)' }}>
                {validateUrl ? '上传后先预校验并展示问题行，确认无误后再写入系统' : '上传已填写好的模板文件，校验通过后写入系统'}
              </span>
            </Button>
            {allowUpsert && (
              <Checkbox checked={upsert} onChange={(e) => setUpsert(e.target.checked)}>
                已存在则更新（覆盖模式）
                <span style={{ fontSize: 12, color: 'var(--cms-muted-soft)', marginLeft: 6 }}>
                  默认只新增不覆盖；勾选后「同合同同月」的已有台账行会被更新
                </span>
              </Checkbox>
            )}
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              单次导入最多 5000 行；采用「全成功或全失败」策略：任一行校验失败即整体回滚，不会写入部分数据。{extraHint || ''}
            </Typography.Text>
          </div>
        ) : (
          <div style={{ padding: '8px 0' }}>
            <Alert
              type={errCount ? 'warning' : 'success'}
              showIcon
              message={
                errCount
                  ? `导入未完成：${errCount} 行校验失败，已全部回滚，未写入任何数据`
                  : `导入完成：新增 ${result?.created ?? result?.successCount ?? 0}${result?.updated != null ? `，更新 ${result?.updated}` : ''}`
              }
              style={{ marginBottom: 12 }}
            />
            {result?.errorFileUrl && (
              <Alert
                type="info"
                showIcon
                style={{ marginBottom: 12 }}
                message={
                  <a href={withToken(result.errorFileUrl)} target="_blank" rel="noreferrer">
                    下载错误报告（Excel，含行号 / 字段 / 原因）
                  </a>
                }
              />
            )}
            {errCount > 0 && (
              <Alert
                type="error"
                message="错误报告（行号 + 字段 + 原因）"
                description={
                  <ul style={{ maxHeight: 240, overflowY: 'auto', paddingLeft: 18, margin: '4px 0 0' }}>
                    {result!.errors!.map((e, i) => (
                      <li key={i} style={{ color: 'var(--cms-error)', lineHeight: '20px' }}>{renderError(e)}</li>
                    ))}
                  </ul>
                }
              />
            )}
          </div>
        )}
      </Modal>
    </>
  );
}
