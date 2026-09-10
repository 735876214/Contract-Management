import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Alert, Button, Card, Col, DatePicker, Form, Input, InputNumber, Modal, Popconfirm,
  Row, Select, Space, Table, Tag, Tooltip, message,
} from 'antd';
import {
  ArrowLeftOutlined, DeleteOutlined, PlusOutlined, ReloadOutlined, SaveOutlined,
  SearchOutlined, SelectOutlined, SyncOutlined,
} from '@ant-design/icons';
import dayjs from 'dayjs';
import { contractApi, supplierApi, receiptOrderApi } from '@/api/business';
import { useTable } from '@/hooks/useTable';
import DictSelect, { DictTag } from '@/components/DictSelect';

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

/** 生成稳定的行 key（新增行无后端 id 时使用） */
let rowSeq = 0;
const nextKey = () => `tmp-${Date.now()}-${(rowSeq += 1)}`;

// ==================== 通用：名称选择弹窗（供应商 / 领用单位） ====================

interface PickerModalProps {
  open: boolean;
  title: string;
  dataSource: any[];
  loading?: boolean;
  onCancel: () => void;
  onPick: (row: any) => void;
  onSearch: (keyword: string) => void;
}

function NamePickerModal({ open, title, dataSource, loading, onCancel, onPick, onSearch }: PickerModalProps) {
  const [keyword, setKeyword] = useState('');
  useEffect(() => {
    if (open) setKeyword('');
  }, [open]);
  return (
    <Modal title={title} open={open} onCancel={onCancel} footer={null} width={700} destroyOnHidden>
      <Input.Search
        placeholder="输入名称关键词后回车检索"
        allowClear
        enterButton
        value={keyword}
        onChange={(e) => setKeyword(e.target.value)}
        onSearch={(v) => onSearch(v)}
        style={{ marginBottom: 12 }}
      />
      <Table
        rowKey="id"
        size="small"
        loading={loading}
        dataSource={dataSource}
        pagination={{ pageSize: 8, showTotal: (t) => `共 ${t} 条` }}
        onRow={(record) => ({ onClick: () => onPick(record), style: { cursor: 'pointer' } })}
        columns={[
          { title: '名称', dataIndex: 'name', ellipsis: true },
          { title: '统一社会信用代码', dataIndex: 'creditCode', width: 200, render: (v: any) => v || '-' },
          { title: '联系人', dataIndex: 'contactName', width: 120, render: (v: any) => v || '-' },
          { title: '联系电话', dataIndex: 'contactPhone', width: 140, render: (v: any) => v || '-' },
        ]}
      />
    </Modal>
  );
}

// ==================== 主页面 ====================

export default function ReceiptOrders() {
  // -------- 列表视图 --------
  const { loading, list, search, reload, pagination } = useTable<any>((p) => receiptOrderApi.list(p));
  const [filterForm] = Form.useForm();
  const [mode, setMode] = useState<'list' | 'edit'>('list');
  const [editingId, setEditingId] = useState<string | null>(null);

  // -------- 编辑态数据 --------
  const [headerForm] = Form.useForm();
  // headerForm 仅在编辑视图挂载后才与 <Form> 建立连接；
  // 进入编辑态时先把初始值暂存于此，待编辑视图挂载后再写入，避免"未连接"导致赋值丢失。
  const [pendingHeader, setPendingHeader] = useState<Record<string, any> | null>(null);
  // Space.Compact 包裹的 Select 无法被 Form.Item 自动注入 value/onChange，需手工受控
  const watchSupplierId = Form.useWatch('supplierId', headerForm);
  const watchReceivingUnitId = Form.useWatch('receivingUnitId', headerForm);
  const [details, setDetails] = useState<any[]>([]);
  const [selectedRowKeys, setSelectedRowKeys] = useState<React.Key[]>([]);
  const [saving, setSaving] = useState(false);
  const [loadingDetails, setLoadingDetails] = useState(false);

  // 下拉数据源
  const [contracts, setContracts] = useState<any[]>([]);
  const [suppliers, setSuppliers] = useState<any[]>([]);
  const [receivingUnits, setReceivingUnits] = useState<any[]>([]);

  // 弹窗
  const [supplierPickerOpen, setSupplierPickerOpen] = useState(false);
  const [unitPickerOpen, setUnitPickerOpen] = useState(false);
  const [pickerLoading, setPickerLoading] = useState(false);

  // 明细区筛选
  const [matKeyword, setMatKeyword] = useState('');
  const [specKeyword, setSpecKeyword] = useState('');

  useEffect(() => {
    contractApi.options().then((res: any) => setContracts(res || []));
    supplierApi.options().then((res: any) => setSuppliers(res || []));
    // 领用单位：取供应商库全量作为可选数据源（项目内组织/单位未单独建模）
    supplierApi.list({ page: 1, pageSize: 500 }).then((res: any) => setReceivingUnits(res?.list || []));
  }, []);

  // -------- 新建 / 编辑 --------

  const startCreate = async () => {
    setDetails([]);
    setSelectedRowKeys([]);
    setEditingId(null);
    let init: Record<string, any> = { orderDate: dayjs(), isAsset: 'N' };
    try {
      const res: any = await receiptOrderApi.nextNo();
      init = { ...init, orderNo: res?.orderNo };
    } catch {
      /* 编号获取失败时仍允许手工录入 */
    }
    setPendingHeader(init);
    setMode('edit');
  };

  const startEdit = async (row: any) => {
    setEditingId(row.id);
    setSelectedRowKeys([]);
    try {
      const detail: any = await receiptOrderApi.detail(row.id);
      setPendingHeader({
        orderNo: detail.orderNo,
        supplierId: detail.supplierId,
        receivingUnitId: detail.receivingUnitId,
        subcontractId: detail.subcontractId,
        orderDate: detail.orderDate ? dayjs(detail.orderDate) : null,
        receiver: detail.receiver,
        materialContractId: detail.materialContractId,
        materialContractNo: detail.materialContractNo,
        isAsset: detail.isAsset,
        remark: detail.remark,
      });
      setDetails(
        (detail.details || []).map((d: any) => ({
          ...d,
          key: d.id,
          contractQty: d.contractQty == null ? null : Number(d.contractQty),
          deliveryQty: d.deliveryQty == null ? null : Number(d.deliveryQty),
          receivedQty: d.receivedQty == null ? null : Number(d.receivedQty),
          priceBeforeTax: d.priceBeforeTax == null ? null : Number(d.priceBeforeTax),
          taxRate: d.taxRate == null ? null : Number(d.taxRate),
          priceWithTax: d.priceWithTax == null ? null : Number(d.priceWithTax),
          totalPrice: d.totalPrice == null ? null : Number(d.totalPrice),
        })),
      );
      setMode('edit');
    } catch {
      /* 错误已由拦截器提示 */
    }
  };

  /** 选择物资合同 → 自动带出合同编号 + 加载合同物资清单（需求 4.2） */
  const onContractChange = async (contractId: string) => {
    const hit = contracts.find((c) => c.id === contractId);
    headerForm.setFieldsValue({ materialContractNo: hit?.code || '' });
    if (!contractId) {
      setDetails([]);
      return;
    }
    // 已有明细时二次确认，避免误覆盖手填数据
    if (details.length) {
      const ok = await new Promise((resolve) => {
        Modal.confirm({
          title: '重新加载合同物资清单？',
          content: '将按新合同重新带出物料清单，当前已填写的手动数据会被覆盖。',
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
      const res: any = await receiptOrderApi.contractMaterials(contractId);
      const list: any[] = (res?.list || []).map((r: any) => ({ ...r, key: r.key || nextKey() }));
      setDetails(list);
      setSelectedRowKeys([]);
      message.success(`已带出 ${list.length} 条合同物资清单`);
    } finally {
      setLoadingDetails(false);
    }
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
    // 明细校验：至少一行 + 实收数量必填
    if (!details.length) return message.warning('请选择物资合同以带出物资明细');
    const invalid = details.find((d) => d.receivedQty == null || d.receivedQty === '');
    if (invalid) return message.warning(`物资「${invalid.materialName || '-'}」请填写实收数量`);

    const payload: any = {
      ...values,
      orderDate: values.orderDate ? values.orderDate.format('YYYY-MM-DD') : null,
      supplierName: suppliers.find((s) => s.id === values.supplierId)?.name || null,
      receivingUnitName: receivingUnits.find((s) => s.id === values.receivingUnitId)?.name || null,
      subcontractName: contracts.find((c) => c.id === values.subcontractId)?.name || null,
      materialContractNo:
        values.materialContractNo || contracts.find((c) => c.id === values.materialContractId)?.code || null,
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
        brand: d.brand,
        remark: d.remark,
        isSafetyMaterial: d.isSafetyMaterial,
        isAgentPurchase: d.isAgentPurchase,
        sortOrder: i + 1,
      })),
    };

    setSaving(true);
    try {
      const saved: any = editingId
        ? await receiptOrderApi.update(editingId, payload)
        : await receiptOrderApi.create(payload);
      // 保存后推送总日报（需求 4.3）
      const targetId = saved?.id || editingId;
      if (targetId) {
        const pushed = await receiptOrderApi.push(targetId);
        message.success(`保存成功，已推送 ${pushed?.pushed ?? 0} 条明细到总日报`);
      } else {
        message.success('保存成功');
      }
      setMode('list');
      setEditingId(null);
      reload();
    } finally {
      setSaving(false);
    }
  };

  // -------- 明细筛选（前端本地过滤，需求 3.3 顶部工具栏） --------
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

  // 编辑视图挂载后（<Form> 已连接）再写入暂存的表头初值，确保弹窗/下拉选择不丢值
  useEffect(() => {
    if (mode === 'edit' && pendingHeader) {
      headerForm.resetFields();
      headerForm.setFieldsValue(pendingHeader);
      setPendingHeader(null);
    }
  }, [mode, pendingHeader, headerForm]);

  // -------- 列表视图渲染 --------

  if (mode === 'list') {
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
              placeholder="收领单编号 / 供应单位 / 编合同号 / 领料人"
              style={{ width: 260 }}
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
          scroll={{ x: 1400 }}
          locale={{ emptyText: '暂无数据...' }}
          columns={[
            { title: '序号', width: 70, fixed: 'left', render: (_: any, __: any, i: number) => (pagination.current - 1) * pagination.pageSize + i + 1 },
            { title: '收领单编号', dataIndex: 'orderNo', width: 180, fixed: 'left' },
            { title: '日期', dataIndex: 'orderDate', width: 120, render: (v: any) => (v ? String(v).slice(0, 10) : '-') },
            { title: '供应单位', dataIndex: 'supplierName', width: 200, ellipsis: true, render: (v: any) => v || '-' },
            { title: '领用单位', dataIndex: 'receivingUnitName', width: 200, ellipsis: true, render: (v: any) => v || '-' },
            { title: '物资合同编号', dataIndex: 'materialContractNo', width: 190, render: (v: any) => v || '-' },
            { title: '分包合同', dataIndex: 'subcontractName', width: 180, ellipsis: true, render: (v: any) => v || '-' },
            { title: '领料人', dataIndex: 'receiver', width: 110, render: (v: any) => v || '-' },
            { title: '是否资产', dataIndex: 'isAsset', width: 100, render: (v: any) => <DictTag typeCode="yes_no" value={v} /> },
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

  // -------- 编辑视图渲染 --------

  return (
    <Card
      title={
        <Space>
          <Button icon={<ArrowLeftOutlined />} onClick={() => setMode('list')}>返回列表</Button>
          <span>{editingId ? '编辑收领单' : '新增收领单'}</span>
        </Space>
      }
      extra={
        <Space>
          <Button icon={<SaveOutlined />} type="primary" loading={saving} onClick={submit}>
            保存并推送总日报
          </Button>
          <Button onClick={() => { setMode('list'); setEditingId(null); }}>取消</Button>
        </Space>
      }
    >
      {/* ==================== 基本信息（两列布局，不显示二级单位和项目） ==================== */}
      <Card size="small" title="基本信息" style={{ marginBottom: 12 }}>
        <Form form={headerForm} layout="vertical">
          <Row gutter={16}>
            {/* ---- 左列 ---- */}
            <Col xs={24} md={12}>
              <Form.Item
                name="supplierId"
                label="供应单位"
                rules={[{ required: true, message: '请选择供应单位' }]}
              >
                <Space.Compact style={{ width: '100%' }}>
                  <Select
                    showSearch
                    allowClear
                    optionFilterProp="label"
                    placeholder="请选择供应单位"
                    style={{ flex: 1 }}
                    value={watchSupplierId}
                    onChange={(v) => headerForm.setFieldValue('supplierId', v)}
                    options={suppliers.map((s: any) => ({ value: s.id, label: s.name }))}
                  />
                  <Button icon={<SelectOutlined />} onClick={() => setSupplierPickerOpen(true)}>查询</Button>
                </Space.Compact>
              </Form.Item>
            </Col>
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
                  placeholder="请选择物资合同（选择后自动带出编号与物料清单）"
                  options={contracts.map((c: any) => ({ value: c.id, label: `${c.code || ''} ${c.name || ''}`.trim() }))}
                  onChange={onContractChange}
                />
              </Form.Item>
            </Col>

            <Col xs={24} md={12}>
              <Form.Item
                name="receivingUnitId"
                label="领用单位"
                rules={[{ required: true, message: '请选择领用单位' }]}
              >
                <Space.Compact style={{ width: '100%' }}>
                  <Select
                    showSearch
                    allowClear
                    optionFilterProp="label"
                    placeholder="请选择领用单位"
                    style={{ flex: 1 }}
                    value={watchReceivingUnitId}
                    onChange={(v) => headerForm.setFieldValue('receivingUnitId', v)}
                    options={receivingUnits.map((s: any) => ({ value: s.id, label: s.name }))}
                  />
                  <Button icon={<SelectOutlined />} onClick={() => setUnitPickerOpen(true)}>查找</Button>
                </Space.Compact>
              </Form.Item>
            </Col>
            <Col xs={24} md={12}>
              <Form.Item
                name="orderNo"
                label="收领单编号"
                rules={[{ required: true, message: '缺少收领单编号' }]}
              >
                <Input readOnly placeholder="自动生成" />
              </Form.Item>
            </Col>

            <Col xs={24} md={12}>
              <Form.Item
                name="subcontractId"
                label="分包合同"
              >
                <Select
                  showSearch
                  allowClear
                  optionFilterProp="label"
                  placeholder="请选择分包合同"
                  options={contracts.map((c: any) => ({ value: c.id, label: `${c.code || ''} ${c.name || ''}`.trim() }))}
                />
              </Form.Item>
            </Col>
            <Col xs={24} md={12}>
              <Form.Item
                name="materialContractNo"
                label="物资合同编号"
                rules={[{ required: true, message: '请先选择物资合同' }]}
              >
                <Input readOnly placeholder="选择物资合同后自动带出" />
              </Form.Item>
            </Col>

            <Col xs={24} md={12}>
              <Form.Item
                name="orderDate"
                label="日期"
                rules={[{ required: true, message: '请选择日期' }]}
              >
                <DatePicker format="YYYY-MM-DD" style={{ width: '100%' }} placeholder="yyyy-mm-dd" />
              </Form.Item>
            </Col>
            <Col xs={24} md={12}>
              <Form.Item
                name="isAsset"
                label="是否资产"
                rules={[{ required: true, message: '请选择是否资产' }]}
              >
                <Select placeholder="请选择" options={YES_NO} />
              </Form.Item>
            </Col>

            <Col xs={24} md={12}>
              <Form.Item name="receiver" label="领料人">
                <Input maxLength={50} allowClear placeholder="最长 50 字符" />
              </Form.Item>
            </Col>
          </Row>
        </Form>
      </Card>

      {/* ==================== 物资明细 ==================== */}
      <Card size="small" title="物资明细">
        <Space wrap style={{ marginBottom: 12 }}>
          <Button danger icon={<DeleteOutlined />} onClick={removeSelected}>删除</Button>
          <Input
            allowClear
            placeholder="物资名称"
            style={{ width: 180 }}
            value={matKeyword}
            onChange={(e) => setMatKeyword(e.target.value)}
          />
          <Input
            allowClear
            placeholder="规格型号"
            style={{ width: 180 }}
            value={specKeyword}
            onChange={(e) => setSpecKeyword(e.target.value)}
          />
          <Button icon={<SearchOutlined />} onClick={() => undefined}>查询</Button>
          {headerForm.getFieldValue('materialContractId') && (
            <Tooltip title="按当前物资合同重新带出物料清单">
              <Button
                icon={<SyncOutlined />}
                loading={loadingDetails}
                onClick={() => onContractChange(headerForm.getFieldValue('materialContractId'))}
              >
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
          scroll={{ x: 2600 }}
          locale={{ emptyText: '暂无数据...' }}
          rowSelection={{ selectedRowKeys, onChange: setSelectedRowKeys }}
          columns={[
            { title: '序号', width: 60, fixed: 'left', render: (_: any, __: any, i: number) => i + 1 },
            { title: '一级分类', dataIndex: 'categoryLevel1', width: 110, render: (v: any) => v || '-' },
            { title: '二级分类', dataIndex: 'categoryLevel2', width: 110, render: (v: any) => v || '-' },
            { title: '物资名称', dataIndex: 'materialName', width: 160, fixed: 'left', ellipsis: true, render: (v: any) => v || '-' },
            { title: '规格型号', dataIndex: 'specModel', width: 140, ellipsis: true, render: (v: any) => v || '-' },
            { title: '计量单位', dataIndex: 'unit', width: 90, render: (v: any) => v || '-' },
            { title: '合同数量', dataIndex: 'contractQty', width: 110, align: 'right' as const, render: (v: any) => fmtNum(v) },
            {
              title: '送货数量', dataIndex: 'deliveryQty', width: 130,
              render: (v: any, row: any) => (
                <InputNumber
                  style={{ width: '100%' }}
                  min={0}
                  precision={4}
                  value={v}
                  placeholder="填写"
                  onChange={(val) => patchDetail(row.key, 'deliveryQty', val)}
                />
              ),
            },
            {
              title: '实收数量', dataIndex: 'receivedQty', width: 130,
              render: (v: any, row: any) => (
                <InputNumber
                  style={{ width: '100%' }}
                  min={0}
                  precision={4}
                  value={v}
                  placeholder="填写"
                  onChange={(val) => patchDetail(row.key, 'receivedQty', val)}
                />
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
              title: '是否安全物资', dataIndex: 'isSafetyMaterial', width: 140,
              render: (v: any, row: any) => (
                <Select allowClear style={{ width: '100%' }} placeholder="选择" value={v || undefined} options={YES_NO} onChange={(val) => patchDetail(row.key, 'isSafetyMaterial', val)} />
              ),
            },
            {
              title: '是否代购', dataIndex: 'isAgentPurchase', width: 130,
              render: (v: any, row: any) => (
                <Select allowClear style={{ width: '100%' }} placeholder="选择" value={v || undefined} options={YES_NO} onChange={(val) => patchDetail(row.key, 'isAgentPurchase', val)} />
              ),
            },
          ]}
        />

        {details.length > 0 && visibleDetails.length === 0 && (
          <Alert type="info" showIcon style={{ marginTop: 12 }} message="当前筛选条件下没有匹配的物料，请调整物资名称 / 规格型号关键词。" />
        )}
      </Card>

      {/* ==================== 名称选择弹窗 ==================== */}
      <NamePickerModal
        open={supplierPickerOpen}
        title="选择供应单位"
        dataSource={suppliers}
        onCancel={() => setSupplierPickerOpen(false)}
        onSearch={(kw) => {
          setPickerLoading(true);
          supplierApi.list({ page: 1, pageSize: 500, keyword: kw })
            .then((res: any) => setSuppliers(res?.list || []))
            .finally(() => setPickerLoading(false));
        }}
        onPick={(row) => {
          headerForm.setFieldsValue({ supplierId: row.id });
          setSupplierPickerOpen(false);
          message.success(`已选择供应单位：${row.name}`);
        }}
      />

      <NamePickerModal
        open={unitPickerOpen}
        title="选择领用单位"
        dataSource={receivingUnits}
        loading={pickerLoading}
        onCancel={() => setUnitPickerOpen(false)}
        onSearch={(kw) => {
          setPickerLoading(true);
          supplierApi.list({ page: 1, pageSize: 500, keyword: kw })
            .then((res: any) => setReceivingUnits(res?.list || []))
            .finally(() => setPickerLoading(false));
        }}
        onPick={(row) => {
          headerForm.setFieldsValue({ receivingUnitId: row.id });
          setUnitPickerOpen(false);
          message.success(`已选择领用单位：${row.name}`);
        }}
      />
    </Card>
  );
}
