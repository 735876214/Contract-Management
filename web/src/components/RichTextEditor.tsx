import { useEffect, useRef, useState } from 'react';
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
} from '@ant-design/icons';
import { Button, Select, Space, Tooltip, Popover, Tag, Divider } from 'antd';

export interface RichTextEditorProps {
  /** 编辑器内容（HTML 字符串） */
  value?: string;
  onChange?: (html: string) => void;
  /** 可插入的变量占位符名称列表，如 ['合同编号', '供应商名称'] */
  variables?: string[];
  placeholder?: string;
  minHeight?: number;
  disabled?: boolean;
}

/** HTML font size 1~7 对应的字号（pt） */
const FONT_SIZES = [
  { label: '10pt', value: '2' },
  { label: '12pt', value: '3' },
  { label: '14pt', value: '4' },
  { label: '18pt', value: '5' },
  { label: '24pt', value: '6' },
];

/**
 * 零依赖富文本编辑器（contentEditable + execCommand）。
 * 用于合同模板正文、条款内容等需要排版 + 变量占位符的场景。
 */
export default function RichTextEditor({
  value,
  onChange,
  variables = [],
  placeholder = '请输入内容…',
  minHeight = 320,
  disabled = false,
}: RichTextEditorProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [fontSize, setFontSize] = useState('3');
  const [focused, setFocused] = useState(false);
  const [varOpen, setVarOpen] = useState(false);

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

  /** 在光标处插入变量占位符，如 {合同编号} */
  const insertVariable = (name: string) => {
    if (disabled) return;
    ref.current?.focus();
    const text = `{${name}}`;
    const el = ref.current;
    const sel = window.getSelection();
    if (!el || !sel || sel.rangeCount === 0) {
      document.execCommand('insertText', false, text);
      emit();
      return;
    }
    const range = sel.getRangeAt(0);
    if (!el.contains(range.commonAncestorContainer)) {
      // 光标不在编辑区内时追加到末尾
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

  const btn = (title: string, icon: React.ReactNode, cmd: string, arg?: string) => (
    <Tooltip title={title} key={title}>
      <Button size="small" type="text" icon={icon} disabled={disabled} onMouseDown={(e) => e.preventDefault()} onClick={() => exec(cmd, arg)} />
    </Tooltip>
  );

  const variablePanel = (
    <div style={{ maxWidth: 320 }}>
      <div style={{ marginBottom: 6, color: '#8c8c8c' }}>点击插入到光标处</div>
      <Space size={[4, 6]} wrap>
        {variables.length === 0 && <span style={{ color: '#bfbfbf' }}>暂无可用变量</span>}
        {variables.map((v) => (
          <Tag key={v} style={{ cursor: 'pointer' }} onClick={() => insertVariable(v)}>
            {`{${v}}`}
          </Tag>
        ))}
      </Space>
    </div>
  );

  return (
    <div
      style={{
        border: `1px solid ${focused ? '#1677ff' : '#d9d9d9'}`,
        borderRadius: 6,
        background: disabled ? '#f5f5f5' : '#fff',
        overflow: 'hidden',
      }}
    >
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
        <Tooltip title="字号">
          <Select
            size="small"
            value={fontSize}
            disabled={disabled}
            style={{ width: 80, marginRight: 4 }}
            options={FONT_SIZES}
            onMouseDown={(e) => e.preventDefault()}
            onChange={(v) => {
              setFontSize(v);
              exec('fontSize', v);
            }}
            suffixIcon={<FontSizeOutlined />}
          />
        </Tooltip>
        {btn('加粗', <BoldOutlined />, 'bold')}
        {btn('斜体', <ItalicOutlined />, 'italic')}
        {btn('下划线', <UnderlineOutlined />, 'underline')}
        {btn('删除线', <StrikethroughOutlined />, 'strikeThrough')}
        <Divider type="vertical" style={{ margin: '0 4px' }} />
        {btn('左对齐', <AlignLeftOutlined />, 'justifyLeft')}
        {btn('居中', <AlignCenterOutlined />, 'justifyCenter')}
        {btn('右对齐', <AlignRightOutlined />, 'justifyRight')}
        <Divider type="vertical" style={{ margin: '0 4px' }} />
        {btn('无序列表', <UnorderedListOutlined />, 'insertUnorderedList')}
        {btn('有序列表', <OrderedListOutlined />, 'insertOrderedList')}
        <Tooltip title="插入表格" key="table">
          <Button size="small" type="text" icon={<TableOutlined />} disabled={disabled} onMouseDown={(e) => e.preventDefault()} onClick={insertTable} />
        </Tooltip>
        <Divider type="vertical" style={{ margin: '0 4px' }} />
        {btn('撤销', <UndoOutlined />, 'undo')}
        {btn('重做', <RedoOutlined />, 'redo')}
        {btn('清除格式', <ClearOutlined />, 'removeFormat')}
        <Divider type="vertical" style={{ margin: '0 4px' }} />
        <Popover content={variablePanel} trigger="click" open={varOpen} onOpenChange={setVarOpen} placement="bottomLeft">
          <Button size="small" type="text" icon={<BranchesOutlined />} disabled={disabled} onMouseDown={(e) => e.preventDefault()}>
            插入变量
          </Button>
        </Popover>
      </div>

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
          minHeight,
          maxHeight: 560,
          overflowY: 'auto',
          padding: 12,
          outline: 'none',
          lineHeight: 1.8,
          fontSize: 14,
        }}
        className="cms-rich-text"
      />

      <style>{`
        .cms-rich-text:empty::before {
          content: attr(data-placeholder);
          color: #bfbfbf;
        }
        .cms-rich-text table { border-collapse: collapse; width: 100%; margin: 8px 0; }
        .cms-rich-text td { border: 1px solid #d9d9d9; padding: 6px; }
        .cms-rich-text p { margin: 0 0 8px; }
        .cms-rich-text ol, .cms-rich-text ul { padding-left: 24px; margin: 4px 0; }
      `}</style>
    </div>
  );
}
