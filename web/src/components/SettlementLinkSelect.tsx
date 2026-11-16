import { useEffect, useState } from 'react';
import { Select } from 'antd';
import { settlementApi } from '@/api/modules';

/**
 * **结算单下拉**（发票 / 收领单共用）。
 *
 * 业务口径（2026-10-16）：发票与收领单都要挂到「同合同、同月份」的那张结算单上；
 * 留空时服务端**自动匹配**同合同同月的结算单（见后端 `SettlementService.findSettlementIdFor`），
 * 所以这里不强制必填 —— 占位文案要说明"留空会自动匹配"，否则用户会以为漏填了。
 *
 * ⚠️ 必须先选合同：结算单以「合同 + 月份」归属，没有合同就列不出候选，
 * 故未选合同时**禁用**并提示（而不是给一个空列表让人以为"该合同没有结算单"）。
 */
export default function SettlementLinkSelect({
  contractId,
  value,
  onChange,
  placeholder = '留空则自动匹配同月结算单',
  ...rest
}: {
  contractId?: string | null;
  value?: string | null;
  onChange?: (v: string | null) => void;
  placeholder?: string;
  [key: string]: any;
}) {
  const [options, setOptions] = useState<{ value: string; label: string }[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!contractId) {
      setOptions([]);
      return;
    }
    let alive = true;
    setLoading(true);
    settlementApi
      .list({ contractId, pageSize: 200 })
      .then((res: any) => {
        if (!alive) return;
        const list = (res?.list || []).map((s: any) => ({
          value: s.id,
          // 结算单可能没编号（自动生成的还在草稿态）→ 退回月份，保证每项都有可读文本
          label: `${s.settleDate ? String(s.settleDate).slice(0, 7) : '未填日期'}${s.code ? ` ${s.code}` : ''}`,
        }));
        setOptions(list);
      })
      .catch(() => alive && setOptions([]))
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, [contractId]);

  return (
    <Select
      allowClear
      showSearch
      optionFilterProp="label"
      loading={loading}
      disabled={!contractId}
      placeholder={contractId ? placeholder : '请先选择合同'}
      options={options}
      value={value ?? undefined}
      onChange={(v) => onChange?.(v ?? null)}
      {...rest}
    />
  );
}
