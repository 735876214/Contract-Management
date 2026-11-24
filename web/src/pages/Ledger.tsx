import { useCallback, useEffect, useMemo, useState } from 'react';
import { formatMoney } from '@/utils/money';
import { withToken } from '../utils/download';
import { Button, Card, Checkbox, Col, Modal, Row, Space, Statistic } from 'antd';
import { message, modal } from '@/utils/antdStatic';
import { ExportOutlined, PlusOutlined, SettingOutlined } from '@ant-design/icons';
import { ledgerApi } from '@/api/modules';
import type { LedgerColumn, LedgerListParams, LedgerRow, LedgerSummary } from '@/api/types/ledger';
import { contractApi, supplierApi } from '@/api/business';
import DictSelect from '@/components/DictSelect';
import ImportButton from '@/components/ImportButton';
import ContractEditor from '@/components/contract/ContractEditor';
import ContractDetailModal from '@/components/contract/ContractDetailModal';
import Can from '@/components/Can';
import ModuleListPage, { type ModuleListFilterField, type ModuleListRow } from '@/components/procurement/ModuleListPage';
import { useContainerWidth } from '@/hooks/useContainerWidth';
import { useEditorTab, useTabRefresh } from '@/hooks/useTabs';
import { LIST_PATHS } from '@/constants/listPaths';
import { useDictStore } from '@/store/dict';

const money = (v: unknown) => formatMoney(v);

const COMPLIANCE_OPTIONS = [
  '无问题',
  '未招标进场',
  '未定标进场',
  '未签合同进场',
  '未签合同先进场',
  '时间数据不完整',
];

const renderYearMap = (v: LedgerRow['yearSettle'] | null | undefined) => {
  if (!v || typeof v !== 'object') return '-';
  return Object.entries(v)
    .map(([y, a]) => `${y}: ${money(a)}`)
    .join('  ');
};

const renderCompliance = (v: LedgerRow['compliance'] | undefined) => {
  if (!v || v === '无问题') return <span style={{ color: 'var(--cms-success)' }}>无问题</span>;
  if (v === '时间数据不完整') return <span style={{ color: 'var(--cms-warning)' }}>时间数据不完整</span>;
  return <span style={{ color: 'var(--cms-error)' }}>{v}</span>;
};

/** 小数比例列（如付款比例 0.65）：页面乘 100 显示为 65.00%，与导出 `0.00%` 格式一致 */
const pct = (v: LedgerRow['currentPayRatio']) => (v == null ? '-' : `${(Number(v) * 100).toFixed(2)}%`);
/** 百分数口径列（税率 13 = 13%）：单轨后直接拼 %，不再乘 100 */
const pctVal = (v: LedgerRow['taxRatePct']) => (v == null ? '-' : `${Number(v).toFixed(2)}%`);

const renderCell = (key: string, v: unknown) => {
  if (key === 'taxRate' || key === 'taxRatePct') return pctVal(v as LedgerRow['taxRatePct']);
  if (key === 'currentPayRatio') return pct(v as LedgerRow['currentPayRatio']);
  if (/amount$/i.test(key) || /debt/i.test(key) || key === 'amount') return money(v);
  if (key === 'yearSettle' || key === 'yearPaid') return renderYearMap(v as LedgerRow['yearSettle'] | null | undefined);
  if (key === 'compliance') return renderCompliance(v as LedgerRow['compliance'] | undefined);
  return v == null || v === '' ? '-' : (v as string);
};

/**
 * 合同台账（问题四：统一标准列表页规约）
 * - 顶部统计卡片 + 标准筛选区/工具栏/表格/分页
 * - 动态列由服务端返回（含列可见性配置），「列设置」保存后刷新
 * - **同时承载合同主数据维护**（业务 2026-11-14 合并「合同台账 + 合同台账维护」）：
 *   行操作「查看/编辑/删除」、工具栏「新建/导入」，编辑器走同一路径的 `?editor=new|<id>`。
 *   签章/驳回/归档等**工作流动作仍只在「合同查询」**，不在本页。
 *   台账仍包含草稿合同（`/ledger/contracts` 的 where 只有 projectId），与合并前口径一致。
 */
export default function Ledger() {
  const editorTab = useEditorTab(LIST_PATHS.contractLedger);
  if (editorTab.isEditor) {
    return <ContractEditor seed={editorTab.seed} />;
  }
  return <LedgerList />;
}

function LedgerList() {
  const ensure = useDictStore((s) => s.ensure);
  const editorTab = useEditorTab(LIST_PATHS.contractLedger);
  const [detailId, setDetailId] = useState<string | null>(null);
  /** 发票作废/红冲等跨标签动作会 bump 本路径，缓存页必须重新取数（含顶部统计） */
  const tabRefresh = useTabRefresh(LIST_PATHS.contractLedger);
  const [suppliers, setSuppliers] = useState<Array<{ id: string; name: string }>>([]);
  const [columns, setColumns] = useState<LedgerColumn[]>([]);
  const [summary, setSummary] = useState<LedgerSummary | null>(null);
  const [colModal, setColModal] = useState(false);
  const [colChecked, setColChecked] = useState<string[]>([]);
  const [listRefresh, setListRefresh] = useState(0);

  /** 标准列表数据源：台账接口返回 { list, total, columns }，columns 用于动态列渲染 */
  const fetcher = useMemo(
    () => async (params: LedgerListParams) => {
      const res = await ledgerApi.contracts(params);
      // 列表接口顺带把**动态列定义**带回来（列宽已是像素），故取数时同步一次列设置
      if (res?.columns) setColumns(res.columns);
      return res;
    },
    [],
  );

  /** 顶部统计卡（不走列表接口，增删改后需单独重取） */
  const loadSummary = useCallback(() => {
    ledgerApi.summary().then((res) => setSummary(res)).catch(() => setSummary(null));
  }, []);

  useEffect(() => {
    ensure(['contract_type', 'contract_execution_status', 'supplier_category']);
    supplierApi.options().then((res: Array<{ id: string; name: string }>) => setSuppliers(res || []));
    loadSummary();
  }, [tabRefresh, loadSummary, ensure]);

  /**
   * 大宽表冻结列（DESIGN.md §10.2）：**张数随容器宽度收敛**——
   * 宽容器冻结「序号 + 合同编号」（横向滚动时保持可见）；窄容器只冻结**合同编号**：
   * 序号是装饰性的，窄容器里留着它只会白占可视区，而合同编号才是识别行的那一列。
   * 行高不在这里管：它由 `ModuleListPage` 按同一个容器宽度给 `size`。
   * 列宽由后端 `/ledger/contracts` 返回，已是**像素**宽（后端把 Excel 字符宽统一换算过）。
   */
  const { ref: cqRef, size: containerSize } = useContainerWidth<HTMLDivElement>();
  const frozenLeftKeys = useMemo(
    () => (containerSize.isNarrow ? ['contractCode'] : ['index', 'contractCode']),
    [containerSize.isNarrow],
  );

  const buildColumns = useCallback(
    (cols: LedgerColumn[]) =>
      cols
        .filter((c) => c.visible)
        .map((c) => ({
          title: c.title,
          dataIndex: c.key,
          key: c.key,
          width: c.width || 140,
          ...(frozenLeftKeys.includes(c.key) ? { fixed: 'left' as const } : {}),
          render: (v: unknown) => renderCell(c.key, v),
        })),
    [frozenLeftKeys],
  );

  const tableColumns = useMemo(() => buildColumns(columns), [buildColumns, columns]);

  const openColModal = () => {
    setColChecked(columns.filter((c) => c.visible).map((c) => c.key));
    setColModal(true);
  };

  const saveCols = async () => {
    const config: Record<string, boolean> = {};
    columns.forEach((c) => {
      config[c.key] = colChecked.includes(c.key);
    });
    await ledgerApi.saveColumns(config);
    message.success('列设置已保存');
    setColModal(false);
    setListRefresh((k) => k + 1);
  };

  /** 台账行增删改后：列表与顶部统计卡都要重取（统计卡不走列表接口） */
  const refreshAll = useCallback(() => {
    setListRefresh((k) => k + 1);
    loadSummary();
  }, [loadSummary]);

  const openDetail = (row: LedgerRow) => {
    setDetailId(row.id);
  };

  /** 编辑取全量（含 ext / version）；列表 DTO 是拍平的展示字段，不参与保存 */
  const openEdit = async (row: LedgerRow) => {
    // 编辑取**全量**（含 ext / version）；列表 DTO 是拍平的展示字段，不参与保存
    const res: any = await contractApi.detail(row.id);
    editorTab.openEdit(row.id, res);
  };

  const confirmRemove = (row: LedgerRow) => {
    modal.confirm({
      title: '确认删除该合同？',
      content: '存在下游单据或补充协议时会被服务端拒绝，请改为归档；仅物资清单等随合同级联删除。',
      okText: '删除',
      okButtonProps: { danger: true },
      cancelText: '取消',
      onOk: async () => {
        await contractApi.remove(row.id);
        message.success('已删除');
        refreshAll();
      },
    });
  };

  /** 筛选项（问题四：标准筛选区） */
  const extraFilters: ModuleListFilterField[] = [
    // ⚠️ key 必须与服务端 findAll() 认的参数名逐字一致（见 api/types/ledger.ts 的 LEDGER_LIST_PARAM_KEYS）：
    // 曾写成 code/type/executionStatus/category，导致这四个筛选器全部静默失效（2026-11-24 修复）
    { key: 'contractCode', label: '合同编号', control: 'input' },
    {
      key: 'supplierId',
      label: '供应商',
      control: 'select',
      options: suppliers.map((s) => ({ value: s.id, label: s.name })),
      placeholder: '全部',
    },
    { key: 'typeCode', label: '合同类型', control: 'input', render: () => <DictSelect typeCode="contract_type" placeholder="全部" /> },
    { key: 'execStatus', label: '合同执行情况', control: 'input', render: () => <DictSelect typeCode="contract_execution_status" placeholder="全部" /> },
    { key: 'compliance', label: '合规性问题', control: 'select', options: COMPLIANCE_OPTIONS.map((o) => ({ value: o, label: o })) },
    { key: 'supplierCategory', label: '分供方类别', control: 'input', render: () => <DictSelect typeCode="supplier_category" placeholder="全部" /> },
    { key: 'keyword', label: '关键词', control: 'input' },
  ];

  return (
    <Space ref={cqRef} className="cq" direction="vertical" size={16} style={{ width: '100%' }}>
      {summary && (
        <Row gutter={16}>
          <Col xs={12} md={8} lg={4}>
            <Card size="small" className="stat-card"><Statistic title="合同数量" value={summary.contractCount ?? 0} /></Card>
          </Col>
          <Col xs={12} md={8} lg={4}>
            <Card size="small" className="stat-card">
              <Statistic title="合同总额" value={money(summary.contractAmount)} />
              {/* 未填金额的合同按 0 参与求和（金额未知）——不说出来，总额会看起来是完整的 */}
              {summary.amountMissingCount > 0 && (
                <div className="cms-hint" style={{ marginTop: 4 }}>
                  另有 {summary.amountMissingCount} 份未填金额
                </div>
              )}
            </Card>
          </Col>
          <Col xs={12} md={8} lg={4}>
            <Card size="small" className="stat-card"><Statistic title="开累结算" value={money(summary.settleAmount)} /></Card>
          </Col>
          <Col xs={12} md={8} lg={4}>
            <Card size="small" className="stat-card"><Statistic title="开累付款" value={money(summary.paidAmount)} /></Card>
          </Col>
          <Col xs={12} md={8} lg={4}>
            <Card size="small" className="stat-card"><Statistic title="应付款" value={money(summary.payableAmount)} /></Card>
          </Col>
          <Col xs={12} md={8} lg={4}>
            <Card size="small" className="stat-card"><Statistic title="100%欠款" value={money(summary.debt100)} /></Card>
          </Col>
          <Col xs={12} md={8} lg={4}>
            <Card size="small" className="stat-card"><Statistic title="合规问题数" value={summary.complianceIssues ?? 0} /></Card>
          </Col>
        </Row>
      )}

      <ModuleListPage
        mode="generic"
        fetcher={fetcher}
        extraFilters={extraFilters}
        extraColumns={tableColumns as any}
        refreshKey={listRefresh + tabRefresh}
        onView={(row) => openDetail(row as unknown as LedgerRow)}
        editPermission="contract:edit"
        rowMenuItems={(row: ModuleListRow, ctx) => {
          const r = row as unknown as LedgerRow;
          // 写操作统一用组件给出的 canEdit（与 editPermission 同源），避免页面另起一套门禁
          if (!ctx.canEdit) return [];
          // 归档是单向终态：编辑/删除都禁用，与合并前的维护页口径一致
          const archived = !!r.archivedAt;
          return [
            {
              key: 'edit',
              label: '编辑',
              disabled: archived,
              onClick: () => openEdit(r),
            },
            {
              key: 'remove',
              label: '删除',
              danger: true,
              disabled: archived,
              onClick: () => confirmRemove(r),
            },
          ];
        }}
        /* 手机端（窄容器）：只留「编号 / 名称 / 供应商 / 金额 / 执行情况」，并用卡片展示 */
        mobileDefaultKeys={['contractCode', 'contractName', 'supplierName', 'currentAmount', 'execStatus']}
        mobileCards
        emptyText="暂无合同台账数据"
        toolbarLeft={
          <Space wrap size={8}>
            <Can code="contract:edit">
              <Button type="primary" icon={<PlusOutlined />} onClick={() => editorTab.openCreate()}>
                新建合同
              </Button>
            </Can>
            <Can code="contract:edit">
              <ImportButton
                moduleName="合同台账"
                templateUrl={contractApi.templateUrl()}
                uploadUrl={contractApi.importUrl()}
                validateUrl={contractApi.validateUrl()}
                onDone={refreshAll}
              />
            </Can>
            <Button icon={<ExportOutlined />} onClick={() => window.open(withToken(ledgerApi.exportUrl()))}>
              导出
            </Button>
            <Button icon={<SettingOutlined />} onClick={openColModal}>
              列设置
            </Button>
          </Space>
        }
      />

      <ContractDetailModal
        contractId={detailId}
        onClose={() => setDetailId(null)}
        onChanged={refreshAll}
      />

      <Modal
        title="列设置"
        open={colModal}
        onOk={saveCols}
        onCancel={() => setColModal(false)}
        destroyOnHidden
      >
        <Checkbox.Group
          value={colChecked}
          onChange={(vals) => setColChecked(vals as string[])}
          style={{ display: 'flex', flexDirection: 'column', gap: 8 }}
        >
          {columns.map((c) => (
            <Checkbox key={c.key} value={c.key}>
              {c.title}
            </Checkbox>
          ))}
        </Checkbox.Group>
      </Modal>
    </Space>
  );
}
