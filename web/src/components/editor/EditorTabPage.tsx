import type { ReactNode } from 'react';
import { Button, Modal, Space } from 'antd';
import { CheckOutlined } from '@ant-design/icons';
import { useTabsStore } from '@/store/tabs';
import { useEditorTab, useTabDirty } from '@/hooks/useTabs';

/**
 * 「编辑器页签」的通用外壳（形态约定见 `docs/` 与 `useEditorTab` 的注释）。
 *
 * 为什么不再用弹窗：新增合同 / 采购任务 / 各类台账的表单普遍比一屏高，
 * 弹窗要么底部按钮被滚出视口（采购发起就踩过：Modal 没设 `styles.body.maxHeight`），
 * 要么内部再套一层滚动条，编辑体验与"同时对照另一个页面"的诉求都差。
 * 改成**多页签上的一个独立页面**后：底部操作栏天然 sticky、可以并列打开多个编辑器、
 * 保存后回到列表标签即可对比结果。
 *
 * 本组件只负责"壳"：页头 / 正文 / sticky 底栏 / 关闭确认 / 保存成功后的收尾（刷新列表 + 关标签）。
 * 表单本身原样从弹窗里搬进来，字段与校验规则不动。
 */

export interface EditorTabPageProps {
  /** 所属**列表**路径（如 `/settlement/order`）；用于关闭本标签后回到列表并让它重新取数 */
  listPath: string;
  /** 页头标题（如「新增结算单」「编辑合同」） */
  title: ReactNode;
  /** 页头右侧补充（状态 Tag、编号等） */
  titleExtra?: ReactNode;
  children: ReactNode;
  /** 保存回调；抛错视为失败（不关标签、不刷新列表，错误提示由调用方或 axios 拦截器给） */
  onSave?: () => Promise<unknown> | unknown;
  /** 保存按钮文案（默认「保 存」） */
  saveText?: string;
  /** 保存进行中 */
  saving?: boolean;
  /** 底栏左侧的附加操作（如「预览合同」「上传附件」） */
  footerLeft?: ReactNode;
  /** 底栏右侧、保存按钮之前的附加操作 */
  footerExtra?: ReactNode;
  /** 是否有未保存内容：关闭标签/点取消时会先确认，标签上也会打一个点 */
  dirty?: boolean;
  /** 保存成功后是否关掉本标签（默认 true）；false 时只刷新列表、留在编辑器里继续编辑 */
  closeOnSave?: boolean;
}

export default function EditorTabPage({
  listPath,
  title,
  titleExtra,
  children,
  onSave,
  saveText = '保 存',
  saving,
  footerLeft,
  footerExtra,
  dirty,
  closeOnSave = true,
}: EditorTabPageProps) {
  const editorTab = useEditorTab(listPath);
  const bumpRefresh = useTabsStore((s) => s.bumpRefresh);
  // 上报脏状态：标签栏的关闭按钮据此先弹确认（标签上也会打一个琥珀点）
  useTabDirty(editorTab.tabKey, !!dirty);

  const handleCancel = () => {
    if (!dirty) {
      editorTab.closeEditor({ refresh: false });
      return;
    }
    Modal.confirm({
      title: '放弃未保存的内容？',
      content: '关闭后本次修改不会生效。',
      okText: '放弃并关闭',
      okType: 'danger',
      cancelText: '继续编辑',
      onOk: () => editorTab.closeEditor({ refresh: false }),
    });
  };

  const handleSave = async () => {
    if (!onSave) return;
    try {
      await onSave();
    } catch {
      // 具体错误已由调用方或 axios 拦截器提示（CLAUDE.md 铁律 2）；这里只负责"不关标签"
      return;
    }
    if (closeOnSave) editorTab.closeEditor();
    else bumpRefresh(listPath);
  };

  return (
    <div className="page-card cms-editor">
      <div className="cms-editor__head">
        <span className="cms-serif-title cms-title-section">{title}</span>
        {titleExtra}
      </div>
      <div className="cms-editor__body">{children}</div>
      <div className="cms-editor__footer">
        <Space wrap size={8}>
          {footerLeft}
        </Space>
        <Space wrap size={8}>
          {footerExtra}
          <Button onClick={handleCancel}>取 消</Button>
          {onSave && (
            <Button type="primary" icon={<CheckOutlined />} loading={saving} onClick={handleSave}>
              {saveText}
            </Button>
          )}
        </Space>
      </div>
    </div>
  );
}
