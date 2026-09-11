import { useEffect, useMemo, useState } from 'react';
import {
  Alert, Button, Card, Drawer, Form, Input, InputNumber, Select, Space, Table, message, Modal,
} from 'antd';
import { DeleteOutlined, PlusOutlined, EyeOutlined, SendOutlined, SaveOutlined } from '@ant-design/icons';
import { contractApi, templateApi } from '@/api/business';
import RichTextEditor from '@/components/RichTextEditor';
import { amountToChineseCapital } from '@/utils/money';
import { DictTag } from '@/components/DictSelect';

const SUPP_TYPES = [
  { value: 'PRICE_UP', label: '涨价补充协议' },
  { value: 'PRICE_DOWN', label: '降价补充协议' },
  { value: 'QTY_ADD', label: '增量补充协议' },
  { value: 'ITEM_ADD', label: '增项补充协议' },
  { value: 'OTHER', label: '其他类补充协议' },
];
const suppName = (code: string) => SUPP_TYPES.find((t) => t.value === code)?.label || code;

const num = (v: any) => (v === '' || v == null || isNaN(Number(v)) ? 0 : Number(v));
const fmt = (v: any) => (num(v) === 0 ? '0.00' : Number(num(v)).toLocaleString('zh-CN', { maximumFractionDigits: 2 }));
const fmtPct = (v: any) => `${(num(v) * 100).toFixed(2)}%`;

/** 构造与后端 buildTableHtml 一致的表格 HTML（用于 {{补充协议表}} 占位符） */
function buildTableHtml(headers: string[], rows: (string | number)[][]) {
  const esc = (v: any) => String(v ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const thead = `<tr>${headers.map((h) => `<th style="border:1px solid #000;padding:4px 6px;background:#f2f2f2;">${esc(h)}</th>`).join('')}</tr>`;
  const tbody = rows.length
    ? rows.map((r) => `<tr>${r.map((c) => `<td style="border:1px solid #000;padding:4px 6px;text-align:center;">${esc(c)}</td>`).join('')}</tr>`).join('')
    : `<tr><td style="border:1px solid #000;padding:4px 6px;text-align:center;" colspan="${headers.length}">暂无数据</td></tr>`;
  return `<table style="border-collapse:collapse;width:100%;">${thead}${tbody}</table>`;
}

interface Props {
  parent: any;
  open: boolean;
  onClose: () => void;
  onDone: () => void;
}

export default function SupplementDraft({ parent, open, onClose, onDone }: Props) {
  const [loading, setLoading] = useState(false);
  const [creating, setCreating] = useState(false);
  const [contractId, setContractId] = useState<string | null>(null);
  const [code, setCode] = useState('');
  const [seq, setSeq] = useState(1);
  const [suppType, setSuppType] = useState<string>('PRICE_UP');
  const [saved, setSaved] = useState(false);

  // 各类型表数据
  const [priceRows, setPriceRows] = useState<any[]>([]);
  const [qtyRows, setQtyRows] = useState<any[]>([]);
  const [itemOrig, setItemOrig] = useState<any[]>([]);
  const [itemNew, setItemNew] = useState<any[]>([]);
  const [otherHtml, setOtherHtml] = useState('');

  const [previewOpen, setPreviewOpen] = useState(false);
  const [previewHtml, setPreviewHtml] = useState('');
  const [previewing, setPreviewing] = useState(false);
  const [publishing, setPublishing] = useState(false);

  // 打开时初始化：拉取补充协议编号并创建草稿
  useEffect(() => {
    if (!open || !parent) return;
    reset();
    setLoading(true);
    (async () => {
      try {
        const nc: any = await contractApi.nextSupplementCode(parent.id);
        setCode(nc?.code || '');
        setSeq(nc?.seq || 1);
        // 导入原合同清单（增项协议展示用）
        let orig: any[] = [];
        try {
          const m: any = await contractApi.draftList(parent.id);
          orig = Array.isArray(m) ? m : m?.list || [];
        } catch { /* 无清单则忽略 */ }
        setItemOrig(orig);
      } catch {
        message.error('获取补充协议编号失败');
      } finally {
        setLoading(false);
      }
    })();
  }, [open, parent]);

  const reset = () => {
    setContractId(null); setSuppType('PRICE_UP'); setSaved(false);
    setPriceRows([blankPrice()]); setQtyRows([blankQty()]); setItemNew([blankItem()]); setOtherHtml('');
  };

  const blankPrice = () => ({ name: '', spec: '', unit: '', origQty: 0, remainQty: 0, origPrice: 0, newPrice: 0, remark: '' });
  const blankQty = () => ({ name: '', spec: '', unit: '', origPrice: 0, origQty: 0, addQty: 0, remark: '' });
  const blankItem = () => ({ name: '', spec: '', unit: '', priceBeforeTax: 0, taxRate: 13, priceWithTax: 0, addQty: 0, remark: '' });

  /** 创建补充协议草稿（仅首次），返回 id */
  const ensureContract = async (): Promise<string | null> => {
    if (contractId) return contractId;
    if (!code) return null;
    setCreating(true);
    try {
      const created: any = await contractApi.create({
        code,
        name: `${parent.name || parent.code}之补充协议（${seq}）`,
        typeCode: parent.typeCode,
        supplierId: parent.supplierId,
        templateId: parent.templateId,
        isSupplement: 'Y',
        parentContractId: parent.id,
        supplementTypeCode: suppType,
        status: 'DRAFT',
      });
      const id = created?.id || created?.data?.id;
      setContractId(id);
      return id;
    } finally {
      setCreating(false);
    }
  };

  /** 计算并组装 formData.supplement（已解析好的占位符值） */
  const buildSupplementData = () => {
    const parentAmount = num(parent.amount);
    const base: Record<string, any> = {
      补充协议编号: code,
      补充协议类型: suppName(suppType),
      原合同编号: parent.code,
      原合同名称: parent.name || '',
    };
    if (suppType === 'PRICE_UP' || suppType === 'PRICE_DOWN') {
      const rows = priceRows.map((r, i) => {
        const origAmount = num(r.origQty) * num(r.origPrice);
        const diff = num(r.newPrice) - num(r.origPrice);
        const newAmount = num(r.remainQty) * diff;
        return { ...r, origAmount, diff, newAmount, i };
      });
      const newTotal = rows.reduce((s, r) => s + r.newAmount, 0);
      const qtyTotal = rows.reduce((s, r) => s + num(r.origQty), 0);
      base['补充协议表'] = buildTableHtml(
        ['序号', '物资名称', '规格型号', '计量单位', '原合同数量', '原合同剩余数量', '原合同含税单价', '原合同金额',
          '补充协议含税单价', '原合同与补充协议价差', '新增合同金额', '累计占原合同金额比例', '备注'],
        rows.map((r) => [r.i + 1, r.name, r.spec, r.unit, fmt(r.origQty), fmt(r.remainQty), fmt(r.origPrice), fmt(r.origAmount),
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
        ['序号', '物资名称', '规格型号', '计量单位', '原合同含税单价', '原合同数量', '暂定新增数量', '原合同金额', '暂定新增金额', '累计占原合同金额比例', '备注'],
        rows.map((r) => [r.i + 1, r.name, r.spec, r.unit, fmt(r.origPrice), fmt(r.origQty), fmt(r.addQty), fmt(r.origAmount),
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
            itemOrig.map((r, i) => [i + 1, r.materialBase?.name || r.name || '', r.materialBase?.spec || r.spec || '',
              r.unit || '', fmt(r.priceWithTax), fmt(r.qty), fmt(r.totalWithTax)])) + base['补充协议表'];
      }
    } else {
      // OTHER：富文本正文
      base['其他补充协议内容'] = otherHtml;
      base['补充协议表'] = '';
    }
    return base;
  };

  const handleSave = async () => {
    const id = await ensureContract();
    if (!id) { message.error('补充协议创建失败'); return; }
    const supplement = buildSupplementData();
    await contractApi.update(id, { supplementTypeCode: suppType, formData: { supplement } });
    setSaved(true);
    message.success('已保存补充协议内容');
  };

  const handlePreview = async () => {
    const id = await ensureContract();
    if (!id) { message.error('补充协议创建失败'); return; }
    await handleSaveSilent(id);
    if (!parent.templateId) { message.warning('原合同未关联模板，无法预览'); return; }
    setPreviewing(true);
    try {
      const res: any = await templateApi.generate({ templateId: parent.templateId, contractId: id });
      setPreviewHtml(res?.html || '');
      setPreviewOpen(true);
    } finally { setPreviewing(false); }
  };

  const handleSaveSilent = async (id: string) => {
    const supplement = buildSupplementData();
    await contractApi.update(id, { supplementTypeCode: suppType, formData: { supplement } });
    setSaved(true);
  };

  const handlePublish = async () => {
    const id = await ensureContract();
    if (!id) { message.error('补充协议创建失败'); return; }
    await handleSaveSilent(id);
    Modal.confirm({
      title: '发布补充协议',
      content: '发布后该补充协议将进入「合同查询」列表，状态为审批中，合同类型与内容不可再修改。',
      okText: '确认发布', cancelText: '再检查一下',
      onOk: async () => {
        setPublishing(true);
        try {
          await contractApi.publish(id);
          message.success('补充协议已发布');
          onDone();
        } finally { setPublishing(false); }
      },
    });
  };

  const isPrice = suppType === 'PRICE_UP' || suppType === 'PRICE_DOWN';
  const isQty = suppType === 'QTY_ADD';
  const isItem = suppType === 'ITEM_ADD';
  const isOther = suppType === 'OTHER';

  const priceColumns = [
    { title: '序号', width: 50, render: (_: any, __: any, i: number) => i + 1 },
    { title: '物资名称', render: (_: any, r: any, i: number) => <Input value={r.name} onChange={(e) => update(priceRows, setPriceRows, i, 'name', e.target.value)} />, },
    { title: '规格型号', render: (_: any, r: any, i: number) => <Input value={r.spec} onChange={(e) => update(priceRows, setPriceRows, i, 'spec', e.target.value)} />, },
    { title: '计量单位', render: (_: any, r: any, i: number) => <Input value={r.unit} onChange={(e) => update(priceRows, setPriceRows, i, 'unit', e.target.value)} />, },
    { title: '原合同数量', render: (_: any, r: any, i: number) => <InputNumber value={r.origQty} onChange={(v) => update(priceRows, setPriceRows, i, 'origQty', v)} />, },
    { title: '原合同剩余数量', render: (_: any, r: any, i: number) => <InputNumber value={r.remainQty} onChange={(v) => update(priceRows, setPriceRows, i, 'remainQty', v)} />, },
    { title: '原合同含税单价', render: (_: any, r: any, i: number) => <InputNumber value={r.origPrice} onChange={(v) => update(priceRows, setPriceRows, i, 'origPrice', v)} />, },
    { title: '原合同金额', render: (_: any, r: any) => fmt(num(r.origQty) * num(r.origPrice)) },
    { title: '补充协议含税单价', render: (_: any, r: any, i: number) => <InputNumber value={r.newPrice} onChange={(v) => update(priceRows, setPriceRows, i, 'newPrice', v)} />, },
    { title: '价差', render: (_: any, r: any) => fmt(num(r.newPrice) - num(r.origPrice)) },
    { title: '新增合同金额', render: (_: any, r: any) => fmt(num(r.remainQty) * (num(r.newPrice) - num(r.origPrice))) },
    { title: '备注', render: (_: any, r: any, i: number) => <Input value={r.remark} onChange={(e) => update(priceRows, setPriceRows, i, 'remark', e.target.value)} />, },
  ];

  const qtyColumns = [
    { title: '序号', width: 50, render: (_: any, __: any, i: number) => i + 1 },
    { title: '物资名称', render: (_: any, r: any, i: number) => <Input value={r.name} onChange={(e) => update(qtyRows, setQtyRows, i, 'name', e.target.value)} />, },
    { title: '规格型号', render: (_: any, r: any, i: number) => <Input value={r.spec} onChange={(e) => update(qtyRows, setQtyRows, i, 'spec', e.target.value)} />, },
    { title: '计量单位', render: (_: any, r: any, i: number) => <Input value={r.unit} onChange={(e) => update(qtyRows, setQtyRows, i, 'unit', e.target.value)} />, },
    { title: '原合同含税单价', render: (_: any, r: any, i: number) => <InputNumber value={r.origPrice} onChange={(v) => update(qtyRows, setQtyRows, i, 'origPrice', v)} />, },
    { title: '原合同数量', render: (_: any, r: any, i: number) => <InputNumber value={r.origQty} onChange={(v) => update(qtyRows, setQtyRows, i, 'origQty', v)} />, },
    { title: '原合同金额', render: (_: any, r: any) => fmt(num(r.origQty) * num(r.origPrice)) },
    { title: '暂定新增数量', render: (_: any, r: any, i: number) => <InputNumber value={r.addQty} onChange={(v) => update(qtyRows, setQtyRows, i, 'addQty', v)} />, },
    { title: '暂定新增金额', render: (_: any, r: any) => fmt(num(r.addQty) * num(r.origPrice)) },
    { title: '备注', render: (_: any, r: any, i: number) => <Input value={r.remark} onChange={(e) => update(qtyRows, setQtyRows, i, 'remark', e.target.value)} />, },
  ];

  const itemColumns = [
    { title: '序号', width: 50, render: (_: any, __: any, i: number) => i + 1 },
    { title: '物资名称', render: (_: any, r: any, i: number) => <Input value={r.name} onChange={(e) => update(itemNew, setItemNew, i, 'name', e.target.value)} />, },
    { title: '规格型号', render: (_: any, r: any, i: number) => <Input value={r.spec} onChange={(e) => update(itemNew, setItemNew, i, 'spec', e.target.value)} />, },
    { title: '计量单位', render: (_: any, r: any, i: number) => <Input value={r.unit} onChange={(e) => update(itemNew, setItemNew, i, 'unit', e.target.value)} />, },
    { title: '税前单价', render: (_: any, r: any, i: number) => <InputNumber value={r.priceBeforeTax} onChange={(v) => update(itemNew, setItemNew, i, 'priceBeforeTax', v)} />, },
    { title: '税率(%)', render: (_: any, r: any, i: number) => <InputNumber value={r.taxRate} onChange={(v) => update(itemNew, setItemNew, i, 'taxRate', v)} />, },
    { title: '含税单价', render: (_: any, r: any) => fmt(num(r.priceBeforeTax) * (1 + num(r.taxRate) / 100)) },
    { title: '暂定新增数量', render: (_: any, r: any, i: number) => <InputNumber value={r.addQty} onChange={(v) => update(itemNew, setItemNew, i, 'addQty', v)} />, },
    { title: '暂定新增含税金额', render: (_: any, r: any) => fmt(num(r.priceBeforeTax) * (1 + num(r.taxRate) / 100) * num(r.addQty)) },
    { title: '备注', render: (_: any, r: any, i: number) => <Input value={r.remark} onChange={(e) => update(itemNew, setItemNew, i, 'remark', e.target.value)} />, },
  ];

  return (
    <Drawer
      title={<Space>新增补充协议<DictTag typeCode="supplement_agreement_type" value={suppType} /></Space>}
      width={1040}
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
                <Input value={`${parent.code} ${parent.name || ''}`} disabled />
              </Form.Item>
              <Form.Item label="补充协议类型" required>
                <Select value={suppType} onChange={(v) => { setSuppType(v); setSaved(false); }} options={SUPP_TYPES} />
              </Form.Item>
            </Form>
          </Card>

          {isPrice && (
            <Card size="small" title={`${suppName(suppType)} · 价格调整明细`} extra={<Button size="small" icon={<PlusOutlined />} onClick={() => setPriceRows([...priceRows, blankPrice()])}>加一行</Button>}>
              <Table size="small" rowKey={(_, i) => String(i)} dataSource={priceRows} pagination={false}
                scroll={{ x: 1400 }}
                columns={[...priceColumns, { title: '操作', width: 60, render: (_: any, __: any, i: number) => <Button type="link" danger size="small" icon={<DeleteOutlined />} onClick={() => setPriceRows(priceRows.filter((_, j) => j !== i))} /> }]} />
            </Card>
          )}

          {isQty && (
            <Card size="small" title="增量补充协议 · 数量增加明细" extra={<Button size="small" icon={<PlusOutlined />} onClick={() => setQtyRows([...qtyRows, blankQty()])}>加一行</Button>}>
              <Table size="small" rowKey={(_, i) => String(i)} dataSource={qtyRows} pagination={false}
                scroll={{ x: 1200 }}
                columns={[...qtyColumns, { title: '操作', width: 60, render: (_: any, __: any, i: number) => <Button type="link" danger size="small" icon={<DeleteOutlined />} onClick={() => setQtyRows(qtyRows.filter((_, j) => j !== i))} /> }]} />
            </Card>
          )}

          {isItem && (
            <>
              <Card size="small" title="原合同清单（自动导入，只读）">
                <Table size="small" rowKey={(_, i) => String(i)} dataSource={itemOrig} pagination={false} scroll={{ x: 900 }}
                  columns={[
                    { title: '序号', width: 50, render: (_: any, __: any, i: number) => i + 1 },
                    { title: '物资名称', render: (r: any) => r.materialBase?.name || r.name || '' },
                    { title: '规格型号', render: (r: any) => r.materialBase?.spec || r.spec || '' },
                    { title: '计量单位', dataIndex: 'unit' },
                    { title: '原合同含税单价', render: (r: any) => fmt(r.priceWithTax) },
                    { title: '原合同数量', dataIndex: 'qty', render: (v: any) => fmt(v) },
                    { title: '原合同金额', render: (r: any) => fmt(num(r.totalWithTax)) },
                  ]} />
              </Card>
              <Card size="small" title="新增合同清单（增项）" extra={<Button size="small" icon={<PlusOutlined />} onClick={() => setItemNew([...itemNew, blankItem()])}>加一行</Button>}>
                <Table size="small" rowKey={(_, i) => String(i)} dataSource={itemNew} pagination={false} scroll={{ x: 1200 }}
                  columns={[...itemColumns, { title: '操作', width: 60, render: (_: any, __: any, i: number) => <Button type="link" danger size="small" icon={<DeleteOutlined />} onClick={() => setItemNew(itemNew.filter((_, j) => j !== i))} /> }]} />
              </Card>
            </>
          )}

          {isOther && (
            <Card size="small" title="其他类补充协议 · 正文（富文本，支持文字 / 图片 / 表格）">
              <RichTextEditor value={otherHtml} onChange={setOtherHtml} minHeight={360} placeholder="请输入补充协议正文，可插入图片与表格" />
            </Card>
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

/** 更新数组第 i 项指定字段 */
function update(rows: any[], setter: (v: any[]) => void, i: number, field: string, value: any) {
  const next = rows.slice();
  next[i] = { ...next[i], [field]: value };
  setter(next);
}
