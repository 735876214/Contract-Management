import { useEffect, useState } from 'react';
import { AutoComplete, Tooltip, message } from 'antd';
import { dictApi } from '@/api/dict';

/**
 * 计量单位输入（需求 2.3.2：可手输，但必须存在于字典「计量单位」）。
 * 从页面文件抽出（2026-11-22 审计：单文件 1214 行）。
 */
/** 字典「计量单位」选项缓存（下拉选项统一来自字典管理） */
let unitOptionsCache: string[] | null = null;
async function loadUnitOptions(): Promise<string[]> {
  if (unitOptionsCache) return unitOptionsCache;
  const res: any = await dictApi.options('measurement_unit');
  // 同 DailyReports：落局部变量再赋值，避免返回可空缓存
  const list: string[] = (res || []).map((u: any) => u.label).filter(Boolean);
  unitOptionsCache = list;
  return list;
}

function UnitInput({ value, onChange }: { value?: string; onChange: (v: string) => void }) {
  const [options, setOptions] = useState<string[]>(unitOptionsCache || []);
  const [text, setText] = useState<string>(value || '');
  const [invalid, setInvalid] = useState(false);

  useEffect(() => {
    loadUnitOptions().then(setOptions).catch(() => undefined);
  }, []);
  useEffect(() => {
    setText(value || '');
    setInvalid(false);
  }, [value]);

  return (
    <Tooltip title={invalid ? '计量单位不在字典范围内，请先在字典管理中添加' : '默认取物资基础库，可输入其他字典内单位'}>
      <AutoComplete
        value={text}
        options={options.map((u) => ({ value: u }))}
        style={{ width: '100%' }}
        placeholder="计量单位"
        status={invalid ? 'error' : undefined}
        filterOption={(input, option) => String(option?.value || '').includes(input)}
        onChange={(v) => setText(v ?? '')}
        onBlur={() => {
          const v = (text || '').trim();
          // 需求 2.3.2：前端拦截字典以外的单位
          if (v && options.length && !options.includes(v)) {
            setInvalid(true);
            message.error(`计量单位「${v}」不在字典范围内，请先在字典管理中添加`);
            return;
          }
          setInvalid(false);
          onChange(v);
        }}
      />
    </Tooltip>
  );
}
export default UnitInput;
