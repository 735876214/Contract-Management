import { useEffect } from 'react';
import { Select, Tag } from 'antd';
import { useDictStore } from '@/store/dict';

interface Props {
  typeCode: string;
  value?: any;
  onChange?: (value: any) => void;
  mode?: 'multiple' | 'tags';
  allowClear?: boolean;
  disabled?: boolean;
  placeholder?: string;
  extValue?: string; // 联动过滤（如 material_type 按 material_category 过滤）
  style?: React.CSSProperties;
}

/** 统一字典下拉组件：所有下拉选项均从字典表动态读取 */
export default function DictSelect({
  typeCode,
  value,
  onChange,
  mode,
  allowClear = true,
  disabled,
  placeholder,
  extValue,
  style,
}: Props) {
  const ensure = useDictStore((s) => s.ensure);
  const options = useDictStore((s) => s.options(typeCode, extValue));

  useEffect(() => {
    ensure(typeCode);
  }, [typeCode]);

  return (
    <Select
      style={{ minWidth: 160, ...style }}
      value={value || undefined}
      onChange={onChange}
      mode={mode}
      allowClear={allowClear}
      disabled={disabled}
      placeholder={placeholder || '请选择'}
      options={options.map((o) => ({ value: o.value, label: o.label }))}
      showSearch
      optionFilterProp="label"
    />
  );
}

/** 字典值渲染为彩色标签 */
export function DictTag({ typeCode, value }: { typeCode: string; value?: string }) {
  const ensure = useDictStore((s) => s.ensure);
  const options = useDictStore((s) => s.cache[typeCode] || []);
  useEffect(() => {
    ensure(typeCode);
  }, [typeCode]);
  if (!value) return <span>-</span>;
  const hit = options.find((o) => o.value === value);
  return <Tag color={hit?.color || 'default'}>{hit?.label || value}</Tag>;
}

/** 字典值渲染为纯文本 */
export function DictText({ typeCode, value }: { typeCode: string; value?: string }) {
  const ensure = useDictStore((s) => s.ensure);
  const label = useDictStore((s) => s.label(typeCode, value));
  useEffect(() => {
    ensure(typeCode);
  }, [typeCode]);
  return <span>{label}</span>;
}
