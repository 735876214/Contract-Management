import { useEffect, useMemo, useState } from 'react';
import { Button, DatePicker, Form, Input, InputNumber, Modal, Select, Space, Table, Tag, message } from 'antd';
import { DownloadOutlined, PlusOutlined, ReloadOutlined } from '@ant-design/icons';
import { costApi } from '@/api/modules';
import ModuleListPage, { type ModuleListFilterField, type ModuleListRow } from '@/components/procurement/ModuleListPage';
import EditorTabPage from '@/components/editor/EditorTabPage';
import { useEditorTab, useTabRefresh } from '@/hooks/useTabs';
import { withToken } from '@/utils/download';

/**
 * 成本管理 · 分包单位领用汇总（**单据化**：一单 = 分包单位 × 结算期）。
 * 列表页列单据；「新增单据」选分包单位+结算期后进编辑器按表样填报。
 * **本期领用/平均单价自动**（收领单明细按结算期聚合，只读）；退库/盘点/设计量开累/损耗率手填；
 * 劳务合同名称为单据级字段。导出 Excel = 盘点表 + 月度汇总 + 节超分析三 sheet（CSCEC 表样）。
 */
const LIST_PATH = '/cost/labor-receiving';

export default function CostLaborReceiving() {
  const editorTab = useEditorTab(LIST_PATH);
  if (editorTab.isEditor && editorTab.editorId && editorTab.editorId !== 'new') {
    return <DocEditor id={editorTab.editorId} />;
  }
  return <DocList />;
}

function DocList() {
  const editorTab = useEditorTab(LIST_PATH);
  const tabRefresh = useTabRefresh(LIST_PATH);
  const [listRefresh, setListRefresh] = useState(0);
  const refreshList = () => setListRefresh((k) => k + 1);

  const handleRemove = (row: ModuleListRow) => {
    Modal.confirm({
      title: '确认删除该领用单据？（明细一并删除）',
      okText: '确认删除',
      okType: 'danger',
      onOk: async () => {
        await costApi.laborReceiving.removeDoc(row.id);
        message.success('已删除');
        refreshList();
      },
    });
  };

  const extraFilters: ModuleListFilterField[] = [
    { key: 'period', label: '结算期', control: 'input', placeholder: '如 2026-10' },
    { key: 'keyword', label: '关键词', control: 'input', placeholder: '单号 / 分包单位 / 合同名' },
  ];

  const extraColumns: any[] = [
    { title: '单据编号', dataIndex: 'docNo', width: 150, fixed: 'left' as const },
    { title: '分包单位', dataIndex: 'subcontractorName', width: 180 },
    { title: '结算期', dataIndex: 'period', width: 100 },
    { title: '劳务合同名称', dataIndex: 'contractName', width: 220, render: (v: any) => v || '-' },
    {
      title: '状态',
      dataIndex: 'status',
      width: 90,
      render: (v: string) => (v === 'COMPLETED' ? <Tag color="green">已完成</Tag> : <Tag>草稿</Tag>),
    },
    { title: '明细行数', dataIndex: 'detailCount', width: 90, align: 'right' as const, className: 'col-secondary' },
    { title: '备注', dataIndex: 'remark', width: 140, ellipsis: true, render: (v: any) => v || '-', className: 'col-secondary' },
  ];

  return (
    <ModuleListPage
      mode="generic"
      columnConfigKey="cost.laborReceivingDocs"
      fetcher={(params) => costApi.laborReceiving.listDocs(params)}
      extraFilters={extraFilters}
      extraColumns={extraColumns}
      refreshKey={listRefresh + tabRefresh}
      emptyText="暂无领用单据"
      onEdit={(row) => editorTab.openEdit(row.id, row)}
      onDelete={handleRemove}
      toolbarLeft={
        <CreateDocButton
          onCreated={(id, seed) => {
            refreshList();
            editorTab.openEdit(id, seed);
          }}
        />
      }
    />
  );
}

/** 新建单据：选分包单位 + 结算期（月份选择器） */
function CreateDocButton({ onCreated }: { onCreated: (id: string, seed: any) => void }) {
  const [open, setOpen] = useState(false);
  const [form] = Form.useForm();
  const [subcontractors, setSubcontractors] = useState<any[]>([]);
  const [existing, setExisting] = useState<Set<string>>(new Set());
  const [saving, setSaving] = useState(false);

  const openDialog = async () => {
    setOpen(true);
    form.resetFields();
    const [opts, docs]: any[] = await Promise.all([
      costApi.laborReceiving.options(),
      costApi.laborReceiving.listDocs({ pageSize: 500 }),
    ]);
    setSubcontractors(opts?.subcontractors || []);
    setExisting(new Set((docs?.list || []).map((d: any) => `${d.laborAuthId}|${d.period}`)));
  };

  const doCreate = async () => {
    const values = await form.validateFields();
    setSaving(true);
    try {
      const period = values.period.format('YYYY-MM');
      const created: any = await costApi.laborReceiving.createDoc({
        laborAuthId: values.laborAuthId,
        period,
        contractName: values.contractName,
      });
      message.success(`已创建单据 ${created.docNo}`);
      setOpen(false);
      onCreated(created.id, created);
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <Button type="primary" icon={<PlusOutlined />} onClick={openDialog}>
        新增单据
      </Button>
      <Modal title="新增领用单据" open={open} onCancel={() => setOpen(false)} onOk={doCreate} confirmLoading={saving} okText="创建">
        <Form form={form} layout="vertical" style={{ marginTop: 8 }}>
          <Form.Item name="laborAuthId" label="分包单位" rules={[{ required: true, message: '请选择分包单位' }]}>
            <Select
              showSearch
              optionFilterProp="label"
              placeholder="请选择分包单位"
              options={subcontractors.map((s) => ({ value: s.id, label: s.subcontractorName }))}
            />
          </Form.Item>
          <Form.Item
            name="period"
            label="结算期"
            rules={[{ required: true, message: '请选择结算期' }]}
            extra="一单 = 分包单位 × 结算期；已有单据的组合不可重复"
          >
            <DatePicker picker="month" style={{ width: '100%' }} placeholder="选择月份" />
          </Form.Item>
          <Form.Item name="contractName" label="劳务合同名称" extra="图2 表头字段，可留空后补">
            <Input placeholder="如 CBD市政项目-雨水、消防、中水工程" />
          </Form.Item>
        </Form>
      </Modal>
    </>
  );
}

interface DetailRow {
  key: string;
  id: string | null;
  version: number;
  materialName: string;
  spec: string;
  unit: string | null;
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

function DocEditor({ id }: { id: string }) {
  const [doc, setDoc] = useState<any>(null);
  const [rows, setRows] = useState<DetailRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  const load = async () => {
    setLoading(true);
    try {
      const res: any = await costApi.laborReceiving.docDetail(id);
      setDoc(res);
      setRows(res.details || []);
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => {
    if (id) load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  const patchRow = (key: string, patch: Partial<DetailRow>) => {
    setRows((prev) => prev.map((r) => (r.key === key ? { ...r, ...patch, _dirty: true } : r)));
  };

  const save = async () => {
    setSaving(true);
    try {
      const res: any = await costApi.laborReceiving.updateDoc(id, {
        contractName: doc?.contractName,
        remark: doc?.remark,
        status: doc?.status,
        version: doc?.version,
        // 整批提交：未 dirty 行原样回传（保持行内值），dirty 行带本地修改
        details: rows.map((r: any) => ({ ...r, key: undefined, _dirty: undefined })),
      });
      setDoc(res);
      setRows(res.details || []);
      message.success('保存成功');
    } finally {
      setSaving(false);
    }
  };

  const markComplete = () => {
    Modal.confirm({
      title: '标记为已完成？',
      content: '完成后单据仍可编辑。',
      onOk: async () => {
        await costApi.laborReceiving.updateDoc(id, { status: 'COMPLETED', version: doc?.version });
        message.success('已标记完成');
        load();
      },
    });
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
        render: (v: number | null, r: DetailRow) => (
          <InputNumber
            size="small"
            style={{ width: '100%' }}
            min={0}
            precision={2}
            value={v}
            title={r.priceOverridden ? '已手改，刷新领用时保留' : '平均单价 = Σ税前总价 ÷ Σ数量（自动）'}
            onChange={(val) => patchRow(r.key, { unitPrice: val ?? undefined, priceOverridden: val != null })}
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
        render: (v: number | null, r: DetailRow) => (
          <InputNumber size="small" style={{ width: '100%' }} min={0} precision={3} value={v} onChange={(val) => patchRow(r.key, { returnQty: val ?? undefined })} />
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
        render: (v: number | null, r: DetailRow) => (
          <InputNumber size="small" style={{ width: '100%' }} min={0} precision={3} value={v} onChange={(val) => patchRow(r.key, { stockTakeQty: val ?? undefined })} />
        ),
      },
      {
        title: '设计量·开累',
        dataIndex: 'designQtyCum',
        width: 120,
        render: (v: number | null, r: DetailRow) => (
          <InputNumber size="small" style={{ width: '100%' }} min={0} precision={3} value={v} onChange={(val) => patchRow(r.key, { designQtyCum: val ?? undefined })} />
        ),
      },
      {
        title: '损耗率%',
        dataIndex: 'lossRate',
        width: 110,
        className: 'col-secondary',
        render: (v: number | null, r: DetailRow) => (
          <InputNumber size="small" style={{ width: '100%' }} min={0} max={100} precision={2} value={v} onChange={(val) => patchRow(r.key, { lossRate: val ?? undefined })} />
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
        render: (v: string, r: DetailRow) => (
          <Input size="small" value={v} onChange={(e) => patchRow(r.key, { remark: e.target.value })} />
        ),
      },
    ],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [rows],
  );

  return (
    <EditorTabPage
      listPath={LIST_PATH}
      title={doc ? `领用单据 ${doc.docNo}` : '领用单据'}
      titleExtra={doc?.status === 'COMPLETED' ? <Tag color="green">已完成</Tag> : <Tag>草稿</Tag>}
      saving={saving}
      dirty={rows.some((r: any) => r._dirty) || !!doc?._headDirty}
      closeOnSave={false}
      onSave={save}
      footerExtra={
        <Space wrap>
          {doc?.status !== 'COMPLETED' && (
            <Button onClick={markComplete} disabled={!doc}>
              标记完成
            </Button>
          )}
          <Button icon={<ReloadOutlined />} onClick={load} disabled={!doc}>
            从收领单刷新
          </Button>
          <Button
            icon={<DownloadOutlined />}
            disabled={!doc}
            onClick={() => window.open(withToken(costApi.laborReceiving.docExportUrl(id)))}
          >
            导出 Excel（盘点/汇总/节超）
          </Button>
        </Space>
      }
    >
      {doc && (
        <Space wrap style={{ marginBottom: 12 }}>
          <span>
            分包单位：<b>{doc.subcontractorName}</b>
          </span>
          <span>
            结算期：<b>{doc.period}</b>
          </span>
          <label>
            劳务合同名称：
            <Input
              style={{ width: 280 }}
              placeholder="如 CBD市政项目-雨水、消防、中水工程"
              value={doc.contractName}
              onChange={(e) => setDoc({ ...doc, contractName: e.target.value, _headDirty: true })}
            />
          </label>
        </Space>
      )}
      <Table
        rowKey="key"
        size="small"
        loading={loading}
        columns={columns}
        dataSource={rows}
        pagination={false}
        scroll={{ x: 1800 }}
        locale={{ emptyText: '当期暂无领用数据——收领单（领用单位=该分包单位）保存后点「从收领单刷新」带出' }}
      />
    </EditorTabPage>
  );
}
