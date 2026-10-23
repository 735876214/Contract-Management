import type { ReactNode } from 'react';
import { Typography } from 'antd';

const { Title, Paragraph } = Typography;

/**
 * 极简 Markdown 渲染（**报告类页面的展示件**）：标题 / 无序列表 / 有序列表 / 表格 / 段落 / 行内加粗。
 *
 * 为什么不引 react-markdown：后端产出的报告只用得到这几种语法
 * （`report-pdf.ts` 与 `report-facts.ts` 的转换器也只认这几种），
 * 多一个依赖不划算；而 PDF/docx 导出同样只走这几种语法，页面所见与导出所见一致。
 *
 * 与 `AiReportPanel.tsx` 里那份局部渲染器的差别：**支持表格**。
 * 供应链全景有「项目对照」「供应商集中度」两张表，落成段落会难读。
 */

/** 行内语法：只处理 `**加粗**` 与 `` `代码` `` */
function inline(text: string, keyPrefix: string): ReactNode[] {
  const out: ReactNode[] = [];
  const re = /(\*\*[^*]+\*\*|`[^`]+`)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let i = 0;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const token = m[0];
    if (token.startsWith('**')) {
      out.push(<strong key={`${keyPrefix}-b${i}`}>{token.slice(2, -2)}</strong>);
    } else {
      out.push(
        <code key={`${keyPrefix}-c${i}`} style={{ background: 'var(--cms-canvas)', padding: '0 4px', borderRadius: 3 }}>
          {token.slice(1, -1)}
        </code>,
      );
    }
    last = m.index + token.length;
    i += 1;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

const isTableRow = (line: string): boolean => /^\|.*\|$/.test(line.trim());
const isTableDivider = (line: string): boolean => {
  const cells = line.trim().replace(/^\||\|$/g, '').split('|');
  return cells.length > 0 && cells.every((c) => /^:?-{2,}:?$/.test(c.trim()));
};
const splitCells = (line: string): string[] =>
  line
    .trim()
    .replace(/^\||\|$/g, '')
    .split('|')
    .map((c) => c.trim());

export default function ReportMarkdown({ text }: { text: string }) {
  const blocks: ReactNode[] = [];
  let list: string[] = [];
  let ordered = false;
  let table: string[][] = [];

  const flushList = () => {
    if (!list.length) return;
    const items = list;
    list = [];
    const key = `l-${blocks.length}`;
    if (ordered) {
      blocks.push(
        <ol key={key} style={{ margin: '4px 0 12px', paddingLeft: 22 }}>
          {items.map((t, i) => (
            <li key={i}>{inline(t, `${key}-${i}`)}</li>
          ))}
        </ol>,
      );
    } else {
      blocks.push(
        <ul key={key} style={{ margin: '4px 0 12px', paddingLeft: 20 }}>
          {items.map((t, i) => (
            <li key={i}>{inline(t, `${key}-${i}`)}</li>
          ))}
        </ul>,
      );
    }
  };

  const flushTable = () => {
    if (!table.length) return;
    const rows = table;
    table = [];
    const head = rows[0];
    const body = rows.slice(1);
    blocks.push(
      <div key={`t-${blocks.length}`} style={{ overflowX: 'auto', margin: '8px 0 16px' }}>
        <table style={{ borderCollapse: 'collapse', width: '100%', fontSize: 13 }}>
          <thead>
            <tr>
              {head.map((c, i) => (
                <th
                  key={i}
                  style={{
                    borderBottom: '1px solid var(--cms-hairline)',
                    padding: '6px 8px',
                    textAlign: 'left',
                    whiteSpace: 'nowrap',
                    background: 'var(--cms-canvas)',
                  }}
                >
                  {inline(c, `th-${i}`)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {body.map((r, ri) => (
              <tr key={ri}>
                {r.map((c, ci) => (
                  <td
                    key={ci}
                    style={{
                      borderBottom: '1px solid var(--cms-hairline)',
                      padding: '6px 8px',
                      whiteSpace: 'nowrap',
                    }}
                  >
                    {inline(c, `td-${ri}-${ci}`)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>,
    );
  };

  const flushAll = () => {
    flushList();
    flushTable();
  };

  for (const raw of String(text || '').split('\n')) {
    const line = raw.trimEnd();
    if (!line.trim()) {
      // 空行是块级分隔：**表格也要收尾**。只 flushList 会让积压的表格行排到下一个块之后，
      // 于是「表格 → 空行 → 列表」在页面上顺序颠倒（与导出的 docx/html 不一致）。
      flushAll();
      continue;
    }
    if (isTableRow(line)) {
      flushList();
      if (isTableDivider(line)) continue;
      table.push(splitCells(line));
      continue;
    }
    flushTable();

    const h = /^(#{1,4})\s+(.*)$/.exec(line);
    if (h) {
      flushList();
      const level = h[1].length;
      blocks.push(
        <Title key={`h-${blocks.length}`} level={level <= 2 ? 4 : 5} style={{ marginTop: 16, marginBottom: 8 }}>
          {inline(h[2], `h-${blocks.length}`)}
        </Title>,
      );
      continue;
    }
    const ul = /^[-*]\s+(.*)$/.exec(line);
    if (ul) {
      if (ordered) flushList();
      ordered = false;
      list.push(ul[1]);
      continue;
    }
    const ol = /^\d+[.)]\s+(.*)$/.exec(line);
    if (ol) {
      if (!ordered) flushList();
      ordered = true;
      list.push(ol[1]);
      continue;
    }
    flushList();
    blocks.push(
      <Paragraph key={`p-${blocks.length}`} style={{ marginBottom: 8 }}>
        {inline(line, `p-${blocks.length}`)}
      </Paragraph>,
    );
  }
  flushAll();
  return <>{blocks}</>;
}
