import { useEffect, useMemo, useRef, useState } from 'react';
import {
  BoldOutlined,
  ItalicOutlined,
  UnderlineOutlined,
  StrikethroughOutlined,
  AlignLeftOutlined,
  AlignCenterOutlined,
  AlignRightOutlined,
  UnorderedListOutlined,
  OrderedListOutlined,
  UndoOutlined,
  RedoOutlined,
  ClearOutlined,
  FontSizeOutlined,
  BranchesOutlined,
  TableOutlined,
  FontColorsOutlined,
  BgColorsOutlined,
  VerticalAlignMiddleOutlined,
  LineOutlined,
  FullscreenOutlined,
  FullscreenExitOutlined,
  SearchOutlined,
  PictureOutlined,
} from '@ant-design/icons';
import { Button, Select, Space, Tooltip, Modal, Input, Tag, Divider, Collapse, Popover } from 'antd';
import type { VarGroup } from '@/pages/Clauses';

export interface RichTextEditorProps {
  /** 编辑器内容（HTML 字符串） */
  value?: string;
  onChange?: (html: string) => void;
  /** 扁平变量名列表（兼容旧用法） */
  variables?: string[];
  /** 分类变量（优先于 variables），用于「插入变量」面板 */
  variableGroups?: VarGroup[];
  placeholder?: string;
  minHeight?: number;
  disabled?: boolean;
}

/** 中文字号（pt） */
const CN_SIZES = [
  { label: '初号', value: 42 },
  { label: '小初', value: 36 },
  { label: '一号', value: 26 },
  { label: '小一', value: 24 },
  { label: '二号', value: 22 },
  { label: '小二', value: 18 },
  { label: '三号', value: 16 },
  { label: '小三', value: 15 },
  { label: '四号', value: 14 },
  { label: '小四', value: 12 },
  { label: '五号', value: 10.5 },
  { label: '小五', value: 9 },
];

/** 常用中文字体 */
const CN_FONTS = [
  { label: '宋体', value: '宋体' },
  { label: '仿宋', value: '仿宋' },
  { label: '黑体', value: '黑体' },
  { label: '微软雅黑', value: '微软雅黑' },
  { label: '楷体', value: '楷体' },
];

/** 预置样式（通过 formatBlock 套用块级标签） */
const BLOCK_STYLES = [
  { label: '标题1', tag: 'H1' },
  { label: '标题2', tag: 'H2' },
  { label: '标题3', tag: 'H3' },
  { label: '正文', tag: 'P' },
  { label: '引用', tag: 'BLOCKQUOTE' },
];

/**
 * 零依赖富文本编辑器（contentEditable + execCommand）。
 * 用于合同模板正文、条款内容等需要排版 + 变量占位符的场景。
 * 已支持：加粗/斜体/下划线/删除线、对齐（含两端对齐）、有序/无序列表、
 * 字体/字号、字体颜色/背景色、预置样式、表格、分页符、撤销/重做、清除格式、
 * 插入变量（分类+搜索）、查找替换、全屏。
 */
export default function RichTextEditor({
  value,
  onChange,
  variables = [],
  variableGroups,
  placeholder = '请输入内容…',
  minHeight = 320,
  disabled = false,
}: RichTextEditorProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [focused, setFocused] = useState(false);
  const [fontSize, setFontSize] = useState(12);
  const [fontFamily, setFontFamily] = useState('宋体');
  const [fullscreen, setFullscreen] = useState(false);
  const [varOpen, setVarOpen] = useState(false);
  const [varSearch, setVarSearch] = useState('');

  // 查找替换弹窗
  const [frOpen, setFrOpen] = useState(false);
  const [findText, setFindText] = useState('');
  const [replaceText, setReplaceText] = useState('');

  const groups: VarGroup[] = useMemo(() => {
    if (variableGroups && variableGroups.length) return variableGroups;
    if (variables.length) return [{ label: '变量', items: variables.map((v) => ({ key: v })) }];
    return [];
  }, [variableGroups, variables]);

  const flatVars = useMemo(
    () => groups.flatMap((g) => g.items.map((i) => ({ ...i, group: g.label }))),
    [groups],
  );
  const filteredVars = useMemo(() => {
    const kw = varSearch.trim();
    if (!kw) return flatVars;
    return flatVars.filter((v) => v.key.includes(kw) || (v.tip && v.tip.includes(kw)));
  }, [flatVars, varSearch]);

  // 外部 value 变化（如切换编辑记录）时同步到编辑区
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const next = value || '';
    if (next !== el.innerHTML) el.innerHTML = next;
  }, [value]);

  const emit = () => {
    const html = ref.current?.innerHTML || '';
    onChange?.(html);
  };

  const exec = (cmd: string, arg?: string) => {
    if (disabled) return;
    ref.current?.focus();
    document.execCommand(cmd, false, arg);
    emit();
  };

  /** 将选区（或光标处）用指定 inline style 的 span 包裹 */
  const surroundStyle = (style: string) => {
    if (disabled) return;
    const el = ref.current;
    if (!el) return;
    el.focus();
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) {
      document.execCommand('insertHTML', false, `<span style="${style}"></span>`);
      emit();
      return;
    }
    const range = sel.getRangeAt(0);
    if (!el.contains(range.commonAncestorContainer)) {
      range.selectNodeContents(el);
      range.collapse(false);
    }
    const span = document.createElement('span');
    span.setAttribute('style', style);
    try {
      range.surroundContents(span);
    } catch {
      span.appendChild(range.extractContents());
      range.insertNode(span);
    }
    sel.removeAllRanges();
    const r = document.createRange();
    r.selectNodeContents(span);
    sel.addRange(r);
    emit();
  };

  const formatBlock = (tag: string) => {
    if (disabled) return;
    ref.current?.focus();
    document.execCommand('formatBlock', false, tag);
    emit();
  };

  /** 在光标处插入变量占位符；表格类使用双花括号原始文本 */
  const insertVariable = (item: { key: string; raw?: string }) => {
    if (disabled) return;
    const text = item.raw || `{${item.key}}`;
    ref.current?.focus();
    const el = ref.current;
    const sel = window.getSelection();
    if (!el || !sel || sel.rangeCount === 0) {
      document.execCommand('insertText', false, text);
      emit();
      return;
    }
    const range = sel.getRangeAt(0);
    if (!el.contains(range.commonAncestorContainer)) {
      range.selectNodeContents(el);
      range.collapse(false);
    }
    range.deleteContents();
    const node = document.createTextNode(text);
    range.insertNode(node);
    range.setStartAfter(node);
    range.collapse(true);
    sel.removeAllRanges();
    sel.addRange(range);
    setVarOpen(false);
    emit();
  };

  const insertTable = () => {
    if (disabled) return;
    const html =
      '<table border="1" cellspacing="0" cellpadding="6" style="border-collapse:collapse;width:100%">' +
      '<tr><td>项目</td><td>内容</td></tr><tr><td>&nbsp;</td><td>&nbsp;</td></tr>' +
      '<tr><td>&nbsp;</td><td>&nbsp;</td></tr></table><p><br/></p>';
    ref.current?.focus();
    document.execCommand('insertHTML', false, html);
    emit();
  };

  const insertPageBreak = () => {
    if (disabled) return;
    ref.current?.focus();
    document.execCommand(
      'insertHTML',
      false,
      '<div style="page-break-before:always;height:0;border-top:1px dashed #d48806;margin:8px 0;" contenteditable="false">（分页符）</div><p><br/></p>',
    );
    emit();
  };

  const applyFontFamily = (f: string) => {
    setFontFamily(f);
    exec('fontName', f);
  };

  const applyFontSize = (pt: number) => {
    setFontSize(pt);
    surroundStyle(`font-size:${pt}pt`);
  };

  const applyColor = (cmd: 'foreColor' | 'hiliteColor', color: string) => {
    if (disabled) return;
    ref.current?.focus();
    document.execCommand('styleWithCSS', false, 'true');
    document.execCommand(cmd, false, color);
    emit();
  };

  const doFind = () => {
    if (!findText) return;
    const el = ref.current;
    if (el) {
      el.focus();
      (window as any).find?.(findText, false, false, true);
    }
  };

  const doReplaceAll = () => {
    const el = ref.current;
    if (!el || !findText) return;
    const html = el.innerHTML;
    // 仅替换可见文本节点中的匹配（避免破坏标签）
    const escaped = findText.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(escaped, 'g');
    const walk = (node: Node) => {
      if (node.nodeType === Node.TEXT_NODE) {
        if (node.textContent && re.test(node.textContent)) {
          const span = document.createElement('span');
          span.innerHTML = node.textContent.replace(re, replaceText);
          node.parentNode?.replaceChild(span, node);
        }
      } else {
        node.childNodes.forEach((c) => walk(c));
      }
    };
    walk(el);
    emit();
    setFrOpen(false);
  };

  const btn = (title: string, icon: React.ReactNode, cmd: string, arg?: string) => (
    <Tooltip title={title} key={title}>
      <Button size="small" type="text" icon={icon} disabled={disabled} onMouseDown={(e) => e.preventDefault()} onClick={() => exec(cmd, arg)} />
    </Tooltip>
  );

  const variableModal = (
    <div style={{ width: 380, maxHeight: 420, overflow: 'auto' }}>
      <Input
        allowClear
        prefix={<SearchOutlined />}
        placeholder="搜索变量名称"
        value={varSearch}
        onChange={(e) => setVarSearch(e.target.value)}
        style={{ marginBottom: 8 }}
      />
      <Collapse
        size="small"
        defaultActiveKey={groups.map((_, i) => String(i))}
        items={groups.map((g, i) => ({
          key: String(i),
          label: `${g.label}（${g.items.length}）`,
          children: (
            <Space size={[4, 6]} wrap>
              {(kwFilter(g, varSearch).length ? kwFilter(g, varSearch) : g.items).map((it) => (
                <Tooltip title={it.tip || it.raw || `{${it.key}}`} key={it.key}>
                  <Tag style={{ cursor: 'pointer' }} onClick={() => insertVariable(it)}>
                    {it.raw || `{${it.key}}`}
                  </Tag>
                </Tooltip>
              ))}
            </Space>
          ),
        }))}
      />
    </div>
  );

  const fileRef = useRef<HTMLInputElement>(null);
  const insertImage = () => fileRef.current?.click();
  const onImagePicked = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => exec('insertImage', String(reader.result));
    reader.readAsDataURL(file);
    e.target.value = '';
  };

  const toolbar = (
    <div
      style={{
        display: 'flex',
        flexWrap: 'wrap',
        alignItems: 'center',
        gap: 2,
        padding: '4px 8px',
        borderBottom: '1px solid #f0f0f0',
        background: '#fafafa',
      }}
    >
      <Tooltip title="字体">
        <Select
          size="small"
          value={fontFamily}
          disabled={disabled}
          style={{ width: 96, marginRight: 4 }}
          options={CN_FONTS}
          onMouseDown={(e) => e.preventDefault()}
          onChange={applyFontFamily}
        />
      </Tooltip>
      <Tooltip title="字号">
        <Select
          size="small"
          value={fontSize}
          disabled={disabled}
          style={{ width: 84, marginRight: 4 }}
          options={CN_SIZES.map((s) => ({ label: s.label, value: s.value }))}
          onMouseDown={(e) => e.preventDefault()}
          onChange={(v) => applyFontSize(Number(v))}
          suffixIcon={<FontSizeOutlined />}
        />
      </Tooltip>
      {btn('加粗', <BoldOutlined />, 'bold')}
      {btn('斜体', <ItalicOutlined />, 'italic')}
      {btn('下划线', <UnderlineOutlined />, 'underline')}
      {btn('删除线', <StrikethroughOutlined />, 'strikeThrough')}
      <Tooltip title="字体颜色">
        <Popover
          trigger="click"
          content={
            <Space wrap style={{ maxWidth: 200 }}>
              {['#000000', '#d4380d', '#389e0d', '#096dd9', '#722ed1', '#ad6800'].map((c) => (
                <span
                  key={c}
                  onClick={() => applyColor('foreColor', c)}
                  style={{ width: 22, height: 22, background: c, display: 'inline-block', cursor: 'pointer', borderRadius: 3, border: '1px solid #d9d9d9' }}
                />
              ))}
            </Space>
          }
        >
          <Button size="small" type="text" icon={<FontColorsOutlined />} disabled={disabled} onMouseDown={(e) => e.preventDefault()} />
        </Popover>
      </Tooltip>
      <Tooltip title="背景颜色">
        <Popover
          trigger="click"
          content={
            <Space wrap style={{ maxWidth: 200 }}>
              {['#fff1b8', '#ffccc7', '#b7eb8f', '#bae0ff', '#efdbff', '#fff'].map((c) => (
                <span
                  key={c}
                  onClick={() => applyColor('hiliteColor', c)}
                  style={{ width: 22, height: 22, background: c, display: 'inline-block', cursor: 'pointer', borderRadius: 3, border: '1px solid #d9d9d9' }}
                />
              ))}
            </Space>
          }
        >
          <Button size="small" type="text" icon={<BgColorsOutlined />} disabled={disabled} onMouseDown={(e) => e.preventDefault()} />
        </Popover>
      </Tooltip>
      <Divider type="vertical" style={{ margin: '0 4px' }} />
      {btn('左对齐', <AlignLeftOutlined />, 'justifyLeft')}
      {btn('居中', <AlignCenterOutlined />, 'justifyCenter')}
      {btn('右对齐', <AlignRightOutlined />, 'justifyRight')}
      <Tooltip title="两端对齐">
        <Button size="small" type="text" disabled={disabled} onMouseDown={(e) => e.preventDefault()} onClick={() => exec('justifyFull')}>
          两端
        </Button>
      </Tooltip>
      <Divider type="vertical" style={{ margin: '0 4px' }} />
      {btn('无序列表', <UnorderedListOutlined />, 'insertUnorderedList')}
      {btn('有序列表', <OrderedListOutlined />, 'insertOrderedList')}
      <Tooltip title="预置样式">
        <Select
          size="small"
          value=""
          disabled={disabled}
          style={{ width: 92, marginRight: 4 }}
          placeholder="样式"
          options={BLOCK_STYLES.map((s) => ({ label: s.label, value: s.tag }))}
          onMouseDown={(e) => e.preventDefault()}
          onChange={(v) => formatBlock(String(v))}
          suffixIcon={<VerticalAlignMiddleOutlined />}
        />
      </Tooltip>
      <Tooltip title="插入表格">
        <Button size="small" type="text" icon={<TableOutlined />} disabled={disabled} onMouseDown={(e) => e.preventDefault()} onClick={insertTable} />
      </Tooltip>
      <Tooltip title="插入图片">
        <Button size="small" type="text" icon={<PictureOutlined />} disabled={disabled} onMouseDown={(e) => e.preventDefault()} onClick={insertImage} />
      </Tooltip>
      <Tooltip title="插入分页符">
        <Button size="small" type="text" icon={<LineOutlined />} disabled={disabled} onMouseDown={(e) => e.preventDefault()} onClick={insertPageBreak} />
      </Tooltip>
      <Divider type="vertical" style={{ margin: '0 4px' }} />
      {btn('撤销', <UndoOutlined />, 'undo')}
      {btn('重做', <RedoOutlined />, 'redo')}
      {btn('清除格式', <ClearOutlined />, 'removeFormat')}
      <Tooltip title="查找/替换">
        <Button size="small" type="text" icon={<SearchOutlined />} disabled={disabled} onMouseDown={(e) => e.preventDefault()} onClick={() => setFrOpen(true)} />
      </Tooltip>
      <Tooltip title="插入变量">
        <Button size="small" type="text" icon={<BranchesOutlined />} disabled={disabled} onMouseDown={(e) => e.preventDefault()} onClick={() => setVarOpen(true)}>
          插入变量
        </Button>
      </Tooltip>
      <Tooltip title={fullscreen ? '退出全屏' : '全屏'}>
        <Button
          size="small"
          type="text"
          icon={fullscreen ? <FullscreenExitOutlined /> : <FullscreenOutlined />}
          disabled={disabled}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => setFullscreen((f) => !f)}
        />
      </Tooltip>
    </div>
  );

  const containerStyle: React.CSSProperties = fullscreen
    ? {
        position: 'fixed',
        inset: 0,
        zIndex: 1000,
        background: '#fff',
        display: 'flex',
        flexDirection: 'column',
      }
    : {
        border: `1px solid ${focused ? '#1677ff' : '#d9d9d9'}`,
        borderRadius: 6,
        background: disabled ? '#f5f5f5' : '#fff',
        overflow: 'hidden',
      };

  return (
    <div style={containerStyle}>
      {toolbar}
      <div
        ref={ref}
        contentEditable={!disabled}
        suppressContentEditableWarning
        onInput={emit}
        onBlur={() => {
          setFocused(false);
          emit();
        }}
        onFocus={() => setFocused(true)}
        data-placeholder={placeholder}
        style={{
          minHeight: fullscreen ? 'calc(100vh - 44px)' : minHeight,
          maxHeight: fullscreen ? undefined : 560,
          overflowY: 'auto',
          padding: 12,
          outline: 'none',
          lineHeight: 1.8,
          fontSize: 14,
        }}
        className="cms-rich-text"
      />
      <input ref={fileRef} type="file" accept="image/*" style={{ display: 'none' }} onChange={onImagePicked} />
      <style>{`
        .cms-rich-text:empty::before {
          content: attr(data-placeholder);
          color: #bfbfbf;
        }
        .cms-rich-text table { border-collapse: collapse; width: 100%; margin: 8px 0; }
        .cms-rich-text td { border: 1px solid #d9d9d9; padding: 6px; }
        .cms-rich-text p { margin: 0 0 8px; }
        .cms-rich-text ol, .cms-rich-text ul { padding-left: 24px; margin: 4px 0; }
        .cms-rich-text h1 { font-size: 18pt; text-align: center; font-family: "黑体", SimHei, sans-serif; }
        .cms-rich-text h2 { font-size: 14pt; font-family: "黑体", SimHei, sans-serif; }
        .cms-rich-text blockquote { border-left: 3px solid #d9d9d9; padding-left: 12px; color: #595959; margin: 8px 0; }
      `}</style>

      <Modal title="插入变量" open={varOpen} footer={null} onCancel={() => setVarOpen(false)} width={440} destroyOnClose>
        {variableModal}
      </Modal>

      <Modal
        title="查找 / 替换"
        open={frOpen}
        onCancel={() => setFrOpen(false)}
        onOk={doReplaceAll}
        okText="替换全部"
        okButtonProps={{ disabled: !findText }}
      >
        <Space direction="vertical" style={{ width: '100%' }}>
          <Input
            prefix={<SearchOutlined />}
            placeholder="查找内容"
            value={findText}
            onChange={(e) => setFindText(e.target.value)}
            onPressEnter={doFind}
          />
          <Button block onClick={doFind} disabled={!findText}>
            查找下一个
          </Button>
          <Input placeholder="替换为" value={replaceText} onChange={(e) => setReplaceText(e.target.value)} />
        </Space>
      </Modal>
    </div>
  );
}

/** 按关键词过滤某组的变量 */
function kwFilter(g: VarGroup, kw: string): VarGroup['items'] {
  const t = (kw || '').trim();
  if (!t) return g.items;
  return g.items.filter((it) => it.key.includes(t) || (it.tip && it.tip.includes(t)));
}
