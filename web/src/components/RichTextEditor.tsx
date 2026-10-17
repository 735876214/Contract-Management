import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
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
  MoreOutlined,
} from '@ant-design/icons';
import { Button, Select, Space, Tooltip, Modal, Input, Tag, Divider, Collapse, Popover } from 'antd';
import type { VarGroup } from '@/pages/Clauses';
import { useContainerWidth } from '@/hooks/useContainerWidth';

export interface RichTextEditorProps {
  /** 编辑器内容（HTML 字符串） */
  value?: string;
  onChange?: (html: string) => void;
  /** 扁平变量名列表（兼容旧用法） */
  variables?: string[];
  /** 分类变量（优先于 variables），用于「插入变量」面板 */
  variableGroups?: VarGroup[];
  /**
   * 变量所属体系：面板顶部会据此显示提示。
   *
   * ⚠️ **三套变量体系互不相通**（采购模板 / 合同模板 / 单据模板）：同名 `{{项目名称}}` 由
   * **不同代码**替换、规则也不同。面板不标明体系时，作者很容易在合同正文里插入采购变量——那会
   * **静默不替换**（正文里留着占位符，预览才高亮）。凡传了 `variables`/`variableGroups` 的调用点
   * 都应传本属性，由 `server/test/procurementVariables.spec.mts` 的源码扫描锁定。
   */
  variableScope?: 'contract' | 'procurement' | 'doc';
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
  variableScope,
  placeholder = '请输入内容…',
  minHeight = 320,
  disabled = false,
}: RichTextEditorProps) {
  /**
   * **容器**级响应式（DESIGN.md §10.2）：工具栏折行按**编辑器自身宽度**决定，不再看视口。
   * 同一个编辑器在整页表单里和 900px 弹窗里宽度差很多，视口判断会给出错误答案。
   *
   * 这里**不用** `.cq` + `@container`：折行本身要读 JS 状态（`toolsOpen`），
   * 且本组件的根元素在全屏模式下就是那个 `position: fixed; inset: 0` 的层
   * （它已 portal 到 body，见 `frame` 注释）——给可查自身的元素挂容器标记既无意义也会踩
   * containment 的包含块问题。故走 `useContainerWidth()`。
   */
  const { ref: cqRef, size: containerSize } = useContainerWidth<HTMLDivElement>();
  const isNarrow = containerSize.isNarrow;
  const ref = useRef<HTMLDivElement>(null);
  const [focused, setFocused] = useState(false);
  const [fontSize, setFontSize] = useState(12);
  const [fontFamily, setFontFamily] = useState('宋体');
  const [fullscreen, setFullscreen] = useState(false);
  const [varOpen, setVarOpen] = useState(false);
  const [varSearch, setVarSearch] = useState('');

  /** 进入全屏会重建 DOM 节点（portal 切换），主动 focus 一次让人能接着打字 */
  useEffect(() => {
    if (fullscreen) ref.current?.focus();
  }, [fullscreen]);

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

  /**
   * 外部 value 变化（如切换编辑记录）时同步到编辑区。
   *
   * ⚠️ 依赖里必须带 `fullscreen`：切换全屏时**组件本身不会重挂载**（只是它的 DOM 子树
   * 从弹窗里挪到了 body 下），新渲染出来的 `contentEditable` 节点是空的，而 `[value]`
   * 这个依赖没变 → 这个 effect 不会重跑 → 编辑区内容**静默丢失**。
   * （2026-10-15 真渲染验收抓到：输入 15 次 `input` 事件后点全屏，内容变空，而表单校验
   * 证明 Form 里其实存着值 —— 丢的只是 DOM。）
   */
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const next = value || '';
    if (next !== el.innerHTML) el.innerHTML = next;
  }, [value, fullscreen]);

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

  /**
   * 在光标处插入变量占位符。
   *
   * ⚠️ 默认插**双花括号** `{{变量名}}`：渲染器（`template-render.ts`）只认双花括号，
   * 单花括号的兼容分支早已按业务要求移除 —— 插成 `{变量名}` 会**静默不替换**
   * （正文里留着占位符、只有预览才高亮），作者几乎发现不了。
   * `raw` 仍可覆盖（表格类占位符等非变量文本）。
   */
  const insertVariable = (item: { key: string; raw?: string }) => {
    if (disabled) return;
    const text = item.raw || `{{${item.key}}}`;
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

  // ==================== 表格编辑（2026-10-17：行列增删 / 合并单元格） ====================
  // execCommand 不支持表格结构操作，直接对 DOM 做 insertRow/insertCell 等，完成后 emit()。
  const [activeCell, setActiveCell] = useState<{ cell: HTMLTableCellElement; table: HTMLTableElement } | null>(null);

  /** 从选区向上找光标所在单元格与其表格 */
  const trackCell = () => {
    const el = ref.current;
    const sel = window.getSelection();
    if (!el || !sel || sel.rangeCount === 0) return setActiveCell(null);
    let node: Node | null = sel.getRangeAt(0).startContainer;
    while (node && node !== el) {
      if (node instanceof HTMLTableCellElement && node.parentElement instanceof HTMLTableElement && el.contains(node)) {
        setActiveCell({ cell: node, table: node.parentElement });
        return;
      }
      node = node.parentNode;
    }
    setActiveCell(null);
  };

  /** 表格编辑统一入口：mutate 后必须 emit 同步表单值；占位符在文本节点里不受结构操作影响 */
  const mutateTable = (fn: (table: HTMLTableElement, cell: HTMLTableCellElement) => void) => {
    if (disabled || !activeCell) return;
    try {
      fn(activeCell.table, activeCell.cell);
      emit();
    } catch {
      /* 结构异常（如合并后的边缘 case）时静默失败，避免把编辑区搞崩 */
    }
  };

  const findCellIndex = (row: HTMLTableRowElement, cell: HTMLTableCellElement) =>
    Array.from(row.cells).indexOf(cell);

  const insertRowAbove = () =>
    mutateTable((table, cell) => {
      const row = cell.parentElement as HTMLTableRowElement;
      const newRow = table.insertRow(row.rowIndex);
      for (let i = 0; i < row.cells.length; i++) newRow.insertCell(i).innerHTML = '&nbsp;';
    });

  const insertRowBelow = () =>
    mutateTable((table, cell) => {
      const row = cell.parentElement as HTMLTableRowElement;
      const newRow = table.insertRow(row.rowIndex + 1);
      for (let i = 0; i < row.cells.length; i++) newRow.insertCell(i).innerHTML = '&nbsp;';
    });

  /** 在目标行参照列插一列（保持同列 index，容忍 colSpan 造成的列数不齐） */
  const insertColumnAt = (after: boolean) =>
    mutateTable((_table, cell) => {
      const row = cell.parentElement as HTMLTableRowElement;
      const idx = findCellIndex(row, cell) + (after ? 1 : 0);
      const tbody = row.parentElement as HTMLTableSectionElement;
      Array.from(tbody.rows).forEach((r) => {
        const refCell = r.cells[Math.min(idx, r.cells.length - 1)];
        const newCell = r.insertCell(Math.min(idx, r.cells.length));
        if (refCell) newCell.style.cssText = refCell.style.cssText;
        newCell.innerHTML = '&nbsp;';
      });
    });

  const deleteRow = () =>
    mutateTable((table, cell) => {
      const row = cell.parentElement as HTMLTableRowElement;
      if (table.rows.length <= 1) return; // 防呆：只剩一行不删
      table.deleteRow(row.rowIndex);
    });

  const deleteColumn = () =>
    mutateTable((_table, cell) => {
      const row = cell.parentElement as HTMLTableRowElement;
      const tbody = row.parentElement as HTMLTableSectionElement;
      if (row.cells.length <= 1) return; // 防呆：只剩一列不删
      const idx = findCellIndex(row, cell);
      Array.from(tbody.rows).forEach((r) => {
        if (r.cells.length > 1) r.deleteCell(Math.min(idx, r.cells.length - 1));
      });
    });

  /**
   * 合并单元格：选区跨多个单元格时支持（同行相邻 → colSpan；同列 → rowSpan）；
   * 无多选时把光标所在格与其右侧/下方格合并。被并格内容**追加**进目标格（保留 {{占位符}}）。
   */
  const mergeCells = () =>
    mutateTable((table, cell) => {
      const sel = window.getSelection();
      let targets: HTMLTableCellElement[] = [];
      if (sel && sel.rangeCount > 0) {
        const range = sel.getRangeAt(0);
        if (!range.collapsed) {
          const nodes: HTMLTableCellElement[] = [];
          const walker = document.createTreeWalker(range.commonAncestorContainer, NodeFilter.SHOW_ELEMENT);
          while (walker.nextNode()) {
            const n = walker.currentNode;
            if (n instanceof HTMLTableCellElement && range.intersectsNode(n) && table.contains(n)) nodes.push(n);
          }
          targets = nodes;
        }
      }
      if (targets.length < 2) {
        const row = cell.parentElement as HTMLTableRowElement;
        const next = row.cells[findCellIndex(row, cell) + 1];
        targets = next ? [cell, next] : [];
      }
      if (targets.length < 2) return;
      const first = targets[0];
      const last = targets[targets.length - 1];
      const rowSpan = last.parentElement === first.parentElement
        ? 1
        : last.rowIndex - first.rowIndex + 1;
      const colSpan = first.parentElement === last.parentElement
        ? findCellIndex(last.parentElement as HTMLTableRowElement, last) - findCellIndex(first.parentElement as HTMLTableRowElement, first) + 1
        : first.parentElement.rowIndex === last.parentElement.rowIndex ? last.cellIndex + 1 : 1;
      // 追加内容后移除被并格
      for (let i = 1; i < targets.length; i++) {
        first.innerHTML += targets[i].innerHTML;
        targets[i].remove();
      }
      if (rowSpan > 1) first.rowSpan = rowSpan;
      if (colSpan > 1) first.colSpan = colSpan;
    });

  const deleteTable = () =>
    mutateTable((table) => {
      table.remove();
      setActiveCell(null);
    });

  const tableToolbar = activeCell ? (
    <div
      style={{
        display: 'flex',
        flexWrap: 'wrap',
        alignItems: 'center',
        gap: 2,
        padding: '2px 8px',
        borderBottom: '1px solid var(--cms-hairline-soft)',
        background: 'var(--cms-surface-soft)',
      }}
    >
      <span style={{ fontSize: 12, color: 'var(--cms-muted)', marginRight: 4 }}>表格：</span>
      <Button size="small" type="text" disabled={disabled} onMouseDown={(e) => e.preventDefault()} onClick={insertRowAbove}>上方插行</Button>
      <Button size="small" type="text" disabled={disabled} onMouseDown={(e) => e.preventDefault()} onClick={insertRowBelow}>下方插行</Button>
      <Button size="small" type="text" disabled={disabled} onMouseDown={(e) => e.preventDefault()} onClick={() => insertColumnAt(false)}>左插列</Button>
      <Button size="small" type="text" disabled={disabled} onMouseDown={(e) => e.preventDefault()} onClick={() => insertColumnAt(true)}>右插列</Button>
      <Button size="small" type="text" disabled={disabled} onMouseDown={(e) => e.preventDefault()} onClick={deleteRow}>删行</Button>
      <Button size="small" type="text" disabled={disabled} onMouseDown={(e) => e.preventDefault()} onClick={deleteColumn}>删列</Button>
      <Button size="small" type="text" disabled={disabled} onMouseDown={(e) => e.preventDefault()} onClick={mergeCells}>合并单元格</Button>
      <Button size="small" type="text" danger disabled={disabled} onMouseDown={(e) => e.preventDefault()} onClick={deleteTable}>删除表格</Button>
    </div>
  ) : null;

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
    // 宽度不能写死 380：弹窗在手机上会被全局 `max-width: calc(100vw - 16px)` 兜到 ~359px，
    // 写死会把内容顶出弹窗（V2 阶段 2 顺手修掉的容器适配问题）
    <div style={{ width: '100%', maxWidth: 380, maxHeight: 420, overflow: 'auto' }}>
      {variableScope ? (
        <div
          className="cms-hint"
          style={{ marginBottom: 8, lineHeight: 1.6, color: 'var(--cms-muted)' }}
        >
          {variableScope === 'procurement'
            ? '采购模板变量 · 只在采购文档里生效；合同正文请改用合同模板变量'
            : variableScope === 'doc'
              ? '单据模板变量 · 只在结算单/总结算单/保理单/逾期利息/付款单里生效；合同正文与采购文档请改用各自体系的变量'
              : '合同模板变量 · 只在合同正文/条款里生效；采购文档请改用采购模板变量'}
        </div>
      ) : null}
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
                <Tooltip title={it.tip || it.raw || `{{${it.key}}}`} key={it.key}>
                  <Tag style={{ cursor: 'pointer' }} onClick={() => insertVariable(it)}>
                    {it.raw || `{{${it.key}}}`}
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

  /** 窄容器工具栏：「更多」展开/收起低频项（按**编辑器自身宽度**判断，见 DESIGN.md §10.2） */
  const [toolsOpen, setToolsOpen] = useState(false);

  /** 高频工具项：宽容器与窄容器都显示 */
  const primaryTools = (
    <>
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
      {isNarrow && (
        <Tooltip title={toolsOpen ? '收起更多工具' : '更多工具'}>
          <Button
            size="small"
            type="text"
            icon={<MoreOutlined />}
            disabled={disabled}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => setToolsOpen((v) => !v)}
          />
        </Tooltip>
      )}
    </>
  );

  /** 低频工具项：窄屏默认收进「更多」，宽屏平铺显示 */
  const moreTools = (
    <>
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
                  style={{ width: 22, height: 22, background: c, display: 'inline-block', cursor: 'pointer', borderRadius: 3, border: '1px solid var(--cms-hairline)' }}
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
                  style={{ width: 22, height: 22, background: c, display: 'inline-block', cursor: 'pointer', borderRadius: 3, border: '1px solid var(--cms-hairline)' }}
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
    </>
  );

  const toolbar = (
    <div
      style={{
        display: 'flex',
        flexWrap: 'wrap',
        alignItems: 'center',
        gap: 2,
        padding: '4px 8px',
        borderBottom: '1px solid var(--cms-hairline-soft)',
        background: 'var(--cms-surface-soft)',
      }}
    >
      {primaryTools}
      {/* 窄容器：低频项默认收起，点「更多」展开；宽容器：始终平铺 */}
      {(!isNarrow || toolsOpen) && moreTools}
    </div>
  );

  const containerStyle: React.CSSProperties = fullscreen
    ? {
        position: 'fixed',
        inset: 0,
        zIndex: 1000,
        // 编辑区按「纸张」呈现（与 Word 导出对应），故用 paper 而非主题底
        background: 'var(--cms-paper)',
        display: 'flex',
        flexDirection: 'column',
      }
    : {
        border: `1px solid ${focused ? 'var(--cms-primary)' : 'var(--cms-hairline)'}`,
        borderRadius: 6,
        background: disabled ? 'var(--cms-surface-soft)' : 'var(--cms-paper)',
        overflow: 'hidden',
      };

  /**
   * 编辑器外框。
   *
   * ⚠️ **全屏时整块 portal 到 `document.body`**（而不是就地 `position: fixed`）：
   * 全屏层是 `position: fixed; inset: 0`，一旦它的某个祖先带了
   * `container-type`（containment 的 `contain: layout` 会把该祖先变成 fixed 元素的**包含块**），
   * 全屏就只会铺满那个祖先而不是视口。而本组件绝大多数使用点是**弹窗正文**，
   * 弹窗正文自 V2 阶段 5 起统一是容器（`styles/containers.css` 的 `.ant-modal-body`），
   * 曾经的"就地 fixed"必然被限制住。portal 后全屏层直接挂在 body 下，与任何容器无关。
   *
   * 副作用（可接受）：切换全屏会重建 DOM 节点 → 由 `useEffect([value])` 在挂载时回填内容，
   * 且**所有使用点都是受控的**（显式 `value`/`onChange`，或由 `Form.Item` 注入）→ 内容不丢；
   * 光标位置会重置，故进入全屏时主动 focus 一次（见下方 effect）。
   */
  const frame = (
    <div ref={cqRef} style={containerStyle}>
      {toolbar}
      {tableToolbar}
      <div
        ref={ref}
        contentEditable={!disabled}
        suppressContentEditableWarning
        onInput={emit}
        onKeyUp={trackCell}
        onMouseUp={trackCell}
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
          color: var(--cms-muted-soft);
        }
        .cms-rich-text table { border-collapse: collapse; width: 100%; margin: 8px 0; }
        .cms-rich-text td { border: 1px solid #d9d9d9; padding: 6px; }
        .cms-rich-text p { margin: 0 0 8px; }
        .cms-rich-text ol, .cms-rich-text ul { padding-left: 24px; margin: 4px 0; }
        .cms-rich-text h1 { font-size: 18pt; text-align: center; font-family: "黑体", SimHei, sans-serif; }
        .cms-rich-text h2 { font-size: 14pt; font-family: "黑体", SimHei, sans-serif; }
        .cms-rich-text blockquote { border-left: 3px solid #d9d9d9; padding-left: 12px; color: #595959; margin: 8px 0; }
      `}</style>

      <Modal title="插入变量" open={varOpen} footer={null} onCancel={() => setVarOpen(false)} width={440} destroyOnHidden>
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

  // 全屏时整块挂到 body 之下（见 `frame` 上方注释）；非全屏就地渲染
  return fullscreen ? createPortal(frame, document.body) : frame;
}

/** 按关键词过滤某组的变量 */
function kwFilter(g: VarGroup, kw: string): VarGroup['items'] {
  const t = (kw || '').trim();
  if (!t) return g.items;
  return g.items.filter((it) => it.key.includes(t) || (it.tip && it.tip.includes(t)));
}
