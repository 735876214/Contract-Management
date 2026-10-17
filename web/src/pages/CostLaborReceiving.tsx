import { useEffect, useMemo, useState } from 'react';
import { Button, Input, InputNumber, Select, Space, Table, message } from 'antd';
import { DownloadOutlined, ReloadOutlined, SaveOutlined } from '@ant-design/icons';
import { costApi } from '@/api/modules';
import EditorTabPage from '@/components/editor/EditorTabPage';
import { useEditorTab, useTabRefresh } from '@/hooks/useTabs';
import { withToken } from '@/utils/download';

/**
 * 成本管理 · 劳务队领用月度汇总（附件需求 2026-10-17 第二批）。
 * 填报界面参考用户样表（图四）：顶部选 分包商 + 结算期，正文可编辑表格。
 * **本期领用/平均单价自动**（收领单明细按结算期聚合，只读）；退库/盘点/设计量开累/损耗率手填；
 * 派生列（净领/实耗/节超/扣款）服务端算，这里只展示。导出 Excel = 盘点表 + 月度汇总 + 节超分析三 sheet。
 */
const LIST_PATH = '/cost/labor-receiving';

interface SummaryRow {
  key: string;
  materialName: string;
  spec: string;
  unit: string | null;
  summaryId: string | null;
  version: number;
  receivedQty: number | null;
  unitPrice: number | null;
  priceOverridden: boolean;
  designQtyCum: number | null;
  lossRate: number | null;
  returnQty: number | null;
  stockTakeQty: number | null;
  remark: string;
  prevCum: number;
  netQty: number | null;
  usedCum: number | null;
  actualUse: number | null;
  deductPrice: number | null;
  designSubtotal: number | null;
  saveOver: number | null;
  deductAmount: number | null;
  actualLossRate: number | null;
  /** 本地编辑标记（未保存；不上送） */
  _dirty?: boolean;
}

export default function CostLaborReceiving() {
  const editorTab = useEditorTab(LIST_PATH);
  // 单页应用：列表即填报页（按分包商+账期组合取数），无独立编辑器形态
  return <ReceivingEditor editorTab={editorTab} />;
}

function ReceivingEditor({ editorTab }: { editorTab: ReturnType<typeof useEditorTab> }) {
  const tabRefresh = useTabRefresh(LIST_PATH);
  const [subcontractors, setSubcontractors] = useState<any[]>([]);
  const [periods, setPeriods] = useState<string[]>([]);
  const [subcontractorId, setSubcontractorId] = useState<string>('');
  const [period, setPeriod] = useState<string>('');
  const [rows, setRows] = useState<SummaryRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    costApi.laborReceiving.options().then((res: any) => {
      setSubcontractors(res?.subcontractors || []);
      setPeriods(res?.periods || []);
    });
  }, [tabRefresh]);

  const load = async (scId = subcontractorId, p = period) => {
    if (!scId || !p) return;
    setLoading(true);
    try {
      const res: any = await costApi.laborReceiving.summary(scId, p);
      setRows(res?.list || []);
    } finally {
      setLoading(false);
    }
  };

  const dirtyRows = useMemo(() => rows.filter((r: any) => r._dirty), [rows]);

  const patchRow = (key: string, patch: Partial<SummaryRow>) => {
    setRows((prev) => prev.map((r) => (r.key === key ? { ...r, ...patch } : r)));
  };

  const saveAll = async () => {
    if (!subcontractorId) return;
    const editable = rows.filter((r) => r.summaryId == null || r._dirty);
    if (editable.length === 0) {
      message.info('没有需要保存的修改');
      return;
    }
    setSaving(true);
    try {
      await costApi.laborReceiving.saveBatch(
        editable.map((r) => ({
          laborAuthId: subcontractorId,
          subcontractorName: (subcontractors.find((s) => s.id === subcontractorId) || {}).subcontractorName,
          period,
          materialName: r.materialName,
          spec: r.spec || null,
          unit: r.unit,
          unitPrice: r.unitPrice,
          designQtyCum: r.designQtyCum,
          lossRate: r.lossRate,
          returnQty: r.returnQty,
          stockTakeQty: r.stockTakeQty,
          remark: r.remark,
          version: r.summaryId ? r.version : undefined,
        })),
      );
      message.success('保存成功');
      await load();
    } finally {
      setSaving(false);
    }
  };

  const columns = useMemo(
    () => [
      { title: '序号', width: 55, render: (_: any, __: any, i: number) => i + 1 },
      { title: '物资名称', dataIndex: 'materialName', width: 150 },
      { title: '规格型号', dataIndex: 'spec', width: 140, render: (v: string) => v || '-' },
      { title: '单位', dataIndex: 'unit', width: 70, render: (v: string) => v || '-' },
      {
        title: '单价(元)',
        dataIndex: 'unitPrice',
        width: 120,
        render: (v: number | null, r: SummaryRow) => (
          <InputNumber
            size="small"
            style={{ width: '100%' }}
            min={0}
            precision={4}
            value={v}
            title={r.priceOverridden ? '已手改，刷新领用时保留' : '平均单价 = Σ税前总价 ÷ Σ数量（自动）'}
            onChange={(val) => patchRow(r.key, { unitPrice: val ?? undefined, priceOverridden: true } as any)}
          />
        ),
      },
      {
        title: '上期末累计',
        dataIndex: 'prevCum',
        width: 100,
        align: 'right' as const,
        className: 'col-secondary',
        render: (v: number) => v.toLocaleString('zh-CN'),
      },
      {
        title: '本期领用',
        dataIndex: 'receivedQty',
        width: 100,
        align: 'right' as const,
        render: (v: number | null) => (v == null ? '-' : v.toLocaleString('zh-CN')),
      },
      {
        title: '退库数量',
        dataIndex: 'returnQty',
        width: 120,
        render: (v: number | null, r: SummaryRow) => (
          <InputNumber
            size="small"
            style={{ width: '100%' }}
            min={0}
            precision={3}
            value={v}
            onChange={(val) => patchRow(r.key, { returnQty: val ?? undefined, _dirty: true } as any)}
          />
        ),
      },
      {
        title: '净领',
        dataIndex: 'netQty',
        width: 90,
        align: 'right' as const,
        render: (v: number | null) => (v == null ? '-' : v.toLocaleString('zh-CN')),
      },
      {
        title: '库存盘点',
        dataIndex: 'stockTakeQty',
        width: 120,
        render: (v: number | null, r: SummaryRow) => (
          <InputNumber
            size="small"
            style={{ width: '100%' }}
            min={0}
            precision={3}
            value={v}
            onChange={(val) => patchRow(r.key, { stockTakeQty: val ?? undefined, _dirty: true } as any)}
          />
        ),
      },
      {
        title: '设计量·开累',
        dataIndex: 'designQtyCum',
        width: 120,
        render: (v: number | null, r: SummaryRow) => (
          <InputNumber
            size="small"
            style={{ width: '100%' }}
            min={0}
            precision={3}
            value={v}
            onChange={(val) => patchRow(r.key, { designQtyCum: val ?? undefined, _dirty: true } as any)}
          />
        ),
      },
      {
        title: '损耗率%',
        dataIndex: 'lossRate',
        width: 110,
        className: 'col-secondary',
        render: (v: number | null, r: SummaryRow) => (
          <InputNumber
            size="small"
            style={{ width: '100%' }}
            min={0}
            max={100}
            precision={2}
            value={v}
            onChange={(val) => patchRow(r.key, { lossRate: val ?? undefined, _dirty: true } as any)}
          />
        ),
      },
      {
        title: '实耗',
        dataIndex: 'actualUse',
        width: 90,
        align: 'right' as const,
        className: 'col-secondary',
        render: (v: number | null) => (v == null ? '-' : v.toLocaleString('zh-CN')),
      },
      {
        title: '节(-)超(+)',
        dataIndex: 'saveOver',
        width: 100,
        align: 'right' as const,
        render: (v: number | null) => (v == null ? '-' : v.toLocaleString('zh-CN')),
      },
      {
        title: '结算扣款(元)',
        dataIndex: 'deductAmount',
        width: 120,
        align: 'right' as const,
        render: (v: number | null) => (v == null ? '-' : v.toLocaleString('zh-CN', { minimumFractionDigits: 2 })),
      },
      {
        title: '备注',
        dataIndex: 'remark',
        width: 140,
        render: (v: string, r: SummaryRow) => (
          <Input
            size="small"
            value={v}
            onChange={(e) => patchRow(r.key, { remark: e.target.value, _dirty: true } as any)}
          />
        ),
      },
    ],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [rows],
  );

  return (
    <EditorTabPage
      listPath={LIST_PATH}
      title="劳务队领用月度汇总"
      saving={saving}
      dirty={rows.some((r: any) => r._dirty)}
      closeOnSave={false}
      onSave={saveAll}
      footerExtra={
        <Space wrap>
          <Button icon={<ReloadOutlined />} onClick={() => load()} disabled={!subcontractorId || !period}>
            从收领单刷新
          </Button>
          <Button
            icon={<DownloadOutlined />}
            disabled={!subcontractorId || !period}
            onClick={() =>
              window.open(withToken(costApi.laborReceiving.exportUrl(subcontractorId, period)))
            }
          >
            导出 Excel（盘点/汇总/节超）
          </Button>
        </Space>
      }
    >
      <Space wrap style={{ marginBottom: 12 }}>
        <Select
          showSearch
          optionFilterProp="label"
          style={{ minWidth: 240 }}
          placeholder="选择分包商（劳务队）"
          value={subcontractorId || undefined}
          options={subcontractors.map((s) => ({ value: s.id, label: s.subcontractorName }))}
          onChange={(v: string) => {
            setSubcontractorId(v);
            setRows([]);
            if (period) load(v, period);
          }}
        />
        <Select
          showSearch
          style={{ minWidth: 160 }}
          placeholder="选择结算期（YYYY-MM）"
          value={period || undefined}
          options={periods.map((p) => ({ value: p, label: p }))}
          onChange={(v: string) => {
            setPeriod(v);
            setRows([]);
            if (subcontractorId) load(subcontractorId, v);
          }}
        />
      </Space>
      <Table
        rowKey="key"
        size="small"
        loading={loading}
        columns={columns}
        dataSource={rows}
        pagination={false}
        scroll={{ x: 1600 }}
        locale={{ emptyText: subcontractorId && period ? '该结算期暂无领用记录' : '请先选择分包商与结算期' }}
      />
    </EditorTabPage>
  );
}
