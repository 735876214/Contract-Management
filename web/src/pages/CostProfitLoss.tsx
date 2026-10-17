import { useEffect, useMemo, useState } from 'react';
import { Button, Input, InputNumber, Modal, Select, Space, Table, message } from 'antd';
import { DownloadOutlined, PlusOutlined, ReloadOutlined } from '@ant-design/icons';
import { costApi } from '@/api/modules';
import ModuleListPage, { type ModuleListFilterField, type ModuleListRow } from '@/components/procurement/ModuleListPage';
import EditorTabPage from '@/components/editor/EditorTabPage';
import { useEditorTab, useTabRefresh } from '@/hooks/useTabs';
import { withToken } from '@/utils/download';

/**
 * 成本管理 · 月度盈亏分析（附件需求 2026-10-17 第三批；替换原手工台账）。
 * **一个月一条记录**：新建时选结算期 → 服务端把当期各分包单位「甲供材节超分析」行快照成明细；
 * 责任人/劳务计价已扣/备注及数量列可手改；「重新抓取」重算快照（手填项按 分包单位+材料+规格 回填）。
 * 导出 xlsx 三 sheet：封面 / 明细表 / 汇总表（按材料跨队加权汇总）。
 */
const LIST_PATH = '/cost/profit-loss';

const money = (v: any) => (v == null ? '-' : Number(v).toLocaleString('zh-CN', { minimumFractionDigits: 2 }));
const qty = (v: any) => (v == null ? '-' : Number(v).toLocaleString('zh-CN', { maximumFractionDigits: 3 }));

export default function CostProfitLoss() {
  const editorTab = useEditorTab(LIST_PATH);
  if (editorTab.isEditor && editorTab.editorId && editorTab.editorId !== 'new') {
    return <ProfitEditor id={editorTab.editorId} />;
  }
  return <ProfitList />;
}

function ProfitList() {
  const editorTab = useEditorTab(LIST_PATH);
  const tabRefresh = useTabRefresh(LIST_PATH);
  const [listRefresh, setListRefresh] = useState(0);
  const [creating, setCreating] = useState(false);
  const refreshList = () => setListRefresh((k) => k + 1);

  const handleRemove = (row: ModuleListRow) => {
    Modal.confirm({
      title: `确认删除该盈亏分析记录？（明细一并删除）`,
      okText: '确认删除',
      okType: 'danger',
      onOk: async () => {
        await costApi.monthlyProfitLoss.remove(row.id);
        message.success('已删除');
        refreshList();
      },
    });
  };

  const extraFilters: ModuleListFilterField[] = [
    { key: 'period', label: '结算期', control: 'input', placeholder: '如 2026-10' },
  ];

  const extraColumns: any[] = [
    { title: '结算期', dataIndex: 'period', width: 110, fixed: 'left' as const },
    { title: '明细行数', dataIndex: 'detailCount', width: 90, align: 'right' as const },
    {
      title: '六项降本创效金额',
      dataIndex: 'sixSavingsAmount',
      width: 140,
      align: 'right' as const,
      className: 'col-secondary',
      render: (v: any) => (v == null ? '-' : money(v)),
    },
    {
      title: '劳务计价累计扣款',
      dataIndex: 'totalDeductAmount',
      width: 140,
      align: 'right' as const,
      className: 'col-secondary',
      render: (v: any) => (v == null ? '-' : money(v)),
    },
    { title: '备注', dataIndex: 'remark', width: 160, ellipsis: true, render: (v: any) => v || '-' },
  ];

  return (
    <ModuleListPage
      mode="generic"
      columnConfigKey="cost.monthlyProfitLoss"
      fetcher={(params) => costApi.monthlyProfitLoss.list(params)}
      extraFilters={extraFilters}
      extraColumns={extraColumns}
      refreshKey={listRefresh + tabRefresh}
      emptyText="暂无月度盈亏分析记录"
      onEdit={(row) => editorTab.openEdit(row.id, row)}
      onDelete={handleRemove}
      toolbarLeft={
        <CreateButton
          creating={creating}
          setCreating={setCreating}
          onCreated={(id, seed) => {
            refreshList();
            editorTab.openEdit(id, seed);
          }}
        />
      }
    />
  );
}

/** 新建：选结算期（只列尚无记录的期），确定即创建并生成快照 */
function CreateButton({
  creating,
  setCreating,
  onCreated,
}: {
  creating: boolean;
  setCreating: (v: boolean) => void;
  onCreated: (id: string, seed: any) => void;
}) {
  const [open, setOpen] = useState(false);
  const [periods, setPeriods] = useState<string[]>([]);
  const [period, setPeriod] = useState<string>();
  const [saving, setSaving] = useState(false);

  const openDialog = async () => {
    setOpen(true);
    setPeriod(undefined);
    const [opts, list]: any[] = await Promise.all([
      costApi.laborReceiving.options(),
      costApi.monthlyProfitLoss.list({ pageSize: 500 }),
    ]);
    const existing = new Set((list?.list || []).map((r: any) => r.period));
    setPeriods((opts?.periods || []).filter((p: string) => !existing.has(p)));
  };

  const doCreate = async () => {
    if (!period) return;
    setSaving(true);
    try {
      const created: any = await costApi.monthlyProfitLoss.create({ period });
      message.success('已生成当期快照');
      setOpen(false);
      onCreated(created.id, created);
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <Button type="primary" icon={<PlusOutlined />} loading={creating} onClick={openDialog}>
        新增月度分析
      </Button>
      <Modal
        title="新增月度盈亏分析"
        open={open}
        onCancel={() => setOpen(false)}
        onOk={doCreate}
        okButtonProps={{ disabled: !period, loading: saving }}
        okText="生成快照"
      >
        <Space direction="vertical" style={{ width: '100%', marginTop: 8 }}>
          <Select
            showSearch
            style={{ width: '100%' }}
            placeholder="选择结算期（来自分包单位领用汇总已有期间）"
            value={period}
            options={periods.map((p) => ({ value: p, label: p }))}
            onChange={setPeriod}
          />
          {periods.length === 0 && (
            <span>没有可用的结算期——请先在「分包单位领用汇总」里选择分包单位与账期生成数据。</span>
          )}
        </Space>
      </Modal>
    </>
  );
}

function ProfitEditor({ id }: { id: string }) {
  const [rec, setRec] = useState<any>(null);
  const [details, setDetails] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);

  const load = async () => {
    setLoading(true);
    try {
      const res: any = await costApi.monthlyProfitLoss.detail(id);
      setRec(res);
      setDetails(res.details || []);
      setDirty(false);
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => {
    if (id) load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  const patchDetail = (did: string, patch: any) => {
    setDetails((prev) => prev.map((d) => (d.id === did ? { ...d, ...patch, _dirty: true } : d)));
    setDirty(true);
  };

  const save = async () => {
    setSaving(true);
    try {
      const changed = details.filter((d: any) => d._dirty);
      const res: any = await costApi.monthlyProfitLoss.update(id, {
        sixSavingsAmount: rec?.sixSavingsAmount,
        totalDeductAmount: rec?.totalDeductAmount,
        remark: rec?.remark,
        version: rec?.version,
        details: changed.map((d: any) => ({ ...d, _dirty: undefined })),
      });
      setRec(res);
      setDetails(res.details || []);
      setDirty(false);
      message.success('保存成功');
    } finally {
      setSaving(false);
    }
  };

  const doReSnapshot = () => {
    Modal.confirm({
      title: '重新抓取当期快照？',
      content: '手填项（责任人/劳务计价已扣/备注）按 分包单位+材料+规格 自动回填，快照列以当期最新数据重算。',
      onOk: async () => {
        const res: any = await costApi.monthlyProfitLoss.reSnapshot(id);
        setRec(res);
        setDetails(res.details || []);
        setDirty(false);
        message.success('已重新抓取');
      },
    });
  };

  const columns = useMemo(
    () => [
      { title: '序号', width: 55, render: (_: any, __: any, i: number) => i + 1 },
      { title: '材料名称', dataIndex: 'materialName', width: 130, fixed: 'left' as const },
      { title: '规格型号', dataIndex: 'spec', width: 130, render: (v: string) => v || '-' },
      { title: '单位', dataIndex: 'unit', width: 65, render: (v: string) => v || '-' },
      {
        title: '单价',
        dataIndex: 'unitPrice',
        width: 110,
        render: (v: number | null, d: any) => (
          <InputNumber size="small" style={{ width: '100%' }} min={0} precision={2} value={v} onChange={(val) => patchDetail(d.id, { unitPrice: val })} />
        ),
      },
      {
        title: '进场量',
        dataIndex: 'entryQty',
        width: 100,
        align: 'right' as const,
        render: qty,
      },
      { title: '进场金额', dataIndex: 'entryAmount', width: 110, align: 'right' as const, className: 'col-secondary', render: (v: any, d: any) => money(d.entryQty != null && d.unitPrice != null ? d.entryQty * d.unitPrice : null) },
      {
        title: '设计量',
        dataIndex: 'designQty',
        width: 100,
        align: 'right' as const,
        render: qty,
      },
      {
        title: '损耗率%',
        dataIndex: 'lossRate',
        width: 95,
        align: 'right' as const,
        className: 'col-secondary',
      },
      { title: '理论消耗量', dataIndex: 'theoryUseQty', width: 110, align: 'right' as const, render: qty },
      {
        title: '实际消耗量',
        dataIndex: 'actualUseQty',
        width: 110,
        align: 'right' as const,
        render: qty,
      },
      {
        title: '库存量',
        dataIndex: 'stockQty',
        width: 100,
        align: 'right' as const,
        render: qty,
      },
      {
        title: '盈(+)/亏(-)',
        dataIndex: 'saveOverQty',
        width: 110,
        align: 'right' as const,
        render: (v: number | null) => (v == null ? '-' : v.toFixed(3)),
      },
      { title: '盈亏金额', dataIndex: 'saveOverAmount', width: 110, align: 'right' as const, render: money },
      {
        title: '节超率',
        dataIndex: 'saveRate',
        width: 90,
        align: 'right' as const,
        className: 'col-secondary',
        render: (v: any) => (v == null ? '-' : `${(Number(v) * 100).toFixed(2)}%`),
      },
      { title: '劳务队名称', dataIndex: 'laborTeamName', width: 150 },
      {
        title: '责任人',
        dataIndex: 'owner',
        width: 110,
        render: (v: string, d: any) => (
          <Input size="small" value={v} onChange={(e) => patchDetail(d.id, { owner: e.target.value })} />
        ),
      },
      {
        title: '劳务计价已扣',
        dataIndex: 'deductAmount',
        width: 120,
        render: (v: number | null, d: any) => (
          <InputNumber size="small" style={{ width: '100%' }} value={v} onChange={(val) => patchDetail(d.id, { deductAmount: val })} />
        ),
      },
      {
        title: '备注',
        dataIndex: 'remark',
        width: 150,
        render: (v: string, d: any) => (
          <Input size="small" value={v} onChange={(e) => patchDetail(d.id, { remark: e.target.value })} />
        ),
      },
    ],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [details],
  );

  return (
    <EditorTabPage
      listPath={LIST_PATH}
      title={rec ? `月度盈亏分析 · ${rec.period}` : '月度盈亏分析'}
      saving={saving}
      dirty={dirty}
      closeOnSave={false}
      onSave={save}
      footerExtra={
        <Space wrap>
          <Button icon={<ReloadOutlined />} onClick={doReSnapshot} disabled={!rec}>
            重新抓取
          </Button>
          <Button
            icon={<DownloadOutlined />}
            disabled={!rec}
            onClick={() => window.open(withToken(costApi.monthlyProfitLoss.exportUrl(id)))}
          >
            导出 Excel（封面/明细/汇总）
          </Button>
        </Space>
      }
    >
      {rec && (
        <Space wrap style={{ marginBottom: 12 }}>
          <label>
            六项降本创效金额：
            <InputNumber
              style={{ width: 160 }}
              value={rec.sixSavingsAmount}
              onChange={(v) => {
                setRec({ ...rec, sixSavingsAmount: v });
                setDirty(true);
              }}
            />
          </label>
          <label>
            劳务计价累计扣款金额：
            <InputNumber
              style={{ width: 160 }}
              value={rec.totalDeductAmount}
              onChange={(v) => {
                setRec({ ...rec, totalDeductAmount: v });
                setDirty(true);
              }}
            />
          </label>
          <Input
            style={{ width: 240 }}
            placeholder="备注"
            value={rec.remark}
            onChange={(e) => {
              setRec({ ...rec, remark: e.target.value });
              setDirty(true);
            }}
          />
        </Space>
      )}
      <Table
        rowKey="id"
        size="small"
        loading={loading}
        columns={columns}
        dataSource={details}
        pagination={false}
        scroll={{ x: 2200 }}
        locale={{ emptyText: '当期没有节超数据（先在「分包单位领用汇总」填好当期数据，或点「重新抓取」）' }}
      />
    </EditorTabPage>
  );
}
