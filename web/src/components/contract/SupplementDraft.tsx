import { useEffect, useState } from 'react';
import {
  Alert, Button, Card, Drawer, Form, Input, InputNumber, Select, Space, Table, Typography, message, Modal,
} from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { DeleteOutlined, PlusOutlined, EyeOutlined, SendOutlined, SaveOutlined } from '@ant-design/icons';
import { contractApi, templateApi } from '@/api/business';
import { dailyApi } from '@/api/modules';
import RichTextEditor from '@/components/RichTextEditor';
import { amountToChineseCapital } from '@/utils/money';
import { DictTag } from '@/components/DictSelect';

const SUPP_TYPES = [
  { value: 'PRICE_UP', label: '涨价补充协议' },
  { value: 'PRICE_DOWN', label: '降价补充协议' },
  { value: 'QTY_ADD', label: '增量补充协议' },
  { value: 'ITEM_ADD', label: '增项补充协议' },
  { value: 'OTHER', label: '其他类补充协议' },
] as const;

type SuppType = (typeof SUPP_TYPES)[number]['value'];

const suppName = (code: string): string =>
  SUPP_TYPES.find((t) => t.value === code)?.label ?? code;

const num = (v: unknown): number => {
  if (v === '' || v == null) return 0;
  const n = Number(v);
  return Number.isNaN(n) ? 0 : n;
};
const fmt = (v: unknown): string =>
  num(v) === 0 ? '0.00' : num(v).toLocaleString('zh-CN', { maximumFractionDigits: 2 });
const fmtPct = (v: unknown): string => `${(num(v) * 100).toFixed(2)}%`;

/** 构造与后端 buildTableHtml 一致的表格 HTML（用于 {{补充协议表}} 占位符） */
function buildTableHtml(headers: readonly string[], rows: readonly (string | number)[][]): string {
  const esc = (v: unknown): string =>
    String(v ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  const thead = `<tr>${headers
    .map((h) => `<th style="border:1px solid #000;padding:4px 6px;background:#f2f2f2;">${esc(h)}</th>`)
    .join('')}</tr>`;
  const tbody = rows.length
    ? rows
        .map(
          (r) =>
            `<tr>${r
              .map((c) => `<td style="border:1px solid #000;padding:4px 6px;text-align:center;">${esc(c)}</td>`)
              .join('')}</tr>`,
        )
        .join('')
    : `<tr><td style="border:1px solid #000;padding:4px 6px;text-align:center;" colspan="${headers.length}">暂无数据</td></tr>`;
  return `<table style="border-collapse:collapse;width:100%;">${thead}${tbody}</table>`;
}

/** 原合同（父合同）最小结构：所有字段均可能缺失，访问时必须使用可选链 */
interface SuppParent {
  id?: string | null;
  code?: string | null;
  name?: string | null;
  typeCode?: string | null;
  supplierId?: string | null;
  templateId?: string | null;
  amount?: number | string | null;
}

/**
 * 涨价/降价/增量协议行：由原合同清单自动带出（materialBaseId 非空时只读字段锁定），
 * 或手动添加（materialBaseId 为空，全部字段可编辑）。
 */
interface SuppRow {
  materialBaseId: string;
  name: string;
  spec: string;
  unit: string;
  origQty: number; // 原合同数量（清单「暂定数量」）
  origPrice: number; // 原合同含税单价（清单「含税单价」）
  settledQty: number; // 日报已发生数量（结算数量合计）
  newPrice: number; // 涨价/降价：补充协议含税单价（可编辑）
  addQty: number; // 增量：暂定新增数量（可编辑）
  remark: string;
}

/** 原合同清单导入行（来自 contractApi.draftList，字段可能缺失） */
interface OrigRow {
  materialBaseId?: string | null;
  name?: string | null;
  spec?: string | null;
  unit?: string | null;
  qty?: number | string | null;
  priceWithTax?: number | string | null;
  totalWithTax?: number | string | null;
}

interface ItemRow {
  name: string;
  spec: string;
  unit: string;
  priceBeforeTax: number;
  taxRate: number;
  addQty: number;
  remark: string;
}

interface Props {
  /** 父组件可能尚未选中合同（null），组件内部必须兜底 */
  parent: SuppParent | null;
  open: boolean;
  onClose: () => void;
  onDone: () => void;
}

const blankSupp = (): SuppRow => ({
  materialBaseId: '', name: '', spec: '', unit: '',
  origQty: 0, origPrice: 0, settledQty: 0, newPrice: 0, addQty: 0, remark: '',
});
const blankItem = (): ItemRow => ({ name: '', spec: '', unit: '', priceBeforeTax: 0, taxRate: 13, addQty: 0, remark: '' });

/** 原合同剩余数量 = 原合同数量 − 日报已发生数量（允许负数显示，计算金额时按 0） */
const remainOf = (r: SuppRow): number => num(r.origQty) - num(r.settledQty);
/** 计算用剩余数量：负数按 0 处理，避免出现负金额 */
const remainForCalc = (r: SuppRow): number => Math.max(0, remainOf(r));

/** 更新数组第 i 项指定字段（泛型，类型安全） */
function update<T, K extends keyof T>(rows: T[], setter: (v: T[]) => void, i: number, field: K, value: T[K]): void {
  const next = rows.slice();
  next[i] = { ...next[i], [field]: value };
  setter(next);
}

export default function SupplementDraft({ parent, open, onClose, onDone }: Props) {
  const [loading, setLoading] = useState(false);
  const [creating, setCreating] = useState(false);
  const [contractId, setContractId] = useState<string | null>(null);
  const [code, setCode] = useState('');
  const [seq, setSeq] = useState(1);
  const [suppType, setSuppType] = useState<SuppType>('PRICE_UP');
  const [saved, setSaved] = useState(false);

  // 各类型表数据
  const [priceRows, setPriceRows] = useState<SuppRow[]>([]);
  const [qtyRows, setQtyRows] = useState<SuppRow[]>([]);
  const [itemOrig, setItemOrig] = useState<OrigRow[]>([]);
  const [itemNew, setItemNew] = useState<ItemRow[]>([blankItem()]);
  const [otherHtml, setOtherHtml] = useState('');

  const [previewOpen, setPreviewOpen] = useState(false);
  const [previewHtml, setPreviewHtml] = useState('');
  const [previewing, setPreviewing] = useState(false);
  const [publishing, setPublishing] = useState(false);

  /** 原合同清单行 → 补充协议行（只读字段自动带出，剩余数量 = 数量 − 日报结算合计） */
  const toSuppRows = (orig: OrigRow[], settledMap: Map<string, number>): SuppRow[] =>
    orig
      .filter((r) => r?.materialBaseId || r?.name)
      .map((r) => {
        const materialBaseId = r?.materialBaseId ?? '';
        const row: SuppRow = {
          materialBaseId,
          name: r?.name ?? '',
          spec: r?.spec ?? '',
          unit: r?.unit ?? '',
          origQty: num(r?.qty),
          origPrice: num(r?.priceWithTax),
          settledQty: settledMap.get(materialBaseId) ?? 0,
          newPrice: 0,
          addQty: 0,
          remark: '',
        };
        return row;
      });

  // 打开时初始化：拉取补充协议编号 + 原合同清单 + 日报结算数量合计
  useEffect(() => {
    if (!open || !parent?.id) return;
    setContractId(null);
    setSuppType('PRICE_UP');
    setSaved(false);
    setOtherHtml('');
    setItemNew([blankItem()]);
    setLoading(true);
    (async () => {
      try {
        const nc = (await contractApi.nextSupplementCode(parent.id as string)) as
          | { code?: string; seq?: number }
          | undefined;
        setCode(nc?.code ?? '');
        setSeq(nc?.seq ?? 1);
        // 并行拉取：原合同清单 + 日报结算数量合计
        const [m, sq] = await Promise.all([
          contractApi
            .draftList(parent.id as string)
            .catch(() => undefined as unknown),
          dailyApi
            .contractSettledQty(parent.id as string)
            .catch(() => undefined as unknown),
        ]);
        const orig: OrigRow[] = Array.isArray(m)
          ? (m as OrigRow[])
          : ((m as { list?: OrigRow[] } | undefined)?.list ?? []);
        setItemOrig(orig);
        const settledEntries = Array.isArray(sq)
          ? (sq as { materialBaseId: string; settleQty: number }[])
          : [];
        const settledMap = new Map<string, number>(
          settledEntries.map((x) => [x.materialBaseId, num(x.settleQty)]),
        );
        // 涨价/降价/增量：自动带出原合同清单（含剩余数量），支持删除行
        setPriceRows(toSuppRows(orig, settledMap));
        setQtyRows(toSuppRows(orig, settledMap));
      } catch {
        message.error('获取补充协议编号失败');
      } finally {
        setLoading(false);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, parent?.id]);

  /** 创建补充协议草稿（仅首次），返回 id */
  const ensureContract = async (): Promise<string | null> => {
    if (contractId) return contractId;
    if (!code || !parent?.id) return null;
    setCreating(true);
    try {
      const created = (await contractApi.create({
        code,
        name: `${parent?.name ?? parent?.code ?? ''}之补充协议（${seq}）`,
        typeCode: parent?.typeCode ?? undefined,
        supplierId: parent?.supplierId ?? undefined,
        templateId: parent?.templateId ?? undefined,
        isSupplement: 'Y',
        parentContractId: parent.id,
        supplementTypeCode: suppType,
        status: 'DRAFT',
      })) as { id?: string } | undefined;
      const id = created?.id ?? null;
      setContractId(id);
      return id;
    } finally {
      setCreating(false);
    }
  };

  /** 计算并组装 formData.supplement（已解析好的占位符值） */
  const buildSupplementData = (): Record<string, string> => {
    const parentAmount = num(parent?.amount);
    const base: Record<string, string> = {
      补充协议编号: code,
      补充协议类型: suppName(suppType),
      原合同编号: parent?.code ?? '',
      原合同名称: parent?.name ?? '',
    };
    if (suppType === 'PRICE_UP' || suppType === 'PRICE_DOWN') {
      // 原合同剩余数量：显示允许负数；计算金额时负数按 0（避免负金额）
      const rows = priceRows.map((r, i) => {
        const origAmount = num(r.origQty) * num(r.origPrice);
        const diff = num(r.newPrice) - num(r.origPrice);
        const newAmount = remainForCalc(r) * diff;
        return { ...r, origAmount, diff, newAmount, i };
      });
      const newTotal = rows.reduce((s, r) => s + r.newAmount, 0);
      const qtyTotal = rows.reduce((s, r) => s + remainOf(r), 0);
      base['补充协议表'] = buildTableHtml(
        ['序号', '物资名称', '规格型号', '计量单位', '原合同数量', '原合同剩余数量', '原合同含税单价', '原合同金额',
          '补充协议含税单价', '原合同与补充协议价差', '新增合同金额', '累计占原合同金额比例', '备注'],
        rows.map((r) => [r.i + 1, r.name, r.spec, r.unit, fmt(r.origQty), fmt(remainOf(r)), fmt(r.origPrice), fmt(r.origAmount),
          fmt(r.newPrice), fmt(r.diff), fmt(r.newAmount), fmtPct(parentAmount ? r.newAmount / parentAmount : 0), r.remark || '']),
      );
      base['原合同金额总价大写'] = amountToChineseCapital(parentAmount);
      base['新增合同金额总价大写'] = amountToChineseCapital(newTotal);
      base['数量汇总'] = fmt(qtyTotal);
      base['累计补充协议占比'] = fmtPct(parentAmount ? newTotal / parentAmount : 0);
    } else if (suppType === 'QTY_ADD') {
      const rows = qtyRows.map((r, i) => {
        const origAmount = num(r.origQty) * num(r.origPrice);
        const addAmount = num(r.addQty) * num(r.origPrice);
        return { ...r, origAmount, addAmount, i };
      });
      const addTotal = rows.reduce((s, r) => s + r.addAmount, 0);
      const qtyTotal = rows.reduce((s, r) => s + num(r.addQty), 0);
      base['补充协议表'] = buildTableHtml(
        ['序号', '物资名称', '规格型号', '计量单位', '原合同含税单价', '原合同数量', '原合同剩余数量', '暂定新增数量', '原合同金额', '暂定新增金额', '累计占原合同金额比例', '备注'],
        rows.map((r) => [r.i + 1, r.name, r.spec, r.unit, fmt(r.origPrice), fmt(r.origQty), fmt(remainOf(r)), fmt(r.addQty), fmt(r.origAmount),
          fmt(r.addAmount), fmtPct(parentAmount ? r.addAmount / parentAmount : 0), r.remark || '']),
      );
      base['原合同金额总价大写'] = amountToChineseCapital(parentAmount);
      base['新增合同金额总价大写'] = amountToChineseCapital(addTotal);
      base['数量汇总'] = fmt(qtyTotal);
      base['累计补充协议占比'] = fmtPct(parentAmount ? addTotal / parentAmount : 0);
    } else if (suppType === 'ITEM_ADD') {
      const newRows = itemNew.map((r, i) => {
        const priceWithTax = num(r.priceBeforeTax) * (1 + num(r.taxRate) / 100);
        const amount = priceWithTax * num(r.addQty);
        return { ...r, priceWithTax, amount, i };
      });
      const addTotal = newRows.reduce((s, r) => s + r.amount, 0);
      const qtyTotal = newRows.reduce((s, r) => s + num(r.addQty), 0);
      base['补充协议表'] = buildTableHtml(
        ['序号', '物资名称', '规格型号', '计量单位', '税前单价', '税率(%)', '含税单价', '暂定新增数量', '暂定新增含税金额', '累计占原合同金额比例', '备注'],
        newRows.map((r) => [r.i + 1, r.name, r.spec, r.unit, fmt(r.priceBeforeTax), fmt(r.taxRate), fmt(r.priceWithTax),
          fmt(r.addQty), fmt(r.amount), fmtPct(parentAmount ? r.amount / parentAmount : 0), r.remark || '']),
      );
      base['原合同金额总价大写'] = amountToChineseCapital(parentAmount);
      base['新增合同金额总价大写'] = amountToChineseCapital(addTotal);
      base['数量汇总'] = fmt(qtyTotal);
      base['累计补充协议占比'] = fmtPct(parentAmount ? addTotal / parentAmount : 0);
      // 原合同清单作为正文前导说明（可选），此处仅存入原合同清单表
      if (itemOrig.length) {
        base['补充协议表'] =
          buildTableHtml(['序号', '物资名称', '规格型号', '计量单位', '原合同含税单价', '原合同数量', '原合同金额'],
            itemOrig.map((r, i) => [i + 1, r?.name ?? '', r?.spec ?? '',
              r?.unit ?? '', fmt(r?.priceWithTax), fmt(r?.qty), fmt(r?.totalWithTax)])) + base['补充协议表'];
      }
    } else {
      // OTHER：富文本正文
      base['其他补充协议内容'] = otherHtml;
      base['补充协议表'] = '';
    }
    return base;
  };

  const persistFormData = async (id: string): Promise<void> => {
    const supplement = buildSupplementData();
    await contractApi.update(id, { supplementTypeCode: suppType, formData: { supplement } });
    setSaved(true);
  };

  const handleSave = async (): Promise<void> => {
    const id = await ensureContract();
    if (!id) { message.error('补充协议创建失败'); return; }
    await persistFormData(id);
    message.success('已保存补充协议内容');
  };

  const handlePreview = async (): Promise<void> => {
    const id = await ensureContract();
    if (!id) { message.error('补充协议创建失败'); return; }
    await persistFormData(id);
    if (!parent?.templateId) { message.warning('原合同未关联模板，无法预览'); return; }
    setPreviewing(true);
    try {
      const res = (await templateApi.generate({ templateId: parent.templateId, contractId: id })) as
        | { html?: string }
        | undefined;
      setPreviewHtml(res?.html ?? '');
      setPreviewOpen(true);
    } finally {
      setPreviewing(false);
    }
  };

  const handlePublish = async (): Promise<void> => {
    const id = await ensureContract();
    if (!id) { message.error('补充协议创建失败'); return; }
    await persistFormData(id);
    Modal.confirm({
      title: '发布补充协议',
      content: '发布后该补充协议将进入「合同查询」列表，状态为审批中，合同类型与内容不可再修改。',
      okText: '确认发布',
      cancelText: '再检查一下',
      onOk: async () => {
        setPublishing(true);
        try {
          await contractApi.publish(id);
          message.success('补充协议已发布');
          onDone();
        } finally {
          setPublishing(false);
        }
      },
    });
  };

  // ---- 空值守卫：parent 为 null（父组件初始状态）时不渲染任何依赖其字段的内容 ----
  if (!parent?.id) {
    return (
      <Drawer title="新增补充协议" width={1040} open={open} onClose={onClose} footer={null}>
        <Alert
          type="warning"
          showIcon
          message="未选择原合同"
          description="请从「合同查询」列表的操作列点击「新增补充协议」进入。"
        />
      </Drawer>
    );
  }

  const isPrice = suppType === 'PRICE_UP' || suppType === 'PRICE_DOWN';
  const isQty = suppType === 'QTY_ADD';
  const isItem = suppType === 'ITEM_ADD';
  const isOther = suppType === 'OTHER';

  /** 只读文本（带出字段），负数红色提示 */
  const readonlyText = (v: string | number): JSX.Element =>
    num(v) < 0 ? <Typography.Text type="danger">{fmt(v)}</Typography.Text> : <span>{fmt(v)}</span>;

  /** 带出行显示只读文本；手动添加行（materialBaseId 为空）允许编辑 */
  const origCell = (
    r: SuppRow,
    key: 'name' | 'spec' | 'unit',
    rows: SuppRow[],
    setter: (v: SuppRow[]) => void,
    i: number,
  ): JSX.Element =>
    r.materialBaseId ? (
      <span>{r[key] || '-'}</span>
    ) : (
      <Input value={r[key]} onChange={(e) => update(rows, setter, i, key, e.target.value)} />
    );

  const priceColumns: ColumnsType<SuppRow> = [
    { title: '序号', width: 50, render: (_, __, i) => i + 1 },
    { title: '物资名称', render: (_, r, i) => origCell(r, 'name', priceRows, setPriceRows, i) },
    { title: '规格型号', render: (_, r, i) => origCell(r, 'spec', priceRows, setPriceRows, i) },
    { title: '计量单位', render: (_, r, i) => origCell(r, 'unit', priceRows, setPriceRows, i) },
    { title: '原合同数量', render: (_, r, i) =>
      r.materialBaseId ? readonlyText(r.origQty)
        : <InputNumber value={r.origQty} onChange={(v) => update(priceRows, setPriceRows, i, 'origQty', num(v))} /> },
    { title: '原合同剩余数量', render: (_, r) => readonlyText(remainOf(r)) },
    { title: '原合同含税单价', render: (_, r, i) =>
      r.materialBaseId ? readonlyText(r.origPrice)
        : <InputNumber value={r.origPrice} onChange={(v) => update(priceRows, setPriceRows, i, 'origPrice', num(v))} /> },
    { title: '原合同金额', render: (_, r) => fmt(num(r.origQty) * num(r.origPrice)) },
    { title: '补充协议含税单价', render: (_, r, i) => <InputNumber value={r.newPrice} onChange={(v) => update(priceRows, setPriceRows, i, 'newPrice', num(v))} /> },
    { title: '价差', render: (_, r) => fmt(num(r.newPrice) - num(r.origPrice)) },
    { title: '新增合同金额', render: (_, r) => fmt(remainForCalc(r) * (num(r.newPrice) - num(r.origPrice))) },
    { title: '备注', render: (_, r, i) => <Input value={r.remark} onChange={(e) => update(priceRows, setPriceRows, i, 'remark', e.target.value)} /> },
  ];

  const qtyColumns: ColumnsType<SuppRow> = [
    { title: '序号', width: 50, render: (_, __, i) => i + 1 },
    { title: '物资名称', render: (_, r, i) => origCell(r, 'name', qtyRows, setQtyRows, i) },
    { title: '规格型号', render: (_, r, i) => origCell(r, 'spec', qtyRows, setQtyRows, i) },
    { title: '计量单位', render: (_, r, i) => origCell(r, 'unit', qtyRows, setQtyRows, i) },
    { title: '原合同含税单价', render: (_, r, i) =>
      r.materialBaseId ? readonlyText(r.origPrice)
        : <InputNumber value={r.origPrice} onChange={(v) => update(qtyRows, setQtyRows, i, 'origPrice', num(v))} /> },
    { title: '原合同数量', render: (_, r, i) =>
      r.materialBaseId ? readonlyText(r.origQty)
        : <InputNumber value={r.origQty} onChange={(v) => update(qtyRows, setQtyRows, i, 'origQty', num(v))} /> },
    { title: '原合同剩余数量', render: (_, r) => readonlyText(remainOf(r)) },
    { title: '暂定新增数量', render: (_, r, i) => <InputNumber value={r.addQty} onChange={(v) => update(qtyRows, setQtyRows, i, 'addQty', num(v))} /> },
    { title: '原合同金额', render: (_, r) => fmt(num(r.origQty) * num(r.origPrice)) },
    { title: '暂定新增金额', render: (_, r) => fmt(num(r.addQty) * num(r.origPrice)) },
    { title: '备注', render: (_, r, i) => <Input value={r.remark} onChange={(e) => update(qtyRows, setQtyRows, i, 'remark', e.target.value)} /> },
  ];

  const itemColumns: ColumnsType<ItemRow> = [
    { title: '序号', width: 50, render: (_, __, i) => i + 1 },
    { title: '物资名称', render: (_, r, i) => <Input value={r.name} onChange={(e) => update(itemNew, setItemNew, i, 'name', e.target.value)} /> },
    { title: '规格型号', render: (_, r, i) => <Input value={r.spec} onChange={(e) => update(itemNew, setItemNew, i, 'spec', e.target.value)} /> },
    { title: '计量单位', render: (_, r, i) => <Input value={r.unit} onChange={(e) => update(itemNew, setItemNew, i, 'unit', e.target.value)} /> },
    { title: '税前单价', render: (_, r, i) => <InputNumber value={r.priceBeforeTax} onChange={(v) => update(itemNew, setItemNew, i, 'priceBeforeTax', num(v))} /> },
    { title: '税率(%)', render: (_, r, i) => <InputNumber value={r.taxRate} onChange={(v) => update(itemNew, setItemNew, i, 'taxRate', num(v))} /> },
    { title: '含税单价', render: (_, r) => fmt(num(r.priceBeforeTax) * (1 + num(r.taxRate) / 100)) },
    { title: '暂定新增数量', render: (_, r, i) => <InputNumber value={r.addQty} onChange={(v) => update(itemNew, setItemNew, i, 'addQty', num(v))} /> },
    { title: '暂定新增含税金额', render: (_, r) => fmt(num(r.priceBeforeTax) * (1 + num(r.taxRate) / 100) * num(r.addQty)) },
    { title: '备注', render: (_, r, i) => <Input value={r.remark} onChange={(e) => update(itemNew, setItemNew, i, 'remark', e.target.value)} /> },
  ];

  const origColumns: ColumnsType<OrigRow> = [
    { title: '序号', width: 50, render: (_, __, i) => i + 1 },
    { title: '物资名称', render: (_, r) => r?.name ?? '' },
    { title: '规格型号', render: (_, r) => r?.spec ?? '' },
    { title: '计量单位', render: (_, r) => r?.unit ?? '' },
    { title: '原合同含税单价', render: (_, r) => fmt(r?.priceWithTax) },
    { title: '原合同数量', render: (_, r) => fmt(r?.qty) },
    { title: '原合同金额', render: (_, r) => fmt(num(r?.totalWithTax)) },
  ];

  const deleteBtn = (rows: SuppRow[], setter: (v: SuppRow[]) => void, i: number): JSX.Element => (
    <Button type="link" danger size="small" icon={<DeleteOutlined />} onClick={() => setter(rows.filter((_, j) => j !== i))} />
  );

  return (
    <Drawer
      title={<Space>新增补充协议<DictTag typeCode="supplement_agreement_type" value={suppType} /></Space>}
      width={1160}
      open={open}
      onClose={onClose}
      footer={
        <Space style={{ float: 'right' }}>
          <Button icon={<SaveOutlined />} loading={creating} onClick={handleSave}>保存</Button>
          <Button icon={<EyeOutlined />} loading={previewing} onClick={handlePreview}>预览</Button>
          <Button type="primary" icon={<SendOutlined />} loading={publishing} onClick={handlePublish}>发布（完成）</Button>
        </Space>
      }
    >
      {loading ? <Alert type="info" message="加载中…" /> : (
        <Space direction="vertical" size={16} style={{ width: '100%' }}>
          <Card size="small" title="基础信息">
            <Form layout="vertical">
              <Form.Item label="补充协议编号（自动生成）"><Input value={code} disabled /></Form.Item>
              <Form.Item label="原合同（只读）">
                <Input value={`${parent?.code ?? ''} ${parent?.name ?? ''}`.trim()} disabled />
              </Form.Item>
              <Form.Item label="补充协议类型" required>
                <Select<SuppType> value={suppType} onChange={(v) => { setSuppType(v); setSaved(false); }} options={SUPP_TYPES.map((t) => ({ value: t.value, label: t.label }))} />
              </Form.Item>
            </Form>
          </Card>

          {isPrice && (
            <Card
              size="small"
              title={`${suppName(suppType)} · 价格调整明细（清单自动带出，仅可填补充协议含税单价）`}
              extra={priceRows.length === 0 && (
                <Button size="small" icon={<PlusOutlined />} onClick={() => setPriceRows([...priceRows, blankSupp()])}>手动加一行</Button>
              )}
            >
              {priceRows.length === 0 && (
                <Alert type="info" showIcon style={{ marginBottom: 8 }} message="原合同暂无合同清单，可手动添加物资行" />
              )}
              <Table<SuppRow> size="small" rowKey={(_, i) => String(i ?? 0)} dataSource={priceRows} pagination={false}
                scroll={{ x: 1560 }}
                columns={[...priceColumns, { title: '操作', width: 60, render: (_, __, i) => deleteBtn(priceRows, setPriceRows, i) }]} />
            </Card>
          )}

          {isQty && (
            <Card
              size="small"
              title="增量补充协议 · 数量增加明细（清单自动带出，仅可填暂定新增数量）"
              extra={qtyRows.length === 0 && (
                <Button size="small" icon={<PlusOutlined />} onClick={() => setQtyRows([...qtyRows, blankSupp()])}>手动加一行</Button>
              )}
            >
              {qtyRows.length === 0 && (
                <Alert type="info" showIcon style={{ marginBottom: 8 }} message="原合同暂无合同清单，可手动添加物资行" />
              )}
              <Table<SuppRow> size="small" rowKey={(_, i) => String(i ?? 0)} dataSource={qtyRows} pagination={false}
                scroll={{ x: 1500 }}
                columns={[...qtyColumns, { title: '操作', width: 60, render: (_, __, i) => deleteBtn(qtyRows, setQtyRows, i) }]} />
            </Card>
          )}

          {isItem && (
            <>
              <Card size="small" title="原合同清单（自动导入，只读）">
                <Table<OrigRow> size="small" rowKey={(_, i) => String(i ?? 0)} dataSource={itemOrig} pagination={false} scroll={{ x: 900 }} columns={origColumns} />
              </Card>
              <Card size="small" title="新增合同清单（增项）" extra={<Button size="small" icon={<PlusOutlined />} onClick={() => setItemNew([...itemNew, blankItem()])}>加一行</Button>}>
                <Table<ItemRow> size="small" rowKey={(_, i) => String(i ?? 0)} dataSource={itemNew} pagination={false} scroll={{ x: 1200 }}
                  columns={[...itemColumns, { title: '操作', width: 60, render: (_, __, i) => <Button type="link" danger size="small" icon={<DeleteOutlined />} onClick={() => setItemNew(itemNew.filter((_, j) => j !== i))} /> }]} />
              </Card>
            </>
          )}

          {isOther && (
            <Card size="small" title="其他类补充协议 · 正文（富文本，支持文字 / 图片 / 表格）">
              <RichTextEditor value={otherHtml} onChange={setOtherHtml} minHeight={360} placeholder="请输入补充协议正文，可插入图片与表格" />
            </Card>
          )}

          {isPrice && (
            <Alert
              type="info"
              showIcon
              message="计算规则：原合同剩余数量 = 原合同数量 − 日报已发生数量（结算数量合计）；剩余数量允许为负数显示，但计算新增合同金额时按 0 处理"
            />
          )}

          <Alert type="info" showIcon message={saved ? '已保存，可预览或发布' : '填写完成后请先「保存」，再「预览 / 发布」'} />
        </Space>
      )}

      <Modal title="补充协议预览" open={previewOpen} onCancel={() => setPreviewOpen(false)} width={900} footer={null} destroyOnClose>
        <div style={{ maxHeight: 560, overflow: 'auto', border: '1px solid #f0f0f0', padding: 16, background: '#fff' }} dangerouslySetInnerHTML={{ __html: previewHtml }} />
      </Modal>
    </Drawer>
  );
}
