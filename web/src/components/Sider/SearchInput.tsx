import { Empty, Input } from 'antd';
import type { SearchInputProps } from './types';

/** 搜索结果项 */
function ResultRow({
  label,
  chainLabel,
  onSelect,
}: {
  label: string;
  chainLabel: string;
  onSelect: () => void;
}) {
  return (
    <div
      className="sider-search__result-item"
      onClick={onSelect}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === 'Enter') onSelect();
      }}
    >
      <span className="sider-search__result-label">{label}</span>
      <span className="sider-search__result-chain">{chainLabel}</span>
    </div>
  );
}

/** 菜单搜索框（需求 5.2）：实时过滤、结果平铺、allowClear、折叠时由父级隐藏 */
export default function SearchInput({ value, onChange, results, active, onSelect }: SearchInputProps) {
  return (
    <div className="sider-search">
      <Input.Search
        className="sider-search__input"
        placeholder="搜索菜单..."
        allowClear
        value={value}
        onChange={(e) => onChange(e.target.value)}
        // 搜索为纯前端过滤，无需触发按钮
        enterButton={false}
      />
      {active && (
        <div className="sider-search__results">
          {results.length === 0 ? (
            <Empty
              className="sider-search__empty"
              image={Empty.PRESENTED_IMAGE_SIMPLE}
              description="未找到匹配菜单"
            />
          ) : (
            results.map((item) => (
              <ResultRow
                key={item.key}
                label={item.label}
                chainLabel={item.chainLabel}
                onSelect={() => onSelect(item)}
              />
            ))
          )}
        </div>
      )}
    </div>
  );
}
