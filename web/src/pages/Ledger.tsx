import { useCallback, useEffect, useMemo, useState } from 'react';
import { withToken } from '../utils/download';
import {
  Button,
  Card,
  Checkbox,
  Col,
  Input,
  Modal,
  Row,
  Space,
  Statistic,
  message,
} from 'antd';
import { ExportOutlined, PlusOutlined, SettingOutlined } from '@ant-design/icons';
import { ledgerApi } from '@/api/modules';
import { contractApi, supplierApi } from '@/api/business';
import DictSelect from '@/components/DictSelect';
import ImportButton from '@/components/ImportButton';
import ContractEditor from '@/components/contract/ContractEditor';
import ContractDetailModal from '@/components/contract/ContractDetailModal';
import ModuleListPage, { type ModuleListFilterField, type ModuleListRow } from '@/components/procurement/ModuleListPage';
import { useContainerWidth } from '@/hooks/useContainerWidth';
import { useEditorTab, useTabRefresh } from '@/hooks/useTabs';
import { usePermission } from '@/hooks/usePermission';
import { LIST_PATHS } from '@/constants/listPaths';
import { useDictStore } from '@/store/dict';

const money = (v: any) =>
  v == null ? '-' : '¥' + Number(v).toLocaleString('zh-CN', { maximumFractionDigits: 2 });

const COMPLIANCE_OPTIONS = [
  '无问题',
  '未招标进场',
  '未定标进场',
  '未签合同进场',
  '未签合同先进场',
  '时间数据不完整',
];

const renderYearMap = (v: any) => {
  if (!v || typeof v !== 'object') return '-';
  return Object.entries(v)
    .map(([y, a]) => `${y}: ${money(a as any)}`)
    .join('  ');
};

const renderCompliance = (v: any) => {
  if (!v || v === '无问题') return <span style={{ color: 'var(--cms-success)' }}>无问题</span>;
  if (v === '时间数据不完整') return <span style={{ color: 'var(--cms-warning)' }}>时间数据不完整</span>;
  return <span style={{ color: 'var(--cms-error)' }}>{v}</span>;
};

/**
 * 百分比列：后端存的是**小数**（税率 0.13、付款比例 0.65），导出侧用的也是 `0.00%` 格式；
 * 这里必须乘 100，否则页面显示 0.13%（合同页/导出显示 13.00%），同一份数据两种口径。
 */
const pct = (v: any) => (v == null || v === '' ? '-' : `${(Number(v) * 100).toFixed(2)}%`);

const renderCell = (key: string, v: any) => {
  if (key === 'taxRate' || key === 'currentPayRatio') return pct(v);
  if (/amount$/i.test(key) || /debt/i.test(key) || key === 'amount') return money(v);
  if (key === 'yearSettle' || key === 'yearPaid') return renderYearMap(v);
  if (key === 'compliance') return renderCompliance(v);
  return v == null || v === '' ? '-' : v;
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
    return <ContractEditor seed={editorTab.seed} listPath={LIST_PATHS.contractLedger} />;
  }
  return <LedgerList />;
}

function LedgerList() {
  const ensure = useDictStore((s) => s.ensure);
  const editorTab = useEditorTab(LIST_PATHS.contractLedger);
  const canEdit = usePermission('contract:edit');
  const [detailId, setDetailId] = useState<string | null>(null);
  const [detailOpen, setDetailOpen] = useState(false);
  /** 发票作废/红冲等跨标签动作会 bump 本路径，缓存页必须重新取数（含顶部统计） */
  const tabRefresh = useTabRefresh(LIST_PATHS.contractLedger);
  const [suppliers, setSuppliers] = useState<any[]>([]);
  const [columns, setColumns] = useState<any[]>([]);
  const [summary, setSummary] = useState<any>(null);
  const [colModal, setColModal] = useState(false);
  const [colChecked, setColChecked] = useState<string[]>([]);
  const [listRefresh, setListRefresh] = useState(0);

  /** 标准列表数据源：台账接口返回 { list, total, columns }，columns 用于动态列渲染 */
  const fetcher = useMemo(
    () => async (params: Record<string, any>) => {
      const res: any = await ledgerApi.contracts(params);
      if (res?.columns) setColumns(res.columns);
      return res;
    },
    [],
  );

  useEffect(() => {
    ensure(['contract_type', 'contract_execution_status', 'supplier_category']);
    supplierApi.options().then((res: any) => setSuppliers(res || []));
    ledgerApi.summary().then((res: any) => setSummary(res)).catch(() => setSummary(null));
  }, [tabRefresh]);

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
    (cols: any[]) =>
      cols
        .filter((c) => c.visible)
        .map((c) => ({
          title: c.title,
          dataIndex: c.key,
          key: c.key,
          width: c.width || 140,
          ...(frozenLeftKeys.includes(c.key) ? { fixed: 'left' as const } : {}),
          render: (v: any) => renderCell(c.key, v),
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
    ledgerApi.summary().then((res: any) => setSummary(res)).catch(() => setSummary(null));
  }, []);

  const openDetail = (row: any) => {
    setDetailId(row.id);
    setDetailOpen(true);
  };

  /** 编辑取全量（含 ext / version）；列表 DTO 是拍平的展示字段，不参与保存 */
  const openEdit = async (row: any) => {
    const res: any = await contractApi.detail(row.id);
    editorTab.openEdit(row.id, res);
  };

  const confirmRemove = (row: any) => {
    Modal.confirm({
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
    { key: 'code', label: '合同编号', control: 'input' },
    {
      key: 'supplierId',
      label: '供应商',
      control: 'select',
      options: suppliers.map((s) => ({ value: s.id, label: s.name })),
      placeholder: '全部',
    },
    { key: 'type', label: '合同类型', control: 'input', render: () => <DictSelect typeCode="contract_type" placeholder="全部" /> },
    { key: 'executionStatus', label: '合同执行情况', control: 'input', render: () => <DictSelect typeCode="contract_execution_status" placeholder="全部" /> },
    { key: 'compliance', label: '合规性问题', control: 'select', options: COMPLIANCE_OPTIONS.map((o) => ({ value: o, label: o })) },
    { key: 'category', label: '分供方类别', control: 'input', render: () => <DictSelect typeCode="supplier_category" placeholder="全部" /> },
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
        onView={(row) => openDetail(row as any)}
        editPermission="contract:edit"
        rowMenuItems={(row: ModuleListRow, ctx) => {
          const r = row as any;
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
            {canEdit && (
              <Button type="primary" icon={<PlusOutlined />} onClick={() => editorTab.openCreate()}>
                新建合同
              </Button>
            )}
            {canEdit && (
              <ImportButton
                moduleName="合同台账"
                templateUrl={contractApi.templateUrl()}
                uploadUrl={contractApi.importUrl()}
                validateUrl={contractApi.validateUrl()}
                onDone={refreshAll}
              />
            )}
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
        open={detailOpen}
        onClose={() => setDetailOpen(false)}
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
