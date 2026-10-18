import { useEffect, useState } from 'react';
import { withToken } from '../utils/download';
import {
  Alert,
  Button,
  Card,
  Form,
  Input,
  Select,
  Space,
  Modal,
  message,
  Row,
  Col,
  InputNumber,
  DatePicker,
  Table,
  Tag,
} from 'antd';
import { PlusOutlined, ExportOutlined, RollbackOutlined, ThunderboltOutlined } from '@ant-design/icons';
import dayjs from 'dayjs';
import { settlementApi, dailyApi, contractMaterialApi } from '@/api/modules';
import { dictApi, type DictOption } from '@/api/dict';
import { contractApi } from '@/api/business';
import ModuleListPage, { type ModuleListFilterField, type ModuleListRow } from '@/components/procurement/ModuleListPage';
import ImportButton from '@/components/ImportButton';
import DictSelect, { DictTag } from '@/components/DictSelect';
import EditorTabPage from '@/components/editor/EditorTabPage';
import { useEditorTab, useTabRefresh } from '@/hooks/useTabs';

const money = (v: number) =>
  v == null ? '-' : `¥${Number(v).toLocaleString('zh-CN', { maximumFractionDigits: 2 })}`;

/** 期边界显示：服务端返回的**已经是 `YYYY-MM-DD` 字符串**（不是 Date，避免时区差一天），截前 10 位即可 */
const fmtDay = (v: any) => (v ? String(v).slice(0, 10) : '-');

/** 加载合同下拉选项（结算单/结算台账共用） */
function useContractOptions() {
  const [contracts, setContracts] = useState<any[]>([]);
  useEffect(() => {
    contractApi.list({ pageSize: 1000 }).then((res: any) => setContracts(res?.list || []));
  }, []);
  const contractOptions = contracts.map((c) => ({ value: c.id, label: `${c.code} ${c.name}` }));
  return { contracts, contractOptions };
}

/** 筛选用字典选项（结算单/结算台账共用） */
function useFilterDicts(types: string[]) {
  const [dicts, setDicts] = useState<Record<string, DictOption[]>>({});
  useEffect(() => {
    Promise.all(types.map((t) => dictApi.options(t).catch(() => []))).then((lists) => {
      const map: Record<string, DictOption[]> = {};
      types.forEach((t, i) => (map[t] = lists[i] || []));
      setDicts(map);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return dicts;
}

/** 列表与「新增/编辑」是同一路由的两种形态（`?editor=new|<id>`），见 `useEditorTab` 的注释 */
const ORDER_LIST_PATH = '/settlement/order';
const LEDGER_LIST_PATH = '/settlement/ledger';

/**
 * 结算单页面（问题四：统一标准列表页规约）
 */
export function SettlementOrderPage() {
  const { contractOptions } = useContractOptions();
  const dicts = useFilterDicts(['settlement_type', 'settlement_status']);
  const editorTab = useEditorTab(ORDER_LIST_PATH);
  if (editorTab.isEditor) {
    return <SettlementEditor contractOptions={contractOptions} seed={editorTab.seed} />;
  }
  return <SettlementsTab contractOptions={contractOptions} dicts={dicts} />;
}

/**
 * 结算台账页面（问题四：统一标准列表页规约）
 */
export function SettlementLedgerPage() {
  const { contractOptions } = useContractOptions();
  const dicts = useFilterDicts(['yes_no']);
  const editorTab = useEditorTab(LEDGER_LIST_PATH);
  if (editorTab.isEditor) {
    return <LedgerEditor contractOptions={contractOptions} seed={editorTab.seed} />;
  }
  return <LedgerTab contractOptions={contractOptions} dicts={dicts} />;
}

/** 默认导出兼容旧路由 /settlements：展示结算单页面 */
export default function Settlements() {
  return <SettlementOrderPage />;
}

function SettlementsTab({
  contractOptions,
  dicts,
}: {
  contractOptions: any[];
  dicts: Record<string, DictOption[]>;
}) {
  const editorTab = useEditorTab(ORDER_LIST_PATH);
  const tabRefresh = useTabRefresh(ORDER_LIST_PATH);
  const [listRefresh, setListRefresh] = useState(0);
  /** 上一期（未生成）的抓取情况，用于顶部提示（业务口径 2026-10-16：手动按钮 + 未生成提示） */
  const [pending, setPending] = useState<any>(null);
  const refreshList = () => setListRefresh((k) => k + 1);

  useEffect(() => {
    settlementApi
      .previewGenerate()
      .then((res: any) => setPending(res))
      .catch(() => setPending(null));
  }, [listRefresh]);

  /** 生成本期结算：从上一期总日报带出明细，按合同各生成一张草稿结算单（服务端幂等） */
  const doGenerate = (refDate?: string) => {
    Modal.confirm({
      title: `生成本期结算${pending?.month ? `（${pending.month}）` : ''}`,
      content: pending
        ? `将抓取 ${fmtDay(pending.startDate)} ~ ${fmtDay(pending.endDate)} 内的总日报行（含收领单推送与手工录入），按物资合同各生成一张草稿结算单；结算明细从总日报带出后可修改，已有结算单的合同会自动跳过。`
        : '将从上一期总日报带出结算明细，按物资合同各生成一张草稿结算单。',
      okText: '生成',
      cancelText: '取消',
      onOk: async () => {
        const res: any = await settlementApi.generate(refDate ? { refDate } : undefined);
        message.success(`已生成 ${res?.created ?? 0} 张，跳过 ${res?.skipped ?? 0} 张`);
        // 0 元结算单照常生成（数据没录全时金额算不出来），但必须提醒，否则会被直接提交
        if (res?.zeroAmount) {
          message.warning(`其中 ${res.zeroAmount} 张金额为 0：日报行没有含税单价，请核对后补金额`);
        }
        // 缺物资主数据的日报行无法形成清单项级明细，服务端已跳过并返回明细原因
        if (res?.warnings?.length) {
          Modal.warning({
            title: `有 ${res.skippedRows ?? 0} 条总日报行未带出明细`,
            content: (
              <div>
                {res.warnings.map((w: string, i: number) => (
                  <div key={i}>{w}</div>
                ))}
              </div>
            ),
          });
        }
        refreshList();
      },
    });
  };

  const handleRemove = (row: ModuleListRow) => {
    Modal.confirm({
      title: '确认删除该结算单？',
      okText: '确认删除',
      okType: 'danger',
      onOk: async () => {
        await settlementApi.remove(row.id);
        message.success('已删除');
        refreshList();
      },
    });
  };

  /** 筛选项（问题四：标准筛选区） */
  /** 任务 7：结算驳回 → 回填（纯状态回退到「草稿」） */
  const handleRejectSettlement = (row: any) => {
    Modal.confirm({
      title: '结算驳回回填',
      content: '确认将该结算单驳回回「草稿」状态、可重新编辑提交吗？',
      okText: '确认驳回',
      okButtonProps: { danger: true },
      cancelText: '取消',
      onOk: async () => {
        try {
          await settlementApi.reject(row.id);
          message.success('已驳回回填，结算单回到「草稿」');
          refreshList();
        } catch (e: any) {
          message.error(e?.message || '驳回失败');
        }
      },
    });
  };

  const extraFilters: ModuleListFilterField[] = [
    { key: 'contractId', label: '合同', control: 'select', options: contractOptions },
    { key: 'typeCode', label: '结算类型', control: 'select', options: dicts.settlement_type ?? [] },
    { key: 'status', label: '结算状态', control: 'select', options: dicts.settlement_status ?? [] },
    { key: 'keyword', label: '关键词', control: 'input' },
  ];

  /** 表格列（问题四：generic 模式完整列定义） */
  const extraColumns: any[] = [
    { title: '结算单编号', dataIndex: 'code', width: 160, fixed: 'left' },
    { title: '合同', width: 260, render: (_v: any, r: any) => `${r.contract?.code || ''} ${r.contract?.name || ''}`.trim() || '-' },
    { title: '供应商', width: 220, render: (_v: any, r: any) => r.contract?.supplier?.name || '-' },
    { title: '结算类型', dataIndex: 'typeCode', width: 110, render: (v: any) => <DictTag typeCode="settlement_type" value={v} /> },
    { title: '结算金额', dataIndex: 'amount', width: 140, align: 'right', render: money },
    { title: '扣款金额', dataIndex: 'deductAmount', width: 140, align: 'right', render: money },
    { title: '实际结算金额', dataIndex: 'actualAmount', width: 150, align: 'right', render: money },
    { title: '结算日期', dataIndex: 'settleDate', width: 120, render: (v: any) => v?.slice(0, 10) },
    { title: '结算状态', dataIndex: 'statusCode', width: 110, render: (v: any) => <DictTag typeCode="settlement_status" value={v} /> },
    { title: '备注', dataIndex: 'remark', width: 160, ellipsis: true },
  ];

  return (
    <>
      {/* 未生成提示（业务口径 2026-10-16）：上一期还有合同时，直接在列表上方提醒并给一键入口 */}
      {pending && !pending.empty && pending.pendingContracts > 0 && (
        <Alert
          type="info"
          showIcon
          style={{ marginBottom: 12 }}
          message={`上一期（${pending.month}）还有 ${pending.pendingContracts} 个合同的结算单未生成`}
          description={`结算期 ${fmtDay(pending.startDate)} ~ ${fmtDay(pending.endDate)}，期间有 ${pending.dailyRowCount ?? pending.orderCount} 条尚未纳入结算的总日报行。`}
          action={
            <Button size="small" type="primary" onClick={() => doGenerate()}>
              立即生成
            </Button>
          }
        />
      )}
      <ModuleListPage
        mode="generic"
        columnConfigKey="settlement.list"
        fetcher={(params) => settlementApi.list(params)}
        extraFilters={extraFilters}
        extraColumns={extraColumns}
        refreshKey={listRefresh + tabRefresh}
        onEdit={(row) => editorTab.openEdit(row.id, row)}
        onDelete={handleRemove}
        rowMenuItems={(row: ModuleListRow & { statusCode?: string }) =>
          // 任务 7：仅已提交的结算单可驳回回填（generic 模式下行即结算单记录）
          row.statusCode !== 'DRAFT'
            ? [
                {
                  key: 'reject',
                  label: (
                    <span>
                      <RollbackOutlined /> 驳回回填
                    </span>
                  ),
                  danger: true,
                  onClick: () => handleRejectSettlement(row),
                },
              ]
            : []
        }
        toolbarLeft={
          <Space wrap size={8}>
            <Button type="primary" icon={<PlusOutlined />} onClick={() => editorTab.openCreate()}>
              新增结算单
            </Button>
            {/* 手动生成本期结算：仓库不引入调度器（定时任务需另立决策），故做成按钮 + 顶部未生成提示 */}
            <Button icon={<ThunderboltOutlined />} onClick={() => doGenerate()}>
              生成本期结算
            </Button>
          </Space>
        }
      />

    </>
  );
}

/** 结算单「新增/编辑」（表单正文从改造前的弹窗原样搬入，字段与校验规则未动） */
function SettlementEditor({ contractOptions, seed }: { contractOptions: any[]; seed: unknown }) {
  const [form] = Form.useForm();
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  const editing = seed as any | undefined;
  const watchContractId = Form.useWatch('contractId', form);

  useEffect(() => {
    form.resetFields();
    if (editing) form.setFieldsValue({ ...editing, settleDate: editing.settleDate ? dayjs(editing.settleDate) : null });
    setDirty(false);
    // 仅在换记录时回填（form 实例稳定）
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editing]);

  // ---- 清单项级结算明细（业务 2026-10-17）----
  const [items, setItems] = useState<any[]>(editing?.items ?? []);
  // 合同清单（可结算的物资范围）+ 链上已结算量（量级提示）
  const [contractMaterials, setContractMaterials] = useState<any[]>([]);
  const [settledQty, setSettledQty] = useState<Record<string, number>>({});

  useEffect(() => {
    // 编辑时切合同不清已有明细（换成别的合同时应由用户自查；量级闸门在后端拦）
    if (!watchContractId) {
      setContractMaterials([]);
      setSettledQty({});
      return;
    }
    let alive = true;
    contractMaterialApi.list(watchContractId).then((res: any) => {
      if (alive) setContractMaterials(res?.list || []);
    });
    dailyApi
      .contractSettledQty(watchContractId)
      .then((res: any) => {
        if (!alive) return;
        const map: Record<string, number> = {};
        (res || []).forEach((r: any) => (map[r.materialBaseId] = Number(r.settleQty) || 0));
        setSettledQty(map);
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [watchContractId]);

  const materialOptions = contractMaterials.map((m: any) => ({
    value: m.materialBaseId || m.materialId,
    label: `${m.materialBase?.name || m.materialName || '-'} / ${m.materialBase?.spec || m.specModel || '-'}`,
  }));
  const baselineOf = (mid: string) =>
    Number(contractMaterials.find((m: any) => (m.materialBaseId || m.materialId) === mid)?.qty) || 0;

  const patchItem = (key: React.Key, field: string, value: any) =>
    setItems((prev) => prev.map((r: any) => (r.key === key ? { ...r, [field]: value } : r)));

  /** 明细合价合计（前端实时预览；服务端保存时按行重算） */
  const itemsTotal = items.reduce(
    (s, r) => s + (Number(r.qty) || 0) * (Number(r.priceWithTax) || 0),
    0,
  );

  const submit = async () => {
    const v = await form.validateFields();
    const invalid = items.find((r) => !r.materialBaseId);
    if (invalid) return message.warning('明细行缺少物资，请补全或删除该行');
    const payload = {
      ...v,
      settleDate: v.settleDate ? dayjs(v.settleDate).format('YYYY-MM-DD') : null,
      items: items.map((r, i) => ({
        materialBaseId: r.materialBaseId,
        qty: r.qty,
        priceBeforeTax: r.priceBeforeTax,
        taxRatePct: r.taxRatePct,
        remark: r.remark,
        sortOrder: i + 1,
      })),
    };
    setSaving(true);
    try {
      if (editing) await settlementApi.update(editing.id, payload);
      else await settlementApi.create(payload);
      message.success('保存成功');
    } finally {
      setSaving(false);
    }
  };

  return (
    <EditorTabPage
      listPath={ORDER_LIST_PATH}
      title={editing ? '编辑结算单' : '新增结算单'}
      saving={saving}
      dirty={dirty}
      onSave={submit}
    >
      <Form form={form} layout="vertical" onValuesChange={() => setDirty(true)}>
        <Row gutter={16}>
          <Col xs={24} md={12}>
            <Form.Item name="code" label="结算单编号" rules={[{ required: true }]}><Input /></Form.Item>
          </Col>
          <Col xs={24} md={12}>
            <Form.Item name="contractId" label="合同" rules={[{ required: true }]}>
              <Select showSearch optionFilterProp="label" allowClear placeholder="请选择合同" options={contractOptions} />
            </Form.Item>
          </Col>
          {/* 现场确认缺口提示（口径见 .claude/rules/backend-conventions.md「日报/现场确认」）：结算依据应来自「已确认」的现场记录 */}
          <Col xs={24}>
            <Form.Item noStyle shouldUpdate={(prev, cur) => prev.contractId !== cur.contractId}>
              {({ getFieldValue }: any) => <UnconfirmedHint contractId={getFieldValue('contractId')} />}
            </Form.Item>
          </Col>
          <Col xs={24} md={8}>
            <Form.Item name="typeCode" label="结算类型" rules={[{ required: true }]}><DictSelect typeCode="settlement_type" /></Form.Item>
          </Col>
          <Col xs={24} md={8}>
            <Form.Item name="amount" label="结算金额"><InputNumber style={{ width: '100%' }} min={0} precision={2} /></Form.Item>
          </Col>
          <Col xs={24} md={8}>
            <Form.Item name="deductAmount" label="扣款金额"><InputNumber style={{ width: '100%' }} min={0} precision={2} /></Form.Item>
          </Col>
          <Col xs={24} md={8}>
            <Form.Item name="actualAmount" label="实际结算金额"><InputNumber style={{ width: '100%' }} min={0} precision={2} /></Form.Item>
          </Col>
          <Col xs={24} md={8}>
            <Form.Item name="settleDate" label="结算日期"><DatePicker format="YYYY-MM-DD" style={{ width: '100%' }} /></Form.Item>
          </Col>
          <Col xs={24} md={8}>
            <Form.Item name="statusCode" label="结算状态"><DictSelect typeCode="settlement_status" /></Form.Item>
          </Col>
          <Col xs={24}>
            <Form.Item name="remark" label="备注"><Input.TextArea rows={2} /></Form.Item>
          </Col>
        </Row>
      </Form>

      {/* 清单项级结算明细（业务 2026-10-17）：结算量 ≤ 合同链清单量（后端闸门 settlement.over_amount_policy） */}
      <Card size="small" title={`结算明细（${items.length} 行，合计 ¥${itemsTotal.toLocaleString('zh-CN', { maximumFractionDigits: 2 })}）`}
        extra={
          <Space>
            <Select
              showSearch
              optionFilterProp="label"
              placeholder="选择合同清单物资添加明细"
              style={{ minWidth: 300 }}
              value={null}
              options={materialOptions}
              onSelect={(mid: string) => {
                if (items.some((r) => r.materialBaseId === mid)) {
                  message.warning('该物资已有明细行（每单每物资一行）');
                  return;
                }
                const hit: any = contractMaterials.find((m: any) => (m.materialBaseId || m.materialId) === mid);
                setItems((prev) => [
                  ...prev,
                  {
                    key: `it-${Date.now()}-${prev.length}`,
                    materialBaseId: mid,
                    qty: null,
                    priceBeforeTax: hit?.priceBeforeTax ?? null,
                    taxRatePct: hit?.taxRatePct ?? null,
                    remark: '',
                  },
                ]);
                setDirty(true);
              }}
            />
          </Space>
        }
      >
        {items.length === 0 ? (
          <span style={{ color: 'var(--cms-muted-soft)' }}>
            暂无明细。可选填：留空则结算单只有金额；填写后服务端按行重算价格并做量级校验（自动生成的结算单已带明细）。
          </span>
        ) : (
          <Table
            rowKey="key"
            size="small"
            pagination={false}
            scroll={{ x: 1100 }}
            dataSource={items}
            columns={[
              {
                title: '物资', width: 220, fixed: 'left' as const,
                render: (_: any, r: any) => {
                  const hit: any = contractMaterials.find((m: any) => (m.materialBaseId || m.materialId) === r.materialBaseId);
                  return `${hit?.materialBase?.name || r.materialBase?.name || '-'} / ${hit?.materialBase?.spec || r.materialBase?.spec || '-'}`;
                },
              },
              {
                title: '结算数量', dataIndex: 'qty', width: 130,
                render: (v: any, r: any) => (
                  <InputNumber style={{ width: '100%' }} min={0} precision={4} value={v}
                    onChange={(val) => { patchItem(r.key, 'qty', val); setDirty(true); }} />
                ),
              },
              {
                title: '税前单价', dataIndex: 'priceBeforeTax', width: 130,
                render: (v: any, r: any) => (
                  <InputNumber style={{ width: '100%' }} min={0} precision={4} value={v}
                    onChange={(val) => { patchItem(r.key, 'priceBeforeTax', val); setDirty(true); }} />
                ),
              },
              {
                title: '税率(%)', dataIndex: 'taxRatePct', width: 110,
                render: (v: any, r: any) => (
                  <InputNumber style={{ width: '100%' }} min={0} max={100} precision={2} value={v}
                    onChange={(val) => { patchItem(r.key, 'taxRatePct', val); setDirty(true); }} />
                ),
              },
              {
                title: '合价（自动）', width: 130, align: 'right' as const,
                render: (_: any, r: any) => {
                  const withTax =
                    r.priceBeforeTax != null && r.taxRatePct != null
                      ? Number(r.priceBeforeTax) * (1 + Number(r.taxRatePct) / 100)
                      : null;
                  const total = withTax != null && r.qty != null ? Number(r.qty) * withTax : null;
                  return total == null ? '-' : <b>{total.toLocaleString('zh-CN', { maximumFractionDigits: 2 })}</b>;
                },
              },
              {
                title: '可结余量', width: 150, align: 'right' as const,
                render: (_: any, r: any) => {
                  const base = baselineOf(r.materialBaseId);
                  const used = settledQty[r.materialBaseId] || 0;
                  if (!base) return <Tag>无清单上限</Tag>;
                  const remain = base - used;
                  return (
                    <Tag color={remain - (Number(r.qty) || 0) < 0 ? 'red' : 'green'}>
                      {remain.toLocaleString('zh-CN', { maximumFractionDigits: 4 })}
                    </Tag>
                  );
                },
              },
              {
                title: '备注', dataIndex: 'remark', width: 160,
                render: (v: any, r: any) => (
                  <Input value={v} onChange={(e) => { patchItem(r.key, 'remark', e.target.value); setDirty(true); }} />
                ),
              },
              {
                title: '操作', width: 70,
                render: (_: any, r: any) => (
                  <Button type="link" size="small" danger
                    onClick={() => { setItems((prev) => prev.filter((x) => x.key !== r.key)); setDirty(true); }}>
                    删除
                  </Button>
                ),
              },
            ]}
          />
        )}
      </Card>
    </EditorTabPage>
  );
}

function LedgerTab({
  contractOptions,
  dicts,
}: {
  contractOptions: any[];
  dicts: Record<string, DictOption[]>;
}) {
  const editorTab = useEditorTab(LEDGER_LIST_PATH);
  const tabRefresh = useTabRefresh(LEDGER_LIST_PATH);
  const [refreshing, setRefreshing] = useState(false);
  const [listRefresh, setListRefresh] = useState(0);
  const refreshList = () => setListRefresh((k) => k + 1);

  const doRefresh = async () => {
    setRefreshing(true);
    try {
      const res: any = await settlementApi.refreshLedger();
      message.success(`自动生成完成：新增 ${res?.created ?? 0} 条，更新 ${res?.updated ?? 0} 条`);
      refreshList();
    } finally {
      setRefreshing(false);
    }
  };

  const handleRemove = (row: ModuleListRow) => {
    Modal.confirm({
      title: '确认删除该台账记录？',
      okText: '确认删除',
      okType: 'danger',
      onOk: async () => {
        await settlementApi.removeLedger(row.id);
        message.success('已删除');
        refreshList();
      },
    });
  };

  /** 筛选项（问题四：标准筛选区） */
  const extraFilters: ModuleListFilterField[] = [
    { key: 'contractId', label: '合同', control: 'select', options: contractOptions },
    { key: 'settleMonth', label: '结算月份', control: 'input', placeholder: 'YYYY-MM' },
    { key: 'isOnAccount', label: '是否挂账', control: 'select', options: dicts.yes_no ?? [] },
  ];

  /** 表格列（问题四：generic 模式完整列定义） */
  const extraColumns: any[] = [
    { title: '供应商名称', width: 220, fixed: 'left', render: (_v: any, r: any) => r.contract?.supplier?.name || '-' },
    { title: '合同名称', width: 260, render: (_v: any, r: any) => r.contract?.name || '-' },
    { title: '合同编号', width: 160, render: (_v: any, r: any) => r.contract?.code || '-' },
    { title: '结算月份', dataIndex: 'settleMonth', width: 110 },
    { title: '本月结算额', dataIndex: 'monthSettleAmount', width: 130, align: 'right', render: money },
    { title: '本月开票额', dataIndex: 'monthInvoiceAmount', width: 130, align: 'right', render: money },
    { title: '结算次数', dataIndex: 'settleCount', width: 100 },
    { title: '本年结算额', dataIndex: 'yearSettleAmount', width: 130, align: 'right', render: money },
    { title: '截止当月开累采购额', dataIndex: 'cumPurchaseAmount', width: 160, align: 'right', render: money },
    { title: '开工结算额', dataIndex: 'startSettleAmount', width: 130, align: 'right', render: money },
    { title: '当月实际采购额', dataIndex: 'monthActualPurchase', width: 140, align: 'right', render: money },
    { title: '保理贴息', dataIndex: 'factoringDiscount', width: 120, align: 'right', render: money },
    { title: '逾期利息', dataIndex: 'overdueInterest', width: 120, align: 'right', render: money },
    { title: '本年结算对应收入', dataIndex: 'yearSettleIncome', width: 150, align: 'right', render: money },
    { title: '开累结算对应收入', dataIndex: 'cumSettleIncome', width: 160, align: 'right', render: money },
    { title: '是否挂账', dataIndex: 'isOnAccount', width: 100, render: (v: any) => <DictTag typeCode="yes_no" value={v} /> },
  ];

  return (
    <>
      <ModuleListPage
        mode="generic"
        columnConfigKey="settlement.ledger"
        fetcher={(params) => settlementApi.ledger(params)}
        extraFilters={extraFilters}
        extraColumns={extraColumns}
        refreshKey={listRefresh + tabRefresh}
        onEdit={(row) => editorTab.openEdit(row.id, row)}
        onDelete={handleRemove}
        toolbarLeft={
          <Space wrap size={8}>
            <Button type="primary" ghost loading={refreshing} onClick={doRefresh}>
              自动生成台账
            </Button>
            <ImportButton
              moduleName="结算台账"
              templateUrl={settlementApi.ledgerTemplateUrl()}
              uploadUrl={settlementApi.ledgerImportUrl()}
              onDone={refreshList}
            />
            <Button icon={<ExportOutlined />} onClick={() => window.open(withToken(settlementApi.exportLedgerUrl()))}>
              导出台账
            </Button>
            <Button type="primary" icon={<PlusOutlined />} onClick={() => editorTab.openCreate()}>
              新增台账
            </Button>
          </Space>
        }
      />

    </>
  );
}

/** 结算台账「新增/编辑」（表单正文从改造前的弹窗原样搬入，字段与校验规则未动） */
function LedgerEditor({ contractOptions, seed }: { contractOptions: any[]; seed: unknown }) {
  const [form] = Form.useForm();
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  const editing = seed as any | undefined;

  useEffect(() => {
    form.resetFields();
    if (editing) form.setFieldsValue(editing);
    setDirty(false);
    // 仅在换记录时回填（form 实例稳定）
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editing]);

  const submit = async () => {
    const v = await form.validateFields();
    /**
     * 保理贴息 / 逾期利息是**只读派生列**（业务口径 2026-10-16）：
     * 它们分别来自「资金费用台账」与「逾期利息」，要改去源头改。
     * 表单里虽已 `disabled`，但 antd 仍会把值放进 payload —— 服务端会**明确 400 拒绝**
     * （而不是静默忽略），故这里必须剥掉，否则每次保存台账都会报错。
     */
    const { factoringDiscount: _fd, overdueInterest: _oi, ...payload } = v as any;
    setSaving(true);
    try {
      if (editing) await settlementApi.updateLedger(editing.id, payload);
      else await settlementApi.createLedger(payload);
      message.success('保存成功');
    } finally {
      setSaving(false);
    }
  };

  return (
    <EditorTabPage
      listPath={LEDGER_LIST_PATH}
      title={editing ? '编辑结算台账' : '新增结算台账'}
      saving={saving}
      dirty={dirty}
      onSave={submit}
    >
      <Form form={form} layout="vertical" onValuesChange={() => setDirty(true)}>
        <Row gutter={16}>
          <Col xs={24} md={12}>
            <Form.Item name="contractId" label="合同" rules={[{ required: true }]}>
              <Select showSearch optionFilterProp="label" allowClear placeholder="请选择合同" options={contractOptions} />
            </Form.Item>
          </Col>
          <Col xs={24} md={12}>
            <Form.Item name="settleMonth" label="结算月份(YYYY-MM)" rules={[{ required: true }]}><Input placeholder="如 2026-09" /></Form.Item>
          </Col>
          <Col xs={24} md={8}><Form.Item name="monthSettleAmount" label="本月结算额（自动抓取结算单）"><InputNumber style={{ width: '100%' }} min={0} precision={2} disabled /></Form.Item></Col>
          <Col xs={24} md={8}><Form.Item name="monthInvoiceAmount" label="本月开票额（自动抓取收票登记）"><InputNumber style={{ width: '100%' }} min={0} precision={2} disabled /></Form.Item></Col>
          <Col xs={24} md={8}><Form.Item name="settleCount" label="结算次数（自动统计）"><InputNumber style={{ width: '100%' }} min={0} precision={0} disabled /></Form.Item></Col>
          <Col xs={24} md={8}><Form.Item name="yearSettleAmount" label="本年结算额"><InputNumber style={{ width: '100%' }} min={0} precision={2} /></Form.Item></Col>
          <Col xs={24} md={8}><Form.Item name="cumPurchaseAmount" label="截止当月开累采购额"><InputNumber style={{ width: '100%' }} min={0} precision={2} /></Form.Item></Col>
          <Col xs={24} md={8}><Form.Item name="startSettleAmount" label="开工结算额"><InputNumber style={{ width: '100%' }} min={0} precision={2} /></Form.Item></Col>
          <Col xs={24} md={8}><Form.Item name="monthActualPurchase" label="当月实际采购额"><InputNumber style={{ width: '100%' }} min={0} precision={2} /></Form.Item></Col>
          <Col xs={24} md={8}><Form.Item name="factoringDiscount" label="保理贴息（只读·自动抓取资金费用台账）" tooltip="只读：要改请到「资金费用台账」修改，保存后这里会自动同步"><InputNumber style={{ width: '100%' }} min={0} precision={2} disabled /></Form.Item></Col>
          <Col xs={24} md={8}><Form.Item name="overdueInterest" label="逾期利息（只读·自动抓取逾期利息）" tooltip="只读：要改请到「逾期利息」处修改，保存后这里会自动同步"><InputNumber style={{ width: '100%' }} min={0} precision={2} disabled /></Form.Item></Col>
          <Col xs={24} md={8}><Form.Item name="yearSettleIncome" label="本年结算对应收入"><InputNumber style={{ width: '100%' }} min={0} precision={2} /></Form.Item></Col>
          <Col xs={24} md={8}><Form.Item name="cumSettleIncome" label="开累结算对应收入"><InputNumber style={{ width: '100%' }} min={0} precision={2} /></Form.Item></Col>
          <Col xs={24} md={8}><Form.Item name="isOnAccount" label="是否挂账"><DictSelect typeCode="yes_no" /></Form.Item></Col>
        </Row>
      </Form>
    </EditorTabPage>
  );
}

/**
 * 现场确认缺口提示（口径见 .claude/rules/backend-conventions.md「日报/现场确认」）：选定合同后提示该合同下还有多少条现场记录未确认。
 * 只有「已确认」的现场记录才计入结算口径（系统参数 `settlement.require_confirmed` 控制），
 * 故把口径缺口显性化，避免结算时才发现取数偏少。
 */
function UnconfirmedHint({ contractId }: { contractId?: string }) {
  const [info, setInfo] = useState<any>(null);

  useEffect(() => {
    if (!contractId) {
      setInfo(null);
      return;
    }
    let alive = true;
    dailyApi
      .unconfirmedSummary(contractId)
      .then((res: any) => alive && setInfo(res))
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [contractId]);

  if (!contractId || !info) return null;
  const pending = Number(info.pending || 0);
  const rejected = Number(info.rejected || 0);
  if (!pending && !rejected) return null;
  return (
    <Alert
      type={rejected ? 'warning' : 'info'}
      showIcon
      style={{ marginBottom: 12 }}
      message={`该合同还有 ${pending} 条现场记录待确认${rejected ? `、${rejected} 条已驳回` : ''}`}
      description={
        `未确认结算数量合计 ${Number(info.pendingQty || 0)}` +
        `${rejected ? `，已驳回合计 ${Number(info.rejectedQty || 0)}` : ''}` +
        '。只有「已确认」的现场记录才计入结算口径（可在系统参数 settlement.require_confirmed 调整）'
      }
    />
  );
}
