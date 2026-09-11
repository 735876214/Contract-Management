import { useEffect, useMemo, useState } from 'react';
import {
  Alert,
  Button,
  Drawer,
  InputNumber,
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

/** 物资基础库选项（物资名称/规格型号只能从基础库选择，需求 2.2.1） */
interface MaterialOption {
  id: string;
  name: string;
  spec: string;
  unit: string | null;
}

/** 总采购清单行（需求 2.2 表头字段） */
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

interface Props {
  task: TaskBrief | null;
  open: boolean;
  onClose: () => void;
  /** 发布成功后回调（刷新任务列表状态） */
  onPublished?: () => void;
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

export default function TotalListEditor({ task, open, onClose, onPublished }: Props) {
  const [units, setUnits] = useState<DictOption[]>([]);
  const [materials, setMaterials] = useState<MaterialOption[]>([]);
  const [rows, setRows] = useState<TotalRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [publishing, setPublishing] = useState(false);

  /** 冻结判定：任务发布总清单后（stage≥1）或已进入后续流程 → 只读（需求 2.2.4） */
  const frozen = !!task && (task.stage >= 1 || task.status !== 'NOT_STARTED');

  useEffect(() => {
    if (!open) return;
    dictApi
      .options('measurement_unit')
      .then((r) => setUnits(r || []))
      .catch(() => setUnits([]));
    materialApi
      .options()
      .then((r: any) => setMaterials(Array.isArray(r) ? r : r?.list || []))
      .catch(() => setMaterials([]));
  }, [open]);

  useEffect(() => {
    if (!open || !task) return;
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
  }, [open, task]);

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

  /** 选择物资：自动带出名称/规格/计量单位默认值（需求 2.2.1 / 2.2.2） */
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
      await procurementTaskApi.saveTotalList(task.id, payload());
      message.success('总采购清单已保存（计量单位变更已同步物资基础库）');
      return true;
    } finally {
      setSaving(false);
    }
  };

  const handlePublish = async () => {
    if (!task) return;
    setPublishing(true);
    try {
      const ok = await handleSave();
      if (!ok) return;
      await procurementTaskApi.publish(task.id);
      message.success('总采购清单已发布并冻结，后续模块可引用其内容');
      onPublished?.();
      onClose();
    } finally {
      setPublishing(false);
    }
  };

  const columns: ColumnsType<TotalRow> = [
    { title: '序号', width: 56, render: (_, __, i) => i + 1 },
    {
      title: '物资名称 / 规格型号',
      width: 240,
      render: (_, r) =>
        frozen ? (
          <span>
            {r.materialName}（{r.spec}）
          </span>
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
      title: '计量单位',
      width: 110,
      render: (_, r) =>
        frozen ? (
          r.unit
        ) : (
          <Select
            size="small"
            style={{ width: '100%' }}
            placeholder="默认带出"
            options={unitOptions}
            value={r.unit}
            onChange={(v) => patchRow(r.key, { unit: v as string })}
          />
        ),
    },
    { title: '暂定数量', width: 110, render: (_, r) => renderNumber(r.qty, (v) => patchRow(r.key, { qty: v }), frozen, 3) },
    { title: '收入单价', width: 110, render: (_, r) => renderNumber(r.incomePrice, (v) => patchRow(r.key, { incomePrice: v }), frozen) },
    { title: '标准成本', width: 110, render: (_, r) => renderNumber(r.stdCost, (v) => patchRow(r.key, { stdCost: v }), frozen) },
    { title: '市场单价', width: 110, render: (_, r) => renderNumber(r.marketPrice, (v) => patchRow(r.key, { marketPrice: v }), frozen) },
    { title: '信息价', width: 110, render: (_, r) => renderNumber(r.infoPrice, (v) => patchRow(r.key, { infoPrice: v }), frozen) },
    {
      title: '预计采购单价',
      width: 120,
      render: (_, r) => {
        const over = r.planPrice != null && r.marketPrice != null && r.planPrice > r.marketPrice;
        return (
          <span style={over ? { color: '#cf1322' } : undefined} title={over ? '控制价超市场单价，重新修改' : undefined}>
            {renderNumber(r.planPrice, (v) => patchRow(r.key, { planPrice: v }), frozen)}
          </span>
        );
      },
    },
    {
      title: '操作',
      width: 70,
      render: (_, r) =>
        frozen ? null : (
          <Button type="link" size="small" danger icon={<DeleteOutlined />} onClick={() => removeRow(r.key)}>
            删除
          </Button>
        ),
    },
  ];

  return (
    <Drawer
      title={task ? `总采购清单 · ${task.taskNo}` : '总采购清单'}
      width={1180}
      open={open}
      onClose={onClose}
      extra={
        !frozen && (
          <Space>
            <Button icon={<PlusOutlined />} onClick={addRow}>
              添加物资
            </Button>
            <Button icon={<SaveOutlined />} loading={saving} onClick={handleSave}>
              保存
            </Button>
            <Button type="primary" icon={<SendOutlined />} loading={publishing} onClick={handlePublish}>
              保存并发布
            </Button>
          </Space>
        )
      }
    >
      <Space direction="vertical" size={12} style={{ width: '100%' }}>
        {frozen ? (
          <Alert
            type="info"
            showIcon
            message={`总采购清单已发布冻结（当前状态：${task ? taskStatusLabel(task.status) : ''}），仅可查看；后续模块可引用其内容自动填写。`}
          />
        ) : (
          <Alert
            type="warning"
            showIcon
            message="物资名称/规格型号只能从物资基础库选择；计量单位默认带出、可改为字典值（提交时同步到基础库）；预计采购单价不得高于市场单价。"
          />
        )}
        <Table<TotalRow>
          rowKey="key"
          size="small"
          loading={loading}
          columns={columns}
          dataSource={rows}
          pagination={false}
          scroll={{ x: 1150 }}
          footer={() =>
            !frozen && (
              <Button type="dashed" block icon={<PlusOutlined />} onClick={addRow}>
                添加物资
              </Button>
            )
          }
        />
        {frozen && rows.length > 0 && (
          <div>
            <Tag color="green">共 {rows.length} 条明细</Tag>
          </div>
        )}
      </Space>
    </Drawer>
  );
}
