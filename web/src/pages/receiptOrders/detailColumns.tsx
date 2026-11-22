import { Input, InputNumber, Select, Tag } from 'antd';
import { formatMoney, formatNumber } from '@/utils/money';
import { YES_NO } from './constants';
import UnitInput from './UnitInput';

/**
 * 收领单明细表格列（原在 1214 行的页面文件里）。
 * `patchDetail` 由页面传入：这一层不持有 state，只表达「改哪行哪个字段」。
 */
export const DETAIL_COLUMNS = (
  patchDetail: (key: React.Key, field: string, value: any) => void,
  showCustodian: boolean,
) => [
  { title: '序号', width: 60, fixed: 'left' as const, render: (_: any, __: any, i: number) => i + 1 },
  { title: '一级分类', dataIndex: 'categoryLevel1', width: 110, render: (v: any) => v || '-' },
  { title: '二级分类', dataIndex: 'categoryLevel2', width: 110, render: (v: any) => v || '-' },
  { title: '物资名称', dataIndex: 'materialName', width: 160, fixed: 'left' as const, ellipsis: true, render: (v: any) => v || '-' },
  { title: '规格型号', dataIndex: 'specModel', width: 140, ellipsis: true, render: (v: any) => v || '-' },
  {
    title: '计量单位', dataIndex: 'unit', width: 130,
    // 需求 2.3.2：默认从物资基础库带出，可手动输入，但必须存在于字典「计量单位」
    render: (v: any, row: any) => (
      <UnitInput value={v} onChange={(val) => patchDetail(row.key, 'unit', val)} />
    ),
  },
  { title: '合同数量', dataIndex: 'contractQty', width: 110, align: 'right' as const, render: (v: any) => formatNumber(v) },
  {
    title: '送货数量', dataIndex: 'deliveryQty', width: 130,
    render: (v: any, row: any) => (
      <InputNumber style={{ width: '100%' }} precision={4} value={v} placeholder="填写（退货/调出可填负数）"
        onChange={(val) => patchDetail(row.key, 'deliveryQty', val)} />
    ),
  },
  {
    title: '实收数量', dataIndex: 'receivedQty', width: 130,
    render: (v: any, row: any) => (
      <InputNumber style={{ width: '100%' }} precision={4} value={v} placeholder="负数表示退货/调出"
        onChange={(val) => patchDetail(row.key, 'receivedQty', val)} />
    ),
  },
  { title: '税前单价（元）', dataIndex: 'priceBeforeTax', width: 130, align: 'right' as const, render: (v: any) => formatNumber(v, 2) },
  { title: '综合单价（元）', dataIndex: 'priceWithTax', width: 130, align: 'right' as const, render: (v: any) => <Tag color="geekblue">{formatNumber(v, 2)}</Tag> },
  { title: '综合总价（元）', dataIndex: 'totalPrice', width: 140, align: 'right' as const, render: (v: any) => <Tag color="geekblue">{formatMoney(v)}</Tag> },
  {
    title: '使用部位', dataIndex: 'usagePart', width: 140,
    render: (v: any, row: any) => (
      <Input value={v} placeholder="填写" onChange={(e) => patchDetail(row.key, 'usagePart', e.target.value)} />
    ),
  },
  // 「是否为资产」= 是 → 明细增加保管栏（业务 2026-10-17）；= 否 或未选 → 不显示
  ...(showCustodian
    ? [
        {
          title: '保管单位及保管人', dataIndex: 'custodian', width: 170,
          render: (v: any, row: any) => (
            <Input value={v} placeholder="保管单位及保管人" onChange={(e) => patchDetail(row.key, 'custodian', e.target.value)} />
          ),
        },
      ]
    : []),
  {
    title: '厂家/品牌', dataIndex: 'brand', width: 140,
    render: (v: any, row: any) => (
      <Input value={v} placeholder="填写" onChange={(e) => patchDetail(row.key, 'brand', e.target.value)} />
    ),
  },
  {
    title: '备注', dataIndex: 'remark', width: 160,
    render: (v: any, row: any) => (
      <Input value={v} placeholder="填写" onChange={(e) => patchDetail(row.key, 'remark', e.target.value)} />
    ),
  },
  {
    title: '是否代购', dataIndex: 'isAgentPurchase', width: 130,
    render: (v: any, row: any) => (
      <Select allowClear style={{ width: '100%' }} placeholder="选择" value={v || undefined} options={YES_NO}
        onChange={(val) => patchDetail(row.key, 'isAgentPurchase', val)} />
    ),
  },
];
export default DETAIL_COLUMNS;
