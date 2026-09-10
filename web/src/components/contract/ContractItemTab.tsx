import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Alert, Button, Input, InputNumber, Popconfirm, Space, Table, Tag, message } from 'antd';
import { DeleteOutlined, SaveOutlined, PlusOutlined } from '@ant-design/icons';
import { contractApi } from '@/api/business';

/** 4 位精度计算：含税单价 = 税前单价 × (1 + 税率/100)；暂定含税合价 = 含税单价 × 暂定数量 */
const round4 = (v: number) => Math.round(v * 1e4) / 1e4;
const calcPriceWithTax = (price?: number | null, tax?: number | null) =>
  price == null || tax == null ? null : round4(price * (1 + tax / 100));
const calcTotal = (priceWithTax?: number | null, qty?: number | null) =>
  priceWithTax == null || qty == null ? null : round4(priceWithTax * qty);

/**
 * 合同起草 · Tab2：合同清单（交易明细 / 执行池）
 * - 独立维护，可通过「从物料编码清单添加」手动从 Tab1 同步（不再自动派生）
 * - 数量、税前单价可编辑；税率为只读，统一来源于合同基本信息中的「合同税率」（需求修正2）
 * - 含税单价与暂定含税合价实时自动计算
 */
export default function ContractItemTab({ contractId }: { contractId: string }) {
  const [rows, setRows] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [poolIds, setPoolIds] = useState<any[]>([]); // 物料编码清单（用于派生勾选）
  const [selectedRowKeys, setSelectedRowKeys] = useState<string[]>([]); // 派生勾选项
  const [deriveOpen, setDeriveOpen] = useState(false);
  const dirtyRef = useRef(false);

  const load = useCallback(async () => {
    if (!contractId) return;
    setLoading(true);
    try {
      const [list, pool]: any[] = await Promise.all([
        contractApi.draftList(contractId),
        contractApi.poolList(contractId),
      ]);
      setRows(Array.isArray(list) ? list : list?.list || []);
      setPoolIds(Array.isArray(pool) ? pool : pool?.list || []);
    } finally {
      setLoading(false);
    }
  }, [contractId]);

  useEffect(() => {
    load();
  }, [load]);

  /** 本地改值：同步更新当前行并重算派生列（前端实时计算，保存时服务端二次校验） */
  const patch = (id: string, key: string, value: any) => {
    dirtyRef.current = true;
    setRows((prev) =>
      prev.map((r) => {
        if (r.id !== id) return r;
        const next = { ...r, [key]: value };
        const priceWithTax = calcPriceWithTax(next.priceBeforeTax, next.taxRatePct);
        next.priceWithTax = priceWithTax;
        next.totalWithTax = calcTotal(priceWithTax, next.qty);
        return next;
      }),
    );
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      const res: any = await contractApi.draftSave(contractId, rows);
      message.success(`已保存 ${res?.saved ?? rows.length} 行`);
      dirtyRef.current = false;
      load();
    } finally {
      setSaving(false);
    }
  };

  const handleDerive = async () => {
    if (!selectedRowKeys.length) return message.warning('请勾选要派生的物料');
    const res: any = await contractApi.draftDerive(contractId, selectedRowKeys);
    message.success(`已派生 ${res?.added ?? 0} 行${res?.skipped ? `，跳过已存在 ${res.skipped} 行` : ''}`);
    setDeriveOpen(false);
    setSelectedRowKeys([]);
    load();
  };

  const handleRemove = async (id: string) => {
    await contractApi.draftRemove(contractId, id);
    message.success('已删除');
    load();
  };

  const totalAmount = useMemo(
    () => rows.reduce((s, r) => s + (Number(r.totalWithTax) || 0), 0),
    [rows],
  );

  /** 需求修正2：存在未维护税率的行时给出红色提示（税率来源：合同基本信息的合同税率） */
  const missingTax = useMemo(() => rows.some((r) => r.taxRatePct == null), [rows]);

  return (
    <Space direction="vertical" size={12} style={{ width: '100%' }}>
      {missingTax && (
        <Alert
          type="error"
          showIcon
          message="请先在物资基础信息中维护税率"
          description="部分清单行的税率尚未维护。请在上方「基础信息」中填写合同税率并保存，保存后所有物料税率将自动同步。"
        />
      )}
      <Space wrap>
        <Button icon={<PlusOutlined />} onClick={() => setDeriveOpen((v) => !v)}>
          {deriveOpen ? '收起物料列表' : '从物料编码清单添加'}
        </Button>
        <Button type="primary" icon={<SaveOutlined />} loading={saving} onClick={handleSave}>
          保存清单
        </Button>
        <span style={{ color: '#888' }}>
          合计（暂定含税）：<b style={{ color: '#cf1322' }}>¥{totalAmount.toLocaleString('zh-CN', { maximumFractionDigits: 2 })}</b>
        </span>
      </Space>

      {deriveOpen && (
        <Table
          rowKey="materialBaseId"
          size="small"
          dataSource={poolIds}
          pagination={false}
          rowSelection={{ selectedRowKeys, onChange: (keys: any) => setSelectedRowKeys(keys) }}
          columns={[
            { title: '物资名称', dataIndex: 'name' },
            { title: '规格型号', dataIndex: 'spec', width: 180 },
          ]}
          footer={() => (
            <Space>
              <Button
                size="small"
                onClick={() =>
                  setSelectedRowKeys(poolIds.map((p: any) => p.materialBaseId))
                }
              >
                全选
              </Button>
              <Button size="small" type="primary" onClick={handleDerive}>
                确认派生到合同清单
              </Button>
            </Space>
          )}
        />
      )}

      <Table
        rowKey="id"
        size="small"
        loading={loading}
        dataSource={rows}
        pagination={false}
        scroll={{ x: 1200 }}
        columns={[
          { title: '序号', dataIndex: 'seqNo', width: 70, render: (_, __, i) => i + 1 },
          { title: '物资名称', dataIndex: 'name', width: 160 },
          { title: '规格型号', dataIndex: 'spec', width: 150 },
          {
            title: '计量单位',
            dataIndex: 'unit',
            width: 110,
            render: (v, row) => (
              <Input
                defaultValue={v || ''}
                onBlur={(e) => patch(row.id, 'unit', e.target.value)}
                placeholder="如 吨/米"
              />
            ),
          },
          {
            title: '暂定数量',
            dataIndex: 'qty',
            width: 120,
            render: (v, row) => (
              <InputNumber
                defaultValue={v}
                min={0}
                precision={4}
                style={{ width: '100%' }}
                onChange={(val) => patch(row.id, 'qty', val)}
              />
            ),
          },
          {
            title: '税前单价',
            dataIndex: 'priceBeforeTax',
            width: 120,
            render: (v, row) => (
              <InputNumber
                defaultValue={v}
                min={0}
                precision={4}
                style={{ width: '100%' }}
                onChange={(val) => patch(row.id, 'priceBeforeTax', val)}
              />
            ),
          },
          {
            title: '税率(%)',
            dataIndex: 'taxRatePct',
            width: 100,
            // 需求修正2：税率只读，统一来源于合同基本信息中的「合同税率」
            render: (v) =>
              v == null ? (
                <Tag color="red">未维护</Tag>
              ) : (
                <Tag color="green">{Number(v).toFixed(2)}</Tag>
              ),
          },
          {
            title: '含税单价（自动）',
            dataIndex: 'priceWithTax',
            width: 130,
            render: (v) => (v == null ? '-' : <Tag color="blue">{Number(v).toFixed(4)}</Tag>),
          },
          {
            title: '暂定含税合价（自动）',
            dataIndex: 'totalWithTax',
            width: 150,
            render: (v) => (v == null ? '-' : <Tag color="blue">{Number(v).toFixed(4)}</Tag>),
          },
          {
            title: '备注',
            dataIndex: 'remark',
            width: 160,
            render: (v, row) => (
              <Input defaultValue={v || ''} onBlur={(e) => patch(row.id, 'remark', e.target.value)} />
            ),
          },
          {
            title: '操作',
            width: 80,
            fixed: 'right',
            render: (_, row) => (
              <Popconfirm title="确认删除该清单行？" onConfirm={() => handleRemove(row.id)}>
                <Button type="link" size="small" danger icon={<DeleteOutlined />}>
                  删除
                </Button>
              </Popconfirm>
            ),
          },
        ]}
      />
    </Space>
  );
}
