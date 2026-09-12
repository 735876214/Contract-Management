import { forwardRef, useEffect, useImperativeHandle, useMemo, useState } from 'react';
import {
  Alert,
  Button,
  InputNumber,
  Modal,
  Select,
  Space,
  Table,
  Tag,
  message,
} from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { DeleteOutlined, PlusOutlined, SaveOutlined, SendOutlined } from '@ant-design/icons';
import { dictApi, type DictOption } from '@/api/dict';
import { materialApi, procurementTaskApi } from '@/api/modules';
import { taskStatusLabel } from '@/constants/procurementWorkflow';
import { calcAmount } from '@/utils/procurementPriceCompare';

/** 物资基础库选项（物资名称/规格型号只能从基础库选择，需求 2.2.1） */
interface MaterialOption {
  id: string;
  name: string;
  spec: string;
  unit: string | null;
}

/** 总采购清单行（需求修正 修改一：15 列含 5 个自动合价列） */
interface TotalRow {
  key: string;
  materialBaseId?: string;
  materialName?: string;
  spec?: string;
  unit?: string;
  qty?: number | null;
  incomePrice?: number | null;
  stdCost?: number | null;
  marketPrice?: number | null;
  infoPrice?: number | null;
  planPrice?: number | null;
}

interface TaskBrief {
  id: string;
  taskNo: string;
  status: string;
  stage: number;
}

let rowSeq = 0;
const nextKey = (): string => {
  rowSeq += 1;
  return `row-${Date.now()}-${rowSeq}`;
};

/** 价格/数量列通用渲染 */
const renderNumber = (
  value: number | null | undefined,
  onChange: (v: number | null) => void,
  disabled: boolean,
  precision = 2,
) => (
  <InputNumber
    size="small"
    style={{ width: '100%' }}
    min={0}
    precision={precision}
    value={value ?? undefined}
    disabled={disabled}
    onChange={(v) => onChange(typeof v === 'number' ? v : null)}
  />
);

/** 合价列：自动计算（单价 × 数量），只读（需求修正 修改一） */
const renderAmount = (price?: number | null, qty?: number | null) => {
  if (price == null && qty == null) return <span style={{ color: '#bfbfbf' }}>-</span>;
  const v = calcAmount(price, qty);
  return <span>{v.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>;
};

const fmtAmount = (v: number) =>
  v.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export interface TotalListEditorContentProps {
  task: TaskBrief | null;
  /** 内嵌模式：true 时不显示「保存并发布」（由外层流程控制发布时机） */
  embedded?: boolean;
  /** 只读查看（问题三补充）：列表行「总采购清单」入口为只读居中弹窗，不具备编辑能力 */
  readOnly?: boolean;
  /** 保存成功后回调（透传后端返回：含 estimatedAmountWan / preMeetingRequired） */
  onSaved?: (res: any) => void;
  /** 发布成功后回调（刷新任务列表状态） */
  onPublished?: () => void;
}

/** 对外暴露的动作（供外层 footer 调用；问题三：第二步「保存并发布」由外层触发） */
export interface TotalListContentRef {
  save: () => Promise<boolean>;
  saveAndPublish: () => Promise<boolean>;
}

/**
 * 总采购清单编辑内容区（需求修正 修改一）：
 * 15 列 = 序号 / 物资名称 / 规格型号 / 计量单位 / 暂定数量 / 收入单价·合价 /
 * 标准成本·合价 / 市场单价·合价 / 信息价·合价 / 预计采购单价·合价（+操作列）；
 * 5 个合价列自动计算不可改；表底显示各合价汇总行。
 */
export const TotalListEditorContent = forwardRef<TotalListContentRef, TotalListEditorContentProps>(
  function TotalListEditorContent({ task, embedded, readOnly, onSaved, onPublished }, ref) {
  const [units, setUnits] = useState<DictOption[]>([]);
  const [materials, setMaterials] = useState<MaterialOption[]>([]);
  const [rows, setRows] = useState<TotalRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [publishing, setPublishing] = useState(false);

  /** 冻结判定：任务发布总清单后（stage≥1）或已进入后续流程 → 只读（需求 2.2.4） */
  const frozen = !!task && (task.stage >= 1 || task.status !== 'NOT_STARTED');
  /** 只读查看（问题三补充）：readOnly 由外层入口决定，冻结由任务状态决定 */
  const viewOnly = readOnly || frozen;

  useEffect(() => {
    dictApi
      .options('measurement_unit')
      .then((r) => setUnits(r || []))
      .catch(() => setUnits([]));
    materialApi
      .options()
      .then((r: any) => setMaterials(Array.isArray(r) ? r : r?.list || []))
      .catch(() => setMaterials([]));
  }, [task?.id]);

  useEffect(() => {
    if (!task) return;
    setLoading(true);
    procurementTaskApi
      .totalList(task.id)
      .then((res: any) => {
        const items: any[] = res?.data?.items ?? res?.items ?? [];
        setRows(
          items.map((i) => ({
            key: i.id || nextKey(),
            materialBaseId: i.materialBaseId,
            materialName: i.materialName,
            spec: i.spec,
            unit: i.unit,
            qty: i.qty,
            incomePrice: i.incomePrice,
            stdCost: i.stdCost,
            marketPrice: i.marketPrice,
            infoPrice: i.infoPrice,
            planPrice: i.planPrice,
          })),
        );
      })
      .catch(() => setRows([]))
      .finally(() => setLoading(false));
  }, [task]);

  const materialOptions = useMemo(
    () =>
      materials.map((m) => ({
        value: m.id,
        label: `${m.name}（${m.spec}）`,
        raw: m,
      })),
    [materials],
  );

  // 物资基础库的 unit 存的是字典 itemName，故以 label 作为取值
  const unitOptions = useMemo(() => units.map((u) => ({ value: u.label, label: u.label })), [units]);

  const patchRow = (key: string, patch: Partial<TotalRow>) => {
    setRows((prev) => prev.map((r) => (r.key === key ? { ...r, ...patch } : r)));
  };

  /** 选择物资：自动带出名称/规格/计量单位默认值并直接显示（需求 2.2.1 / 2.2.2 / 修改三） */
  const handleMaterialChange = (key: string, baseId?: string) => {
    const hit = materials.find((m) => m.id === baseId);
    if (!hit) {
      patchRow(key, { materialBaseId: undefined, materialName: undefined, spec: undefined });
      return;
    }
    patchRow(key, {
      materialBaseId: hit.id,
      materialName: hit.name,
      spec: hit.spec,
      unit: hit.unit || undefined,
    });
  };

  const addRow = () => setRows((prev) => [...prev, { key: nextKey() }]);

  const removeRow = (key: string) => setRows((prev) => prev.filter((r) => r.key !== key));

  /** 合价汇总（需求修正 修改一：表底汇总行） */
  const totals = useMemo(() => {
    const sum = (pick: (r: TotalRow) => number | null | undefined) =>
      Math.round(rows.reduce((s, r) => s + calcAmount(pick(r), r.qty), 0) * 100) / 100;
    return {
      income: sum((r) => r.incomePrice),
      stdCost: sum((r) => r.stdCost),
      market: sum((r) => r.marketPrice),
      info: sum((r) => r.infoPrice),
      plan: sum((r) => r.planPrice),
    };
  }, [rows]);

  /** 控制价校验（需求 2.2.3）：预计采购单价 > 市场单价 → 禁止保存 */
  const validate = (): boolean => {
    for (const [idx, r] of rows.entries()) {
      if (!r.materialBaseId) {
        message.error(`第 ${idx + 1} 行请先从物资基础库选择物资`);
        return false;
      }
      if (!r.unit) {
        message.error(`第 ${idx + 1} 行请选择计量单位`);
        return false;
      }
      if (r.planPrice != null && r.marketPrice != null && r.planPrice > r.marketPrice) {
        message.error(`第 ${idx + 1} 行控制价超市场单价，重新修改`);
        return false;
      }
    }
    return true;
  };

  const payload = () =>
    rows.map((r, idx) => ({
      materialBaseId: r.materialBaseId,
      materialName: r.materialName,
      spec: r.spec,
      unit: r.unit,
      qty: r.qty ?? null,
      incomePrice: r.incomePrice ?? null,
      stdCost: r.stdCost ?? null,
      marketPrice: r.marketPrice ?? null,
      infoPrice: r.infoPrice ?? null,
      planPrice: r.planPrice ?? null,
      sortOrder: idx,
    }));

  const handleSave = async (): Promise<boolean> => {
    if (!task) return false;
    if (!validate()) return false;
    setSaving(true);
    try {
      const res: any = await procurementTaskApi.saveTotalList(task.id, payload());
      message.success(
        '总采购清单已保存（计量单位变更已同步物资基础库，采前会需求已按预计采购合价合计自动判定）',
      );
      onSaved?.(res?.data ?? res);
      return true;
    } finally {
      setSaving(false);
    }
  };

  /** 保存并发布（问题三：新建第二步「保存并发布」/ 编辑入口复用），返回是否成功 */
  const handlePublish = async (): Promise<boolean> => {
    if (!task) return false;
    setPublishing(true);
    try {
      const ok = await handleSave();
      if (!ok) return false;
      await procurementTaskApi.publish(task.id);
      message.success('总采购清单已发布并冻结，后续模块可引用其内容');
      onPublished?.();
      return true;
    } finally {
      setPublishing(false);
    }
  };

  // 问题三：向外暴露保存/保存并发布动作，供外层弹窗 footer 调用
  useImperativeHandle(ref, () => ({ save: handleSave, saveAndPublish: handlePublish }));

  const amountColumn = (
    title: string,
    pick: (r: TotalRow) => number | null | undefined,
    width = 110,
  ) => ({
    title,
    width,
    align: 'right' as const,
    render: (_: unknown, r: TotalRow) => renderAmount(pick(r), r.qty),
  });

  const columns: ColumnsType<TotalRow> = [
    { title: '序号', width: 52, render: (_, __, i) => i + 1 },
    {
      title: '物资名称',
      width: 190,
      render: (_, r) =>
        viewOnly ? (
          r.materialName || '-'
        ) : (
          <Select
            showSearch
            size="small"
            style={{ width: '100%' }}
            placeholder="从物资基础库选择"
            optionFilterProp="label"
            options={materialOptions}
            value={r.materialBaseId}
            onChange={(v) => handleMaterialChange(r.key, v as string)}
          />
        ),
    },
    {
      // 需求修正（修改三）：选择物资后直接显示真实规格型号，不再显示占位文字
      title: '规格型号',
      width: 130,
      render: (_, r) => r.spec || <span style={{ color: '#bfbfbf' }}>-</span>,
    },
    {
      title: '计量单位',
      width: 100,
      // 需求修正（修改三）：默认带出真实单位（选择物资时自动填入），为空显示“-”
      render: (_, r) =>
        viewOnly ? (
          r.unit || '-'
        ) : (
          <Select
            size="small"
            style={{ width: '100%' }}
            placeholder="-"
            options={unitOptions}
            value={r.unit}
            onChange={(v) => patchRow(r.key, { unit: v as string })}
          />
        ),
    },
    { title: '暂定数量', width: 100, render: (_, r) => renderNumber(r.qty, (v) => patchRow(r.key, { qty: v }), viewOnly, 3) },
    { title: '收入单价', width: 100, render: (_, r) => renderNumber(r.incomePrice, (v) => patchRow(r.key, { incomePrice: v }), viewOnly) },
    amountColumn('收入合价', (r) => r.incomePrice),
    { title: '标准成本', width: 100, render: (_, r) => renderNumber(r.stdCost, (v) => patchRow(r.key, { stdCost: v }), viewOnly) },
    amountColumn('标准成本合价', (r) => r.stdCost),
    { title: '市场单价', width: 100, render: (_, r) => renderNumber(r.marketPrice, (v) => patchRow(r.key, { marketPrice: v }), viewOnly) },
    amountColumn('市场合价', (r) => r.marketPrice),
    { title: '信息价', width: 100, render: (_, r) => renderNumber(r.infoPrice, (v) => patchRow(r.key, { infoPrice: v }), viewOnly) },
    amountColumn('信息价合价', (r) => r.infoPrice),
    {
      title: '预计采购单价',
      width: 110,
      render: (_, r) => {
        const over = r.planPrice != null && r.marketPrice != null && r.planPrice > r.marketPrice;
        return (
          <span style={over ? { color: '#cf1322' } : undefined} title={over ? '控制价超市场单价，重新修改' : undefined}>
            {renderNumber(r.planPrice, (v) => patchRow(r.key, { planPrice: v }), viewOnly)}
          </span>
        );
      },
    },
    {
      ...amountColumn('预计采购合价', (r) => r.planPrice, 110),
      onCell: (r: TotalRow) => ({
        style:
          r.planPrice != null && r.marketPrice != null && r.planPrice > r.marketPrice
            ? { color: '#cf1322' }
            : undefined,
      }),
    },
    {
      title: '操作',
      width: 70,
      render: (_, r) =>
        viewOnly ? null : (
          <Button type="link" size="small" danger icon={<DeleteOutlined />} onClick={() => removeRow(r.key)}>
            删除
          </Button>
        ),
    },
  ];

  return (
    <Space direction="vertical" size={12} style={{ width: '100%' }}>
      {!viewOnly && (
        <Space wrap>
          <Button icon={<PlusOutlined />} onClick={addRow}>
            添加物资
          </Button>
          {!embedded && (
            <Button icon={<SaveOutlined />} loading={saving} onClick={handleSave}>
              保存
            </Button>
          )}
          {!embedded && (
            <Button type="primary" icon={<SendOutlined />} loading={publishing} onClick={handlePublish}>
              保存并发布
            </Button>
          )}
        </Space>
      )}
      {readOnly ? (
        <Alert
          type="info"
          showIcon
          message="总采购清单为只读查看；如需修改，请在发布前通过「继续编辑」进入编制。"
        />
      ) : frozen ? (
        <Alert
          type="info"
          showIcon
          message={`总采购清单已发布冻结（当前状态：${task ? taskStatusLabel(task.status) : ''}），仅可查看；后续模块可引用其内容自动填写。`}
        />
      ) : (
        <Alert
          type="warning"
          showIcon
          message="物资名称/规格型号只能从物资基础库选择；计量单位默认带出、可改为字典值（提交时同步到基础库）；预计采购单价不得高于市场单价。合价列与表底汇总由系统自动计算，保存后按「预计采购合价合计 ≥ 100 万元」自动判定是否需要采前会会议纪要。"
        />
      )}
      <Table<TotalRow>
        rowKey="key"
        size="small"
        loading={loading}
        columns={columns}
        dataSource={rows}
        pagination={false}
        scroll={{ x: 1620 }}
        summary={() => (
          <Table.Summary fixed>
            <Table.Summary.Row style={{ fontWeight: 600 }}>
              <Table.Summary.Cell index={0} colSpan={5} align="right">
                合计
              </Table.Summary.Cell>
              <Table.Summary.Cell index={1} align="right">{fmtAmount(totals.income)}</Table.Summary.Cell>
              <Table.Summary.Cell index={2} />
              <Table.Summary.Cell index={3} align="right">{fmtAmount(totals.stdCost)}</Table.Summary.Cell>
              <Table.Summary.Cell index={4} />
              <Table.Summary.Cell index={5} align="right">{fmtAmount(totals.market)}</Table.Summary.Cell>
              <Table.Summary.Cell index={6} />
              <Table.Summary.Cell index={7} align="right">{fmtAmount(totals.info)}</Table.Summary.Cell>
              <Table.Summary.Cell index={8} />
              <Table.Summary.Cell index={9} align="right">{fmtAmount(totals.plan)}</Table.Summary.Cell>
              <Table.Summary.Cell index={10} />
            </Table.Summary.Row>
          </Table.Summary>
        )}
        footer={() =>
          !viewOnly && (
            <Button type="dashed" block icon={<PlusOutlined />} onClick={addRow}>
              添加物资
            </Button>
          )
        }
      />
      {rows.length > 0 && (
        <Space wrap size={4}>
          <Tag color="green">共 {rows.length} 条明细</Tag>
          <Tag color="blue">收入合价合计 {fmtAmount(totals.income)}</Tag>
          <Tag color="blue">标准成本合价合计 {fmtAmount(totals.stdCost)}</Tag>
          <Tag color="blue">市场合价合计 {fmtAmount(totals.market)}</Tag>
          <Tag color="blue">信息价合价合计 {fmtAmount(totals.info)}</Tag>
          <Tag color={totals.plan >= 1_000_000 ? 'red' : 'blue'}>
            预计采购合价合计 {fmtAmount(totals.plan)}
            {totals.plan >= 1_000_000 ? '（≥100万，需采前会）' : ''}
          </Tag>
        </Space>
      )}
    </Space>
  );
  },
);

/** 总采购清单查看（问题三补充：任务列表入口 → 只读居中弹窗，非侧边抽屉） */
export default function TotalListEditor({
  task,
  open,
  onClose,
}: Omit<TotalListEditorContentProps, 'embedded' | 'onSaved' | 'onPublished'> & {
  open: boolean;
  onClose: () => void;
}) {
  return (
    <Modal
      title={task ? `总采购清单 · ${task.taskNo}` : '总采购清单'}
      width={1280}
      centered
      open={open}
      onCancel={onClose}
      footer={null}
      destroyOnClose
    >
      <TotalListEditorContent task={task} readOnly />
    </Modal>
  );
}
