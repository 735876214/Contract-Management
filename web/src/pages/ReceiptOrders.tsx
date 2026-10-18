import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Alert, AutoComplete, Button, Card, Col, DatePicker, Form, Input, InputNumber, Modal, Popconfirm,
  Row, Select, Space, Table, Tabs, Tag, Tooltip, Upload, message,
} from 'antd';
import {
  ArrowLeftOutlined, DeleteOutlined, PaperClipOutlined, PlusOutlined, ReloadOutlined, SaveOutlined,
  SearchOutlined, SelectOutlined, SyncOutlined, UploadOutlined,
} from '@ant-design/icons';
import dayjs from 'dayjs';
import { receiptOrderApi } from '@/api/business';
import { fileApi } from '@/api/auth';
import { dictApi } from '@/api/dict';
import { useTable } from '@/hooks/useTable';
import { useEditorTab, useTabRefresh } from '@/hooks/useTabs';
import { DictTag } from '@/components/DictSelect';
import EditorTabPage from '@/components/editor/EditorTabPage';

/** 列表与「新增/编辑」是同一路由的两种形态（`?editor=new|<id>`），见 `useEditorTab` 的注释 */
const LIST_PATH = '/daily/receipt';

/** 数字格式化 */
const fmtNum = (v: any, digits = 4) =>
  v == null || v === '' ? '-' : Number(v).toLocaleString('zh-CN', { maximumFractionDigits: digits });
const fmtMoney = (v: any) =>
  v == null || v === '' ? '-' : `¥${Number(v).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const round4 = (n: number) => Math.round((n + Number.EPSILON) * 1e4) / 1e4;
const round2 = (n: number) => Math.round((n + Number.EPSILON) * 1e2) / 1e2;

/** 综合单价 = 税前单价 × (1 + 税率/100) */
const calcPriceWithTax = (priceBeforeTax?: number | null, taxRate?: number | null) =>
  priceBeforeTax == null || taxRate == null ? null : round4(Number(priceBeforeTax) * (1 + Number(taxRate) / 100));
/** 综合总价 = 实收数量 × 综合单价 */
const calcTotal = (priceWithTax?: number | null, receivedQty?: number | null) =>
  priceWithTax == null || receivedQty == null ? null : round2(Number(priceWithTax) * Number(receivedQty));

const YES_NO = [
  { value: 'Y', label: '是' },
  { value: 'N', label: '否' },
];

/** 供应单位类型（需求 2.4.1，4 类；Tab 顺序按需求文档） */
const SUPPLIER_TABS = [
  { key: 'SUPPLIER', label: '供应商' },
  { key: 'OTHER_PROJECT', label: '其他项目' },
  { key: 'SUBCONTRACTOR', label: '分包商' },
  { key: 'SELF_PROJECT', label: '本项目' },
];

/** 领用单位类型（需求 2.4.2，3 类；分包商默认选中） */
const RECEIVING_TABS = [
  { key: 'SUBCONTRACTOR', label: '分包商' },
  { key: 'SELF_PROJECT', label: '本项目' },
  { key: 'OTHER_PROJECT', label: '其他项目' },
];

/** 生成稳定的行 key（新增行无后端 id 时使用） */
let rowSeq = 0;
const nextKey = () => `tmp-${Date.now()}-${(rowSeq += 1)}`;

// ==================== 计量单位输入（需求 2.3.2：可手输，但必须存在于字典） ====================

/** 字典「计量单位」选项缓存（下拉选项统一来自字典管理） */
let unitOptionsCache: string[] | null = null;
async function loadUnitOptions(): Promise<string[]> {
  if (unitOptionsCache) return unitOptionsCache;
  const res: any = await dictApi.options('measurement_unit');
  unitOptionsCache = (res || []).map((u: any) => u.label).filter(Boolean);
  return unitOptionsCache;
}

function UnitInput({ value, onChange }: { value?: string; onChange: (v: string) => void }) {
  const [options, setOptions] = useState<string[]>(unitOptionsCache || []);
  const [text, setText] = useState<string>(value || '');
  const [invalid, setInvalid] = useState(false);

  useEffect(() => {
    loadUnitOptions().then(setOptions).catch(() => undefined);
  }, []);
  useEffect(() => {
    setText(value || '');
    setInvalid(false);
  }, [value]);

  return (
    <Tooltip title={invalid ? '计量单位不在字典范围内，请先在字典管理中添加' : '默认取物资基础库，可输入其他字典内单位'}>
      <AutoComplete
        value={text}
        options={options.map((u) => ({ value: u }))}
        style={{ width: '100%' }}
        placeholder="计量单位"
        status={invalid ? 'error' : undefined}
        filterOption={(input, option) => String(option?.value || '').includes(input)}
        onChange={(v) => setText(v ?? '')}
        onBlur={() => {
          const v = (text || '').trim();
          // 需求 2.3.2：前端拦截字典以外的单位
          if (v && options.length && !options.includes(v)) {
            setInvalid(true);
            message.error(`计量单位「${v}」不在字典范围内，请先在字典管理中添加`);
            return;
          }
          setInvalid(false);
          onChange(v);
        }}
      />
    </Tooltip>
  );
}

// ==================== 通用：Tab 名称选择弹窗（供应单位 / 领用单位） ====================

interface TabPickerProps {
  open: boolean;
  title: string;
  tabs: { key: string; label: string }[];
  defaultTab: string;
  loading?: boolean;
  onCancel: () => void;
  /** 按 Tab 拉取数据源；keyword 为空表示不筛选 */
  onLoad: (tab: string, keyword: string) => Promise<any[]>;
  onPick: (row: any, tab: string) => void;
  /** 各行展示的列（可随 Tab 不同而变化） */
  columnsFor: (tab: string) => any[];
}

/**
 * 查询弹窗：Tab 标签页切换数据源（需求 2.4.4 / 2.4.5）
 * 每次切换 Tab 或输入关键词回车都会重新拉取对应数据源。
 */
function TabPickerModal({
  open, title, tabs, defaultTab, loading, onCancel, onLoad, onPick, columnsFor,
}: TabPickerProps) {
  const [tab, setTab] = useState(defaultTab);
  const [keyword, setKeyword] = useState('');
  const [rows, setRows] = useState<any[]>([]);
  const [innerLoading, setInnerLoading] = useState(false);

  const fetchRows = useCallback(
    async (t: string, kw: string) => {
      setInnerLoading(true);
      try {
        setRows((await onLoad(t, kw)) || []);
      } catch {
        setRows([]);
      } finally {
        setInnerLoading(false);
      }
    },
    [onLoad],
  );

  // 打开时复位到默认 Tab 并加载
  useEffect(() => {
    if (!open) return;
    setTab(defaultTab);
    setKeyword('');
    fetchRows(defaultTab, '');
  }, [open, defaultTab, fetchRows]);

  return (
    <Modal title={title} open={open} onCancel={onCancel} footer={null} width={860} destroyOnHidden>
      <Tabs
        activeKey={tab}
        items={tabs.map((t) => ({ key: t.key, label: t.label }))}
        onChange={(k) => {
          setTab(k);
          setKeyword('');
          fetchRows(k, '');
        }}
      />
      <Input.Search
        placeholder="输入名称关键词后回车检索"
        allowClear
        enterButton
        value={keyword}
        onChange={(e) => setKeyword(e.target.value)}
        onSearch={(v) => fetchRows(tab, v)}
        style={{ marginBottom: 12 }}
      />
      <Table
      scroll={{ x: 'max-content' }}
        rowKey={(r: any) => `${tab}-${r.id}`}
        size="small"
        loading={loading || innerLoading}
        dataSource={rows}
        pagination={{ pageSize: 8, showTotal: (t) => `共 ${t} 条` }}
        onRow={(record) => ({ onClick: () => onPick(record, tab), style: { cursor: 'pointer' } })}
        columns={columnsFor(tab)}
        locale={{ emptyText: '该分类下暂无数据' }}
      />
    </Modal>
  );
}

// ==================== 明细表格列定义 ====================

const DETAIL_COLUMNS = (
  patchDetail: (key: React.Key, field: string, value: any) => void,
  showCustodian: boolean,
) => [
  { title: '序号', width: 60, fixed: 'left' as const, render: (_: any, __: any, i: number) => i + 1 },
  { title: '一级分类', dataIndex: 'categoryLevel1', width: 110, render: (v: any) => v || '-' },
  { title: '二级分类', dataIndex: 'categoryLevel2', width: 110, render: (v: any) => v || '-' },
  { title: '物资名称', dataIndex: 'materialName', width: 160, fixed: 'left' as const, ellipsis: true, render: (v: any) => v || '-' },
  { title: '规格型号', dataIndex: 'specModel', width: 140, ellipsis: true, render: (v: any) => v || '-' },
  {
    title: '计量单位', dataIndex: 'unit', width: 130,
    // 需求 2.3.2：默认从物资基础库带出，可手动输入，但必须存在于字典「计量单位」
    render: (v: any, row: any) => (
      <UnitInput value={v} onChange={(val) => patchDetail(row.key, 'unit', val)} />
    ),
  },
  { title: '合同数量', dataIndex: 'contractQty', width: 110, align: 'right' as const, render: (v: any) => fmtNum(v) },
  {
    title: '送货数量', dataIndex: 'deliveryQty', width: 130,
    render: (v: any, row: any) => (
      <InputNumber style={{ width: '100%' }} min={0} precision={4} value={v} placeholder="填写"
        onChange={(val) => patchDetail(row.key, 'deliveryQty', val)} />
    ),
  },
  {
    title: '实收数量', dataIndex: 'receivedQty', width: 130,
    render: (v: any, row: any) => (
      <InputNumber style={{ width: '100%' }} min={0} precision={4} value={v} placeholder="填写"
        onChange={(val) => patchDetail(row.key, 'receivedQty', val)} />
    ),
  },
  { title: '税前单价（元）', dataIndex: 'priceBeforeTax', width: 130, align: 'right' as const, render: (v: any) => fmtNum(v, 2) },
  { title: '综合单价（元）', dataIndex: 'priceWithTax', width: 130, align: 'right' as const, render: (v: any) => <Tag color="geekblue">{fmtNum(v, 2)}</Tag> },
  { title: '综合总价（元）', dataIndex: 'totalPrice', width: 140, align: 'right' as const, render: (v: any) => <Tag color="geekblue">{fmtMoney(v)}</Tag> },
  {
    title: '使用部位', dataIndex: 'usagePart', width: 140,
    render: (v: any, row: any) => (
      <Input value={v} placeholder="填写" onChange={(e) => patchDetail(row.key, 'usagePart', e.target.value)} />
    ),
  },
  // 「是否为资产」= 是 → 明细增加保管栏（业务 2026-10-17）；= 否 或未选 → 不显示
  ...(showCustodian
    ? [
        {
          title: '保管单位及保管人', dataIndex: 'custodian', width: 170,
          render: (v: any, row: any) => (
            <Input value={v} placeholder="保管单位及保管人" onChange={(e) => patchDetail(row.key, 'custodian', e.target.value)} />
          ),
        },
      ]
    : []),
  {
    title: '厂家/品牌', dataIndex: 'brand', width: 140,
    render: (v: any, row: any) => (
      <Input value={v} placeholder="填写" onChange={(e) => patchDetail(row.key, 'brand', e.target.value)} />
    ),
  },
  {
    title: '备注', dataIndex: 'remark', width: 160,
    render: (v: any, row: any) => (
      <Input value={v} placeholder="填写" onChange={(e) => patchDetail(row.key, 'remark', e.target.value)} />
    ),
  },
  {
    title: '是否代购', dataIndex: 'isAgentPurchase', width: 130,
    render: (v: any, row: any) => (
      <Select allowClear style={{ width: '100%' }} placeholder="选择" value={v || undefined} options={YES_NO}
        onChange={(val) => patchDetail(row.key, 'isAgentPurchase', val)} />
    ),
  },
];

// ==================== 主页面 ====================

export default function ReceiptOrders() {
  // -------- 列表视图 --------
  const { loading, list, search, reload, pagination } = useTable<any>((p) => receiptOrderApi.list(p));
  const [filterForm] = Form.useForm();

  /**
   * 列表与「新增/编辑」是同一路由的两种形态（`?editor=new|<id>`）。
   * 本页原本就用「整页编辑态 + 返回列表」而非弹窗；改成编辑器页签后，
   * **列表标签不再被编辑态顶掉**（可以一边开着列表对照，一边填单）。
   * 编辑所需的表头与明细由列表侧算好后经 `seed` 递过来（两个实例互相看不到对方的 state）。
   */
  const editorTab = useEditorTab(LIST_PATH);
  const tabRefresh = useTabRefresh(LIST_PATH);
  const seed = editorTab.seed as { header: Record<string, any>; details: any[] } | undefined;
  const isEdit = editorTab.isEditor;
  const editingId = isEdit && editorTab.editorId !== 'new' ? (editorTab.editorId as string) : null;

  // -------- 编辑态数据 --------
  const [headerForm] = Form.useForm();
  const pendingHeader = seed?.header ?? null;

  // Space.Compact 包裹的 Select 无法被 Form.Item 自动注入 value/onChange，需手工受控
  const watchSupplierType = Form.useWatch('supplierType', headerForm) as string | undefined;
  const watchReceivingUnitType = Form.useWatch('receivingUnitType', headerForm) as string | undefined;
  const watchSupplierId = Form.useWatch('supplierId', headerForm);
  const watchSupplierName = Form.useWatch('supplierName', headerForm);
  const watchReceivingUnitId = Form.useWatch('receivingUnitId', headerForm);
  const watchReceivingUnitName = Form.useWatch('receivingUnitName', headerForm);
  const watchMaterialContractId = Form.useWatch('materialContractId', headerForm);
  // 「是否为资产」= 是 → 明细显示「保管单位及保管人」列（业务 2026-10-17）
  const watchIsAssetFlag = Form.useWatch('isAssetFlag', headerForm);
  // 收领单扫描件（附件需求）：归档到「5.物资结算/收领单」
  const watchScanUrl = Form.useWatch('scanUrl', headerForm);
  const watchScanFileName = Form.useWatch('scanFileName', headerForm);
  const [uploadingScan, setUploadingScan] = useState(false);

  const [details, setDetails] = useState<any[]>(() => seed?.details ?? []);
  const [selectedRowKeys, setSelectedRowKeys] = useState<React.Key[]>([]);
  const [saving, setSaving] = useState(false);
  const [loadingDetails, setLoadingDetails] = useState(false);

  // 下拉数据源
  const [contracts, setContracts] = useState<any[]>(() => (seed as any)?.supplierContracts ?? []); // 物资合同（= 该供应商在本项目的合同，由选中供应商带出）
  const [supplySubContracts, setSupplySubContracts] = useState<any[]>(() => (seed as any)?.supplySubContracts ?? []); // 分包合同（供应分包商场景）
  const [receiveSubContracts, setReceiveSubContracts] = useState<any[]>(() => (seed as any)?.receiveSubContracts ?? []); // 分包合同（领用分包商场景）

  // 弹窗
  const [supplierPickerOpen, setSupplierPickerOpen] = useState(false);
  const [unitPickerOpen, setUnitPickerOpen] = useState(false);

  // 明细区筛选
  const [matKeyword, setMatKeyword] = useState('');
  const [specKeyword, setSpecKeyword] = useState('');
  // 领料人候选（领用单位为分包商时，取其材料授权人）
  const [receiverOptions, setReceiverOptions] = useState<string[]>(() => (seed as any)?.receiverOptions ?? []);

  // 合同下拉一律由所选供应/领用单位带出（业务 2026-10-17），不再预取全量合同

  // ==================== 条件可见性（需求 2.4.3 动态表单） ====================
  // 供应单位 = 供应商 → 显示物资合同；= 分包商 → 显示供应分包合同；本项目/其他项目 → 都隐藏
  const showMaterialContract = watchSupplierType === 'SUPPLIER';
  const showSupplySubcontract = watchSupplierType === 'SUBCONTRACTOR';
  // 领用单位 = 分包商 → 显示分包合同，且领料人变为下拉选择
  const showReceiveSubcontract = watchReceivingUnitType === 'SUBCONTRACTOR';

  // ==================== 弹窗数据源 ====================
  const loadPartyOptions = useCallback(async (tab: string, keyword: string) => {
    const res: any = await receiptOrderApi.partyOptions(keyword);
    return res?.[tab] || [];
  }, []);

  const loadReceivingOptions = useCallback(async (tab: string, keyword: string) => {
    const res: any = await receiptOrderApi.receivingUnitOptions(keyword);
    return res?.[tab] || [];
  }, []);

  /** 供应单位弹窗列：供应商显示信用代码/联系人；分包商显示授权人；项目类仅名称 */
  const supplierColumns = useCallback((tab: string) => {
    if (tab === 'SUPPLIER') {
      return [
        { title: '供应商名称', dataIndex: 'name', ellipsis: true },
        { title: '法人', dataIndex: 'legalPerson', width: 100, render: (v: any) => v || '-' },
        { title: '联系人', dataIndex: 'contactName', width: 100, render: (v: any) => v || '-' },
        { title: '联系电话', dataIndex: 'contactPhone', width: 140, render: (v: any) => v || '-' },
      ];
    }
    if (tab === 'SUBCONTRACTOR') {
      return [
        { title: '分包商名称', dataIndex: 'name', ellipsis: true },
        { title: '法人姓名', dataIndex: 'legalPerson', width: 110, render: (v: any) => v || '-' },
        { title: '材料授权人', dataIndex: 'authorizedPerson', width: 120, render: (v: any) => v || '-' },
        { title: '状态', dataIndex: 'status', width: 90, render: (v: any) => (v === 'COMPLETED' ? '已完成' : '编辑中') },
      ];
    }
    return [{ title: '项目名称', dataIndex: 'name', ellipsis: true }];
  }, []);

  const receivingColumns = useCallback((tab: string) => supplierColumns(tab), [supplierColumns]);

  // ==================== 选择回调（含互锁） ====================

  /** 供应单位选中：记录类型 + 名称；供应商/分包商各自联动合同下拉（只带该单位自己的合同） */
  const onPickSupplier = async (row: any, tab: string) => {
    setSupplierPickerOpen(false);
    headerForm.setFieldsValue({
      supplierId: row.id,
      supplierName: row.name,
      supplierType: tab,
      // 切换类型/单位时清空合同与明细，避免脏数据互串
      materialContractId: undefined,
      materialContractNo: undefined,
      supplySubcontractId: undefined,
      supplySubcontractName: undefined,
      subcontractorId: undefined,
    });
    setSupplySubContracts([]);
    setContracts([]); // 合同下拉一律由所选单位带出，不再用全量
    setDetails([]); // 换供应单位 → 明细必须重新带出
    if (tab === 'SUPPLIER') {
      // 业务 2026-10-17：物资合同下拉 = 该供应商在本项目的合同，由用户自选
      try {
        const list: any = await receiptOrderApi.supplierContracts(row.id);
        setContracts(list || []);
      } catch {
        /* 拦截器已提示 */
      }
    } else if (tab === 'SUBCONTRACTOR') {
      // 互锁（需求 2.5）：分包商 → 带出其分包合同；材料授权人可作为领料人
      headerForm.setFieldsValue({ subcontractorId: row.id });
      try {
        const list: any = await receiptOrderApi.subcontractorContracts(row.id);
        setSupplySubContracts(list || []);
        if (row.subcontractId) {
          const hit = (list || []).find((c: any) => c.id === row.subcontractId);
          if (hit) headerForm.setFieldsValue({ supplySubcontractId: hit.id, supplySubcontractName: hit.name });
        }
        // 材料授权人作为领料人候选
        if (row.authorizedPerson) {
          setReceiverOptions([row.authorizedPerson]);
          headerForm.setFieldsValue({ receiver: row.authorizedPerson });
        }
      } catch {
        /* 拦截器已提示 */
      }
    } else {
      setReceiverOptions([]);
    }
    message.success(`已选择供应单位（${SUPPLIER_TABS.find((t) => t.key === tab)?.label}）：${row.name}`);
  };

  /** 领用单位选中：分包商场景带出其领用过的材料 + 分包合同/领料人联动 */
  const onPickReceiving = async (row: any, tab: string) => {
    setUnitPickerOpen(false);
    headerForm.setFieldsValue({
      receivingUnitId: row.id,
      receivingUnitName: row.name,
      receivingUnitType: tab,
      subcontractId: undefined,
      subcontractName: undefined,
    });
    setReceiveSubContracts([]);
    if (tab === 'SUBCONTRACTOR') {
      // 业务 2026-10-17：带出该分包商在本项目领用过的所有材料（与分包单位领用汇总同源口径）
      await loadDetailsFor(() => receiptOrderApi.subcontractorMaterials(row.id), `已带出分包商「${row.name}」领用过的材料`);
      // 互锁：领用分包商 → 必填分包合同，材料授权人作为领料人可选
      try {
        const list: any = await receiptOrderApi.subcontractorContracts(row.id);
        setReceiveSubContracts(list || []);
        if (row.subcontractId) {
          const hit = (list || []).find((c: any) => c.id === row.subcontractId);
          if (hit) headerForm.setFieldsValue({ subcontractId: hit.id, subcontractName: hit.name });
        }
        if (row.authorizedPerson) {
          setReceiverOptions([row.authorizedPerson]);
          if (!headerForm.getFieldValue('receiver')) {
            headerForm.setFieldsValue({ receiver: row.authorizedPerson });
          }
        }
      } catch {
        /* 拦截器已提示 */
      }
    } else {
      setReceiverOptions([]);
      setDetails([]); // 本项目/其他项目 → 合同与清单都隐藏/清空
    }
    message.success(`已选择领用单位（${RECEIVING_TABS.find((t) => t.key === tab)?.label}）：${row.name}`);
  };

  // ==================== 新建 / 编辑 ====================

  const startCreate = async () => {
    // 默认：供应单位=供应商、领用单位=分包商（需求 2.4.4 / 2.4.5 默认选中项）
    let init: Record<string, any> = {
      orderDate: dayjs(),
      supplierType: 'SUPPLIER', receivingUnitType: 'SUBCONTRACTOR',
      isAssetFlag: 'N',
    };
    try {
      const res: any = await receiptOrderApi.nextNo();
      init = { ...init, orderNo: res?.orderNo };
    } catch {
      /* 编号获取失败时仍允许手工录入 */
    }
    // 表头/明细/下拉数据源都交给编辑器实例（它与列表是两个独立实例，看不到这里的 state）
    editorTab.openCreate({ header: init, details: [], supplySubContracts: [], receiveSubContracts: [], receiverOptions: [] });
  };

  const startEdit = async (row: any) => {
    const receiverOptions = row.receiver ? [row.receiver] : [];
    let supplySubContracts: any[] = [];
    let receiveSubContracts: any[] = [];
    let supplierContracts: any[] = [];
    let header: Record<string, any> = {};
    let editDetails: any[] = [];
    try {
      const detail: any = await receiptOrderApi.detail(row.id);
      header = {
        orderNo: detail.orderNo,
        supplierId: detail.supplierId,
        supplierName: detail.supplierName,
        supplierType: detail.supplierType || 'SUPPLIER',
        receivingUnitId: detail.receivingUnitId,
        receivingUnitName: detail.receivingUnitName,
        receivingUnitType: detail.receivingUnitType || 'SUBCONTRACTOR',
        subcontractId: detail.subcontractId,
        subcontractName: detail.subcontractName,
        supplySubcontractId: detail.supplySubcontractId,
        supplySubcontractName: detail.supplySubcontractName,
        subcontractorId: detail.subcontractorId,
        orderDate: detail.orderDate ? dayjs(detail.orderDate) : null,
        receiver: detail.receiver,
        materialContractId: detail.materialContractId,
        materialContractNo: detail.materialContractNo, // 快照落库，不在界面显示
        isAssetFlag: detail.isAssetFlag || undefined,
        // 扫描件：后端存相对键，展示用完整 URL（提交时后端归一化回相对键）
        scanUrl: detail.scanUrl ? `/api/files/${detail.scanUrl}` : null,
        scanFileName: detail.scanFileName || null,
        remark: detail.remark,
      };
      // 回填互锁数据源（这些数据由**编辑器实例**持有，故随 seed 一起递过去）
      if (detail.supplierType === 'SUPPLIER' && detail.supplierId) {
        supplierContracts = await receiptOrderApi
          .supplierContracts(detail.supplierId)
          .catch(() => []);
      }
      if (detail.supplierType === 'SUBCONTRACTOR' && detail.subcontractorId) {
        supplySubContracts = await receiptOrderApi
          .subcontractorContracts(detail.subcontractorId)
          .catch(() => []);
      }
      if (detail.receivingUnitType === 'SUBCONTRACTOR' && detail.receivingUnitId) {
        receiveSubContracts = await receiptOrderApi
          .subcontractorContracts(detail.receivingUnitId)
          .catch(() => []);
      }
      editDetails = (detail.details || []).map((d: any) => ({
        ...d,
        key: d.id,
        contractQty: d.contractQty == null ? null : Number(d.contractQty),
        deliveryQty: d.deliveryQty == null ? null : Number(d.deliveryQty),
        receivedQty: d.receivedQty == null ? null : Number(d.receivedQty),
        priceBeforeTax: d.priceBeforeTax == null ? null : Number(d.priceBeforeTax),
        taxRate: d.taxRate == null ? null : Number(d.taxRate),
        priceWithTax: d.priceWithTax == null ? null : Number(d.priceWithTax),
        totalPrice: d.totalPrice == null ? null : Number(d.totalPrice),
      }));
    } catch {
      /* 错误已由拦截器提示 */
      return;
    }
    editorTab.openEdit(row.id, {
      header,
      details: editDetails,
      supplySubContracts,
      receiveSubContracts,
      supplierContracts,
      receiverOptions,
    });
  };

  /** 通用：带出明细清单（已有手填数据时先确认覆盖） */
  const loadDetailsFor = async (fetcher: () => Promise<any>, okMessage: string) => {
    if (details.length) {
      const ok = await new Promise((resolve) => {
        Modal.confirm({
          title: '重新加载明细清单？',
          content: '将重新带出清单，当前已填写的手动数据会被覆盖。',
          okText: '重新加载',
          cancelText: '取消',
          onOk: () => resolve(true),
          onCancel: () => resolve(false),
        });
      });
      if (!ok) return;
    }
    setLoadingDetails(true);
    try {
      const res: any = await fetcher();
      const list: any[] = (res?.list || []).map((r: any) => ({ ...r, key: r.key || nextKey() }));
      setDetails(list);
      setSelectedRowKeys([]);
      if (list.length) message.success(`${okMessage}，共 ${list.length} 条`);
    } finally {
      setLoadingDetails(false);
    }
  };

  /**
   * 选择合同 → 自动带出编号 + 明细清单。
   * 供应/领用两侧的合同（物资合同、分包合同）统一走这里：
   * 供应商合同走 contractMaterials（合同清单）；分包商领用清单已在选中分包商时带出，
   * 此处分包合同仅落名称快照，不重复加载明细。
   */
  const onContractChange = async (contractId: string) => {
    const hit = contracts.find((c) => c.id === contractId) || supplySubContracts.find((c) => c.id === contractId);
    headerForm.setFieldsValue({ materialContractNo: hit?.code || '', settlementId: undefined });
    if (!contractId) {
      setDetails([]);
      return;
    }
    await loadDetailsFor(
      () => receiptOrderApi.contractMaterials(contractId),
      '已带出合同物资清单',
    );
  };

  /** 明细单元格改动：重算综合单价与综合总价（前端实时预览，服务端保存时二次计算） */
  const patchDetail = useCallback((key: React.Key, field: string, value: any) => {
    setDetails((prev) =>
      prev.map((r) => {
        if (r.key !== key) return r;
        const next = { ...r, [field]: value };
        const priceWithTax = calcPriceWithTax(next.priceBeforeTax, next.taxRate);
        next.priceWithTax = priceWithTax;
        next.totalPrice = calcTotal(priceWithTax, next.receivedQty);
        return next;
      }),
    );
  }, []);

  const removeSelected = () => {
    if (!selectedRowKeys.length) return message.warning('请先勾选要删除的明细行');
    setDetails((prev) => prev.filter((r) => !selectedRowKeys.includes(r.key)));
    setSelectedRowKeys([]);
    message.success('已删除所选明细行');
  };

  const submit = async () => {
    const values = await headerForm.validateFields();
    if (!details.length) return message.warning('请先带出物资明细');
    const invalid = details.find((d) => d.receivedQty == null || d.receivedQty === '');
    if (invalid) return message.warning(`物资「${invalid.materialName || '-'}」请填写实收数量`);

    const payload: any = {
      ...values,
      orderDate: values.orderDate ? values.orderDate.format('YYYY-MM-DD') : null,
      details: details.map((d, i) => ({
        materialId: d.materialId,
        categoryLevel1: d.categoryLevel1,
        categoryLevel2: d.categoryLevel2,
        materialName: d.materialName,
        specModel: d.specModel,
        unit: d.unit,
        contractQty: d.contractQty,
        deliveryQty: d.deliveryQty,
        receivedQty: d.receivedQty,
        priceBeforeTax: d.priceBeforeTax,
        taxRate: d.taxRate,
        usagePart: d.usagePart,
        custodian: d.custodian,
        brand: d.brand,
        remark: d.remark,
        isAgentPurchase: d.isAgentPurchase,
        sortOrder: i + 1,
      })),
    };

    setSaving(true);
    try {
      const saved: any = editingId
        ? await receiptOrderApi.update(editingId, { ...payload, version: seed?.header?.version })
        : await receiptOrderApi.create(payload);
      const targetId = saved?.id || editingId;
      if (targetId) {
        const pushed = await receiptOrderApi.push(targetId);
        message.success(`保存成功，已推送 ${pushed?.pushed ?? 0} 条明细到总日报`);
      } else {
        message.success('保存成功');
      }
      // 保存成功 → 关掉编辑器标签并让列表标签重新取数（closeEditor 内部会 bump）
      editorTab.closeEditor();
    } finally {
      setSaving(false);
    }
  };

  // -------- 明细筛选（前端本地过滤） --------
  const visibleDetails = useMemo(() => {
    const kw = matKeyword.trim();
    const sk = specKeyword.trim();
    if (!kw && !sk) return details;
    return details.filter(
      (d) =>
        (!kw || String(d.materialName || '').includes(kw)) &&
        (!sk || String(d.specModel || '').includes(sk)),
    );
  }, [details, matKeyword, specKeyword]);

  const totalAmount = useMemo(
    () => round2(details.reduce((acc, d) => acc + (Number(d.totalPrice) || 0), 0)),
    [details],
  );

  // 编辑视图挂载后（<Form> 已连接）再写入 seed 带来的表头初值
  useEffect(() => {
    if (isEdit && pendingHeader) {
      headerForm.resetFields();
      headerForm.setFieldsValue(pendingHeader);
    }
    // seed 由「打开编辑器」时一次性给定，故只在首次挂载时回填
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isEdit, headerForm]);

  // 编辑器标签保存后 bump 令牌 → 本（被缓存的）列表标签重新取数
  useEffect(() => {
    if (tabRefresh) reload();
  }, [tabRefresh, reload]);

  // ==================== 列表视图 ====================

  if (!isEdit) {
    return (
      <Card
        title="收领单"
        extra={
          <Space>
            <Button icon={<ReloadOutlined />} onClick={reload}>刷新</Button>
            <Button type="primary" icon={<PlusOutlined />} onClick={startCreate}>新增收领单</Button>
          </Space>
        }
      >
        <Form form={filterForm} layout="inline" style={{ marginBottom: 12, rowGap: 8 }}>
          <Form.Item name="keyword" label="关键词">
            <Input
              allowClear
              placeholder="收领单编号 / 供应单位 / 领用单位 / 领料人"
              style={{ width: 280 }}
              onPressEnter={() => search(filterForm.getFieldsValue())}
            />
          </Form.Item>
          <Form.Item name="status" label="状态">
            <Select
              allowClear
              placeholder="全部"
              style={{ width: 120 }}
              options={[
                { value: 'DRAFT', label: '草稿' },
                { value: 'SAVED', label: '已保存' },
              ]}
            />
          </Form.Item>
          <Form.Item name="dateRange" label="日期">
            <DatePicker.RangePicker format="YYYY-MM-DD" style={{ width: 240 }} />
          </Form.Item>
          <Form.Item>
            <Space>
              <Button
                type="primary"
                icon={<SearchOutlined />}
                onClick={() => {
                  const v = filterForm.getFieldsValue();
                  const p: any = { keyword: v.keyword, status: v.status };
                  if (v.dateRange?.[0]) p.startDate = v.dateRange[0].format('YYYY-MM-DD');
                  if (v.dateRange?.[1]) p.endDate = v.dateRange[1].format('YYYY-MM-DD');
                  search(p);
                }}
              >
                查询
              </Button>
              <Button
                icon={<ReloadOutlined />}
                onClick={() => {
                  filterForm.resetFields();
                  search({ keyword: undefined, status: undefined, startDate: undefined, endDate: undefined });
                }}
              >
                重置
              </Button>
            </Space>
          </Form.Item>
        </Form>

        <Table
          rowKey="id"
          loading={loading}
          dataSource={list}
          pagination={pagination}
          scroll={{ x: 1500 }}
          locale={{ emptyText: '暂无数据...' }}
          columns={[
            { title: '序号', width: 70, fixed: 'left', render: (_: any, __: any, i: number) => (pagination.current - 1) * pagination.pageSize + i + 1 },
            { title: '收领单编号', dataIndex: 'orderNo', width: 180, fixed: 'left' },
            { title: '日期', dataIndex: 'orderDate', width: 120, render: (v: any) => (v ? String(v).slice(0, 10) : '-') },
            {
              title: '供应单位', dataIndex: 'supplierName', width: 210, ellipsis: true,
              render: (v: any, row: any) => (
                <Space size={4}>
                  <span>{v || '-'}</span>
                  {row.supplierType && (
                    <Tag color="blue">{SUPPLIER_TABS.find((t) => t.key === row.supplierType)?.label || row.supplierType}</Tag>
                  )}
                </Space>
              ),
            },
            {
              title: '领用单位', dataIndex: 'receivingUnitName', width: 210, ellipsis: true,
              render: (v: any, row: any) => (
                <Space size={4}>
                  <span>{v || '-'}</span>
                  {row.receivingUnitType && (
                    <Tag color="purple">{RECEIVING_TABS.find((t) => t.key === row.receivingUnitType)?.label || row.receivingUnitType}</Tag>
                  )}
                </Space>
              ),
            },
            // 物资合同编号快照已不在列表展示（业务 2026-10-17）
            {
              title: '结算单', dataIndex: 'settlementId', width: 150,
              // 未挂结算单的收领单：仍会被「生成本期结算」抓到（按物资合同 + 期间归集），故显示为「未关联」
              render: (_v: any, row: any) =>
                row.settlement
                  ? `${row.settlement.settleDate ? String(row.settlement.settleDate).slice(0, 7) : ''}${row.settlement.code ? ` ${row.settlement.code}` : ''}`.trim()
                  : '未关联',
            },
            { title: '供应分包合同', dataIndex: 'supplySubcontractName', width: 180, ellipsis: true, render: (v: any) => v || '-' },
            { title: '分包合同', dataIndex: 'subcontractName', width: 180, ellipsis: true, render: (v: any) => v || '-' },
            { title: '领料人', dataIndex: 'receiver', width: 110, render: (v: any) => v || '-' },
            {
              title: '附件', dataIndex: 'scanUrl', width: 110,
              render: (v: any, row: any) =>
                v ? (
                  <a href={`/api/files/${v}`} target="_blank" rel="noreferrer">
                    <PaperClipOutlined /> {row.scanFileName || '附件'}
                  </a>
                ) : (
                  '-'
                ),
            },
            {
              title: '状态', dataIndex: 'status', width: 100,
              render: (v: any) => <Tag color={v === 'SAVED' ? 'green' : 'default'}>{v === 'SAVED' ? '已保存' : '草稿'}</Tag>,
            },
            {
              title: '操作', width: 160, fixed: 'right',
              render: (_: any, row: any) => (
                <Space size={2}>
                  <Button type="link" size="small" onClick={() => startEdit(row)}>编辑</Button>
                  <Popconfirm title="删除后不可恢复，确认删除该收领单？" onConfirm={async () => { await receiptOrderApi.remove(row.id); message.success('已删除'); reload(); }}>
                    <Button type="link" size="small" danger>删除</Button>
                  </Popconfirm>
                </Space>
              ),
            },
          ]}
        />
      </Card>
    );
  }

  // ==================== 编辑视图 ====================

  return (
    <EditorTabPage
      listPath={LIST_PATH}
      title={editingId ? '编辑收领单' : '新增收领单'}
      saving={saving}
      onSave={submit}
      saveText="保存并推送总日报"
    >
      {/* ==================== 基本信息（动态表单 + 互锁） ==================== */}
      <Card size="small" title="基本信息" style={{ marginBottom: 12 }}>
        <Form form={headerForm} layout="vertical">
          {/*
            隐藏字段：useWatch 只能监听已注册的字段。
            supplierType / receivingUnitType 由弹窗选择时写入，用于驱动条件渲染与互锁。
          */}
          <Form.Item name="supplierType" hidden><Input /></Form.Item>
          <Form.Item name="receivingUnitType" hidden><Input /></Form.Item>
          <Form.Item name="supplierName" hidden><Input /></Form.Item>
          <Form.Item name="receivingUnitName" hidden><Input /></Form.Item>
          <Form.Item name="supplySubcontractName" hidden><Input /></Form.Item>
          <Form.Item name="subcontractName" hidden><Input /></Form.Item>
          <Form.Item name="subcontractorId" hidden><Input /></Form.Item>
          <Form.Item name="scanUrl" hidden><Input /></Form.Item>
          <Form.Item name="scanFileName" hidden><Input /></Form.Item>
          <Row gutter={16}>
            {/* ---- 供应单位 ---- */}
            <Col xs={24} md={12}>
              <Form.Item
                name="supplierId"
                label="供应单位"
                rules={[{ required: true, message: '请选择供应单位' }]}
              >
                <Space.Compact style={{ width: '100%' }}>
                  <Select
                    disabled
                    placeholder="请点击「查询」选择供应单位"
                    style={{ flex: 1 }}
                    value={watchSupplierId}
                    options={watchSupplierId ? [{ value: watchSupplierId, label: watchSupplierName }] : []}
                  />
                  <Button icon={<SelectOutlined />} onClick={() => setSupplierPickerOpen(true)}>查询</Button>
                </Space.Compact>
              </Form.Item>
            </Col>

            {/* 供应单位 = 供应商 → 物资合同；分包商 → 供应分包合同；项目类 → 都隐藏 */}
            {showMaterialContract && (
              <Col xs={24} md={12}>
                <Form.Item
                  name="materialContractId"
                  label="物资合同"
                  rules={[{ required: true, message: '请选择物资合同' }]}
                >
                  <Select
                    showSearch
                    allowClear
                    optionFilterProp="label"
                    placeholder="请选择物资合同（该供应商在本项目的合同；选择后带出物料清单）"
                    options={contracts.map((c: any) => ({ value: c.id, label: `${c.code || ''} ${c.name || ''}`.trim() }))}
                    onChange={onContractChange}
                  />
                </Form.Item>
              </Col>
            )}

            {/* 关联结算单不在收领单维护（业务 2026-10-17）：由「生成本期结算」在结算单页面抓取关联；
                服务端仍按「物资合同 + 日期所在月」自动匹配落库 */}

            {showSupplySubcontract && (
              <Col xs={24} md={12}>
                <Form.Item
                  name="supplySubcontractId"
                  label="分包合同"
                  rules={[{ required: true, message: '供应单位为分包商时，请选择分包合同' }]}
                >
                  <Select
                    showSearch
                    allowClear
                    optionFilterProp="label"
                    placeholder={supplySubContracts.length ? '请选择分包合同（该分包商在本项目的合同）' : '请先选择分包商'}
                    options={supplySubContracts.map((c: any) => ({ value: c.id, label: `${c.code || ''} ${c.name || ''}`.trim() }))}
                    onChange={(v) => {
                      const hit = supplySubContracts.find((c: any) => c.id === v);
                      headerForm.setFieldValue('supplySubcontractName', hit?.name || null);
                    }}
                  />
                </Form.Item>
              </Col>
            )}

            {/* ---- 领用单位 ---- */}
            <Col xs={24} md={12}>
              <Form.Item
                name="receivingUnitId"
                label="领用单位"
                rules={[{ required: true, message: '请选择领用单位' }]}
              >
                <Space.Compact style={{ width: '100%' }}>
                  <Select
                    disabled
                    placeholder="请点击「查询」选择领用单位"
                    style={{ flex: 1 }}
                    value={watchReceivingUnitId}
                    options={watchReceivingUnitId ? [{ value: watchReceivingUnitId, label: watchReceivingUnitName }] : []}
                  />
                  <Button icon={<SelectOutlined />} onClick={() => setUnitPickerOpen(true)}>查询</Button>
                </Space.Compact>
              </Form.Item>
            </Col>

            {/* 领用单位 = 分包商 → 分包合同（必填）；本项目/其他项目 → 隐藏 */}
            {showReceiveSubcontract && (
              <Col xs={24} md={12}>
                <Form.Item
                  name="subcontractId"
                  label="分包合同"
                  rules={[{ required: true, message: '领用单位为分包商时，请选择分包合同' }]}
                >
                  <Select
                    showSearch
                    allowClear
                    optionFilterProp="label"
                    placeholder={receiveSubContracts.length ? '请选择分包合同（由分包商自动带出）' : '请先选择分包商'}
                    options={receiveSubContracts.map((c: any) => ({ value: c.id, label: `${c.code || ''} ${c.name || ''}`.trim() }))}
                    onChange={(v) => {
                      const hit = receiveSubContracts.find((c: any) => c.id === v);
                      headerForm.setFieldValue('subcontractName', hit?.name || null);
                    }}
                  />
                </Form.Item>
              </Col>
            )}

            <Col xs={24} md={12}>
              <Form.Item name="orderNo" label="收领单编号" rules={[{ required: true, message: '缺少收领单编号' }]}>
                <Input readOnly placeholder="自动生成" />
              </Form.Item>
            </Col>

            {/* 表头「是否为资产」（业务 2026-10-17）：N=整单不入资产台账；
                Y=推送总日报+资产台账，且明细显示「保管单位及保管人」列 */}
            <Col xs={24} md={12}>
              <Form.Item name="isAssetFlag" label="是否为资产" rules={[{ required: true, message: '请选择是否为资产' }]}>
                <Select allowClear placeholder="请选择是否为资产" options={YES_NO} />
              </Form.Item>
            </Col>

            <Col xs={24} md={12}>
              <Form.Item name="orderDate" label="日期" rules={[{ required: true, message: '请选择日期' }]}>
                <DatePicker format="YYYY-MM-DD" style={{ width: '100%' }} placeholder="yyyy-mm-dd" />
              </Form.Item>
            </Col>

            {/* 需求 2.1.2：收领单不再维护「是否资产」「是否安全物资」，改由物资基础库统一维护 */}

            {/* 领料人：领用单位为分包商时为下拉（取分包商材料授权人），否则为手工输入 */}
            <Col xs={24} md={12}>
              <Form.Item name="receiver" label="领料人">
                {showReceiveSubcontract ? (
                  <Select
                    showSearch
                    allowClear
                    optionFilterProp="label"
                    placeholder="请选择领料人（分包商材料授权人）"
                    options={receiverOptions.map((r) => ({ value: r, label: r }))}
                  />
                ) : (
                  <Input maxLength={50} allowClear placeholder="最长 50 字符" />
                )}
              </Form.Item>
            </Col>

            <Col xs={24} md={12}>
              <Form.Item name="remark" label="备注">
                <Input maxLength={200} allowClear placeholder="选填" />
              </Form.Item>
            </Col>
          </Row>
        </Form>
      </Card>

      {/* ==================== 附件（收领单扫描件；归档到「5.物资结算/收领单」） ==================== */}
      <Card size="small" title="附件（收领单扫描件）" style={{ marginBottom: 12 }}>
        <Space wrap>
          <Upload
            name="files"
            multiple={false}
            showUploadList={false}
            accept=".jpg,.jpeg,.png,.pdf"
            customRequest={async (options: any) => {
              setUploadingScan(true);
              try {
                const arr = await fileApi.upload([options.file as File]);
                headerForm.setFieldsValue({ scanUrl: arr?.[0]?.url, scanFileName: arr?.[0]?.fileName });
                message.success(`「${arr?.[0]?.fileName}」上传成功`);
                options.onSuccess?.(arr?.[0]);
              } catch (e) {
                options.onError?.(e);
              } finally {
                setUploadingScan(false);
              }
            }}
          >
            <Button icon={<UploadOutlined />} loading={uploadingScan}>
              {watchScanUrl ? '重新上传' : '上传扫描件'}
            </Button>
          </Upload>
          {watchScanUrl ? (
            <Space size={4}>
              <PaperClipOutlined />
              <a href={watchScanUrl} target="_blank" rel="noreferrer">{watchScanFileName || '附件'}</a>
              <Popconfirm
                title="确认删除该附件？"
                okText="删除"
                okType="danger"
                onConfirm={() => headerForm.setFieldsValue({ scanUrl: null, scanFileName: null })}
              >
                <Button type="link" size="small" danger>删除</Button>
              </Popconfirm>
            </Space>
          ) : (
            <span style={{ color: 'var(--cms-muted-soft)' }}>未上传（jpg/png/pdf；项目资料归档时归入「5.物资结算/收领单」）</span>
          )}
        </Space>
      </Card>

      {/* ==================== 物资明细 ==================== */}
      <Card size="small" title="物资明细">
        <Space wrap style={{ marginBottom: 12 }}>
          <Button danger icon={<DeleteOutlined />} onClick={removeSelected}>删除</Button>
          <Input
            allowClear placeholder="物资名称" style={{ width: 180 }}
            value={matKeyword} onChange={(e) => setMatKeyword(e.target.value)}
          />
          <Input
            allowClear placeholder="规格型号" style={{ width: 180 }}
            value={specKeyword} onChange={(e) => setSpecKeyword(e.target.value)}
          />
          <Button icon={<SearchOutlined />} onClick={() => undefined}>查询</Button>
          {watchMaterialContractId && (
            <Tooltip title="按当前物资合同重新带出物料清单">
              <Button icon={<SyncOutlined />} loading={loadingDetails} onClick={() => onContractChange(watchMaterialContractId)}>
                重新加载清单
              </Button>
            </Tooltip>
          )}
          <span style={{ marginLeft: 'auto' }}>
            合计（暂定含税）：<b>{fmtMoney(totalAmount)}</b>，共 <b>{details.length}</b> 行
          </span>
        </Space>

        <Table
          rowKey="key"
          size="small"
          loading={loadingDetails}
          dataSource={visibleDetails}
          pagination={false}
          scroll={{ x: 2700 }}
          locale={{ emptyText: '暂无数据...' }}
          rowSelection={{ selectedRowKeys, onChange: setSelectedRowKeys }}
          columns={DETAIL_COLUMNS(patchDetail, watchIsAssetFlag === 'Y')}
        />

        {details.length > 0 && visibleDetails.length === 0 && (
          <Alert type="info" showIcon style={{ marginTop: 12 }} message="当前筛选条件下没有匹配的物料，请调整物资名称 / 规格型号关键词。" />
        )}

        {!details.length && showMaterialContract && (
          <Alert type="info" showIcon style={{ marginTop: 12 }} message="请先选择物资合同，系统会自动带出该合同下的物资清单。" />
        )}
        {!details.length && showSupplySubcontract && (
          <Alert type="warning" showIcon style={{ marginTop: 12 }} message="供应单位为分包商时没有物资合同，明细需通过其他方式补充或改为供应商场景。" />
        )}
      </Card>

      {/* ==================== 查询弹窗（供应 4 Tab / 领用 3 Tab） ==================== */}
      <TabPickerModal
        open={supplierPickerOpen}
        title="选择供应单位"
        tabs={SUPPLIER_TABS}
        defaultTab="SUPPLIER"
        onCancel={() => setSupplierPickerOpen(false)}
        onLoad={loadPartyOptions}
        onPick={onPickSupplier}
        columnsFor={supplierColumns}
      />

      <TabPickerModal
        open={unitPickerOpen}
        title="选择领用单位"
        tabs={RECEIVING_TABS}
        defaultTab="SUBCONTRACTOR"
        onCancel={() => setUnitPickerOpen(false)}
        onLoad={loadReceivingOptions}
        onPick={onPickReceiving}
        columnsFor={receivingColumns}
      />
    </EditorTabPage>
  );
}
