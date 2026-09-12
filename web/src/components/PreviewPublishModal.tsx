/**
 * 采购模块预览与发布统一流程（批次四 · 任务 4.2）
 *
 * 各业务模块（采前会会议纪要 / 采购公告 / 采购文件 / 成交报告 / 框架协议事前说明 /
 * 考察报告 / 采购价格对比表）复用本组件：
 * - mode='publish'：发布前确认 —— 预览最终 Word 效果，提供「返回修改」与「确认发布」
 * - mode='preview'：纯预览（发布后主界面「预览」入口复用同一渲染管线）
 *
 * 内部走统一 Word 导出管线（procurementExport）：采购模板优先 → 变量替换 → 图片内联，
 * 保证预览与导出所见即所得。发布动作由各页面通过 onPublish 回调实现（任务子模块走
 * POST /procurement-tasks/:id/publish，独立模块走各自 publish 接口）。
 */
import { useEffect, useMemo, useState } from 'react';
import { Alert, Button, Modal, Popconfirm, Spin, message } from 'antd';
import { DownloadOutlined, SendOutlined } from '@ant-design/icons';
import { highlightPlaceholders } from '@/utils/docExport';
import {
  buildProcurementDoc,
  exportProcurementWord,
  procurementExportFilename,
  type ProcurementExportInput,
} from '@/utils/procurementExport';
import { procurementModuleLabel } from '@/constants/procurementVariables';

export interface PreviewPublishModalProps {
  open: boolean;
  /** 采购模块类型（决定模板匹配与变量集合） */
  moduleType: string;
  /** 关联采购任务 id */
  taskId?: string;
  /** 显式模板 id；缺省按 moduleType 自动匹配采购模板 */
  templateId?: string;
  /** 模块内置文档 HTML（含 {{占位符}}，未替换） */
  docHtml: string;
  /** 变量取值（文本 / 表格 HTML / 富文本 HTML） */
  values: Record<string, string>;
  /** publish=发布前确认；preview=仅预览（发布后主界面预览）。默认 publish */
  mode?: 'publish' | 'preview';
  /** 弹窗标题；缺省「{模块名} · 发布前确认 / 预览」 */
  title?: string;
  /** 导出文件名；缺省 {项目简称}-{采购内容}-{模块名称}.docx */
  filename?: string;
  /** 项目简称 / 采购内容（缺省文件名生成用） */
  projectAbbr?: string;
  content?: string;
  /** 确认发布按钮 loading */
  publishing?: boolean;
  /** 发布确认气泡文案 */
  confirmTitle?: string;
  confirmDescription?: string;
  /** 顶部提示文案 */
  tipMessage?: string;
  /** 确认发布回调（仅 mode='publish' 时展示按钮） */
  onPublish?: () => Promise<void> | void;
  /** 关闭弹窗（返回修改） */
  onClose: () => void;
  /** 自定义导出（如考察报告特殊命名）；缺省走统一导出接口 */
  onExport?: () => void | Promise<void>;
}

export default function PreviewPublishModal({
  open,
  moduleType,
  taskId,
  templateId,
  docHtml,
  values,
  mode = 'publish',
  title,
  filename,
  projectAbbr,
  content,
  publishing,
  confirmTitle = '确认发布？',
  confirmDescription = '发布后状态变更为「已完成」。',
  tipMessage,
  onPublish,
  onClose,
  onExport,
}: PreviewPublishModalProps) {
  const [building, setBuilding] = useState(false);
  const [html, setHtml] = useState('');
  /** 是否使用了采购模板（提示用户底稿来源） */
  const [tplName, setTplName] = useState<string>('');

  const modalTitle = useMemo(
    () => title ?? `${moduleType ? '' : ''}${mode === 'publish' ? '发布前确认' : '预览'}`,
    [title, mode],
  );

  useEffect(() => {
    if (!open) return;
    let alive = true;
    setBuilding(true);
    buildProcurementDoc(
      { moduleType, taskId, templateId, docHtml, values, filename },
      { inlineImages: false },
    )
      .then((r) => {
        if (!alive) return;
        setHtml(r.html);
        setTplName(r.templateUsed ? r.templateName || '' : '');
      })
      .catch(() => {
        if (alive) setHtml(docHtml || '');
      })
      .finally(() => {
        if (alive) setBuilding(false);
      });
    return () => {
      alive = false;
    };
    // values / docHtml 由调用方 useMemo 保证引用稳定
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, moduleType, templateId, docHtml, values]);

  const handleExport = async () => {
    if (onExport) {
      await onExport();
      return;
    }
    const name =
      filename || procurementExportFilename(projectAbbr, content, moduleType);
    await exportProcurementWord({ moduleType, taskId, templateId, docHtml, values, filename: name });
    message.success(`已导出：${name}`);
  };

  return (
    <Modal
      title={modalTitle}
      open={open}
      width={1000}
      footer={[
        <Button key="back" onClick={onClose}>
          返回修改
        </Button>,
        <Button key="export" icon={<DownloadOutlined />} onClick={handleExport}>
          导出 Word
        </Button>,
        ...(mode === 'publish' && onPublish
          ? [
              <Popconfirm
                key="publish"
                title={confirmTitle}
                description={confirmDescription}
                onConfirm={onPublish}
              >
                <Button type="primary" icon={<SendOutlined />} loading={publishing}>
                  确认发布
                </Button>
              </Popconfirm>,
            ]
          : [
              <Button key="close" type="primary" onClick={onClose}>
                关闭
              </Button>,
            ]),
      ]}
      onCancel={onClose}
    >
      {tipMessage && mode === 'publish' && (
        <Alert type="info" showIcon style={{ marginBottom: 12 }} message={tipMessage} />
      )}
      {tplName && (
        <Alert
          type="info"
          showIcon
          style={{ marginBottom: 12 }}
          message={`本模块已配置采购模板「${tplName}」，以下内容以模板为底稿生成。`}
        />
      )}
      <Spin spinning={building} tip="正在生成预览…">
        <div
          style={{
            maxHeight: '58vh',
            minHeight: 120,
            overflow: 'auto',
            border: '1px solid #eee',
            padding: 24,
          }}
          dangerouslySetInnerHTML={{
            __html: highlightPlaceholders(html) || '<p style="color:#999">暂无内容</p>',
          }}
        />
      </Spin>
    </Modal>
  );
}
