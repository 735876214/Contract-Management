import { useRef, useState } from 'react';
import { Button, Modal, message, Alert, Typography, Progress } from 'antd';
import { ImportOutlined, DownloadOutlined, UploadOutlined } from '@ant-design/icons';
import http from '@/api/http';

/**
 * 通用「导入」二级菜单按钮（需求 3.1 / 3.2）
 *
 * 点击「导入」→ 弹出二级菜单：
 *  ① 📄 下载填写模板 —— 导出空白模板（表头带 * 必填标注、示例行、下拉/日期/数字验证、填写说明页）
 *  ② 📤 上传导入数据 —— 上传填写好的模板文件，校验后写入数据库，并展示导入结果/错误报告
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
  /** 填写模板下载地址（自动附加 ?token= 以支持浏览器直接下载） */
  templateUrl?: string | (() => string);
  /** 上传导入地址（POST multipart/form-data，字段名 file）；函数形式可动态构造（如携带 contractId） */
  uploadUrl?: string | ((file: File) => string);
  /** 自定义上传实现（优先级高于 uploadUrl），返回 { created, updated, errors } */
  onUpload?: (file: File) => Promise<ImportResult>;
  disabled?: boolean;
  /** 导入成功后回调（如刷新列表） */
  onDone?: () => void;
  /** 上传完成的额外提示（如「重复行将被跳过」） */
  extraHint?: string;
}

/** 为下载链接附加 token（window.open 无法携带 Authorization 头，后端 JWT 策略支持 ?token=） */
function withToken(url: string): string {
  const token = localStorage.getItem('cms_token') || '';
  return url + (url.includes('?') ? '&' : '?') + `token=${encodeURIComponent(token)}`;
}

export default function ImportButton({
  moduleName,
  templateUrl,
  uploadUrl,
  onUpload,
  disabled,
  onDone,
  extraHint,
}: Props) {
  const [open, setOpen] = useState(false);
  const [stage, setStage] = useState<'menu' | 'result' | 'progress'>('menu');
  const [uploading, setUploading] = useState(false);
  const [result, setResult] = useState<ImportResult | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const reset = () => {
    setStage('menu');
    setResult(null);
    setUploading(false);
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

  /** 轮询异步导入任务进度（需求 2.7） */
  const pollTask = (taskId: string) => {
    const timer = setInterval(async () => {
      try {
        const t: any = await http.get(`/import-tasks/${taskId}`);
        setResult((r) => ({ ...(r || {}), ...t }));
        if (t?.status === 'SUCCESS' || t?.status === 'FAILED') {
          clearInterval(timer);
          setStage('result');
          if (t.status === 'SUCCESS') {
            message.success(`后台导入完成：成功写入 ${t.successCount ?? 0} 行`);
            onDone?.();
          } else {
            message.warning(`后台导入未完成：${t.failCount ?? 0} 行校验失败，已全部回滚，未写入任何数据`);
          }
        }
      } catch {
        clearInterval(timer);
        setStage('result');
      }
    }, 1500);
  };

  const handleFile = async (file?: File) => {
    if (!file) return;
    setUploading(true);
    try {
      let res: ImportResult;
      if (onUpload) {
        res = await onUpload(file);
      } else {
        const url = typeof uploadUrl === 'function' ? uploadUrl(file) : uploadUrl || '';
        const fd = new FormData();
        fd.append('file', file);
        res = await http.post<any, ImportResult>(url, fd, { headers: { 'Content-Type': 'multipart/form-data' } });
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

  const errCount = result?.errors?.length || 0;

  return (
    <>
      <Button icon={<ImportOutlined />} disabled={disabled} onClick={() => { reset(); setOpen(true); }}>
        导入
      </Button>
      <Modal
        title={`【${moduleName}】导入数据`}
        open={open}
        onCancel={() => setOpen(false)}
        width={520}
        destroyOnClose
        footer={
          stage === 'menu'
            ? [<Button key="cancel" onClick={() => setOpen(false)}>取消</Button>]
            : stage === 'progress'
              ? [<Button key="close" onClick={() => setOpen(false)}>后台运行，关闭窗口</Button>]
            : [
                <Button key="back" onClick={reset}>返回</Button>,
                <Button key="close" type="primary" onClick={() => setOpen(false)}>关闭</Button>,
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
        ) : stage === 'menu' ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12, padding: '8px 0' }}>
            <div style={{ marginBottom: 4 }}>
              <Typography.Text type="secondary">请选择操作：</Typography.Text>
            </div>
            <Button
              size="large"
              style={{ textAlign: 'left', height: 72, display: 'flex', flexDirection: 'column', alignItems: 'flex-start', justifyContent: 'center' }}
              icon={<DownloadOutlined style={{ fontSize: 22, color: '#1677ff' }} />}
              onClick={doDownload}
              disabled={!templateUrl}
            >
              <span style={{ fontWeight: 600 }}>下载填写模板</span>
              <span style={{ fontSize: 12, color: '#999' }}>导出空白 Excel 模板，按格式要求填写数据</span>
            </Button>
            <Button
              size="large"
              style={{ textAlign: 'left', height: 72, display: 'flex', flexDirection: 'column', alignItems: 'flex-start', justifyContent: 'center' }}
              icon={<UploadOutlined style={{ fontSize: 22, color: '#52c41a' }} />}
              onClick={pickFile}
              loading={uploading}
              disabled={!uploadUrl && !onUpload}
            >
              <span style={{ fontWeight: 600 }}>上传导入数据</span>
              <span style={{ fontSize: 12, color: '#999' }}>上传已填写好的模板文件，校验通过后写入系统</span>
            </Button>
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
                      <li key={i} style={{ color: '#d4380d', lineHeight: '20px' }}>{renderError(e)}</li>
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
