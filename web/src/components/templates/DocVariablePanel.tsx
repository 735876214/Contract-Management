import { Space, Tag, Tooltip, message } from 'antd';
import type { DocVarGroup } from '@/constants/docVariables';

/**
 * 单据模板占位符面板（2026-10-18）：把分组标题、变量说明（tip）与「表格占位符」标记真正渲染出来。
 *
 * 为什么强调「独占单元格」：`doc-excel.ts` 的表格占位符只有在单元格文本**只有它自己**时才会做
 * 真正的行展开（插行、复制样式、合并区域下移）；与文字混排时只能退化为整格多行文本。
 * 不写清楚，业务会把 `合计：{{结算明细表}}` 写进模板，然后疑惑为什么没有展开成表格。
 */
interface Props {
  groups?: DocVarGroup[];
  emptyHint?: string;
}

export default function DocVariablePanel({ groups, emptyHint }: Props) {
  const copy = async (key: string) => {
    const text = `{{${key}}}`;
    try {
      await navigator.clipboard.writeText(text);
      message.success(`已复制 ${text}`);
    } catch {
      message.warning(`复制失败，请手动输入 ${text}`);
    }
  };

  if (!groups?.length) {
    return (
      <span style={{ color: 'var(--cms-muted-soft)' }}>
        {emptyHint || '先选择分类；仅「付款单」「总结算单」已接生成路径，其余三类待各自模块接入'}
      </span>
    );
  }

  return (
    <Space direction="vertical" size={8} style={{ width: '100%' }}>
      {groups.map((g) => (
        <div key={g.label}>
          <div style={{ fontSize: 12, color: 'var(--cms-muted-soft)', marginBottom: 4 }}>{g.label}</div>
          <Space wrap size={4}>
            {g.items.map((v) => (
              <Tooltip key={v.key} title={v.tip || `占位符 {{${v.key}}}`}>
                <Tag
                  color={v.table ? 'gold' : 'geekblue'}
                  style={{ fontFamily: 'monospace', cursor: 'pointer' }}
                  onClick={() => copy(v.key)}
                >
                  {`{{${v.key}}}`}
                  {v.table ? '（表格）' : ''}
                </Tag>
              </Tooltip>
            ))}
          </Space>
        </div>
      ))}
      <div style={{ fontSize: 12, color: 'var(--cms-muted-soft)', lineHeight: 1.7 }}>
        {`表格占位符（如 {{结算明细表}}）必须独占一个单元格（前后可以有空白）：生成时按行展开，` +
          `自动插行并复制该行样式与行高。与文字混排（如「合计：{{结算明细表}}」）时只能退化为` +
          `单元格内多行文本（每行用制表符分列）。单值占位符可写在任意单元格，未取到值时原样保留。`}
      </div>
    </Space>
  );
}
