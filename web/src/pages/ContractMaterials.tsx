import { useEffect, useMemo, useState } from 'react';
import { withToken } from '../utils/download';
import {
  Card, Table, Button, Form, Input, Space, Modal, Popconfirm, message, InputNumber, Select, Descriptions, Alert, Tag,
} from 'antd';
import { PlusOutlined, ExportOutlined, ArrowUpOutlined, ArrowDownOutlined, SwapOutlined, ReloadOutlined, SearchOutlined } from '@ant-design/icons';
import { contractMaterialApi, materialApi } from '@/api/modules';
import { contractApi, supplierApi } from '@/api/business';
import ImportButton from '@/components/ImportButton';

/** 前端实时计算（与服务端同口径：4 位小数） */
const round4 = (n: number) => Math.round((n + Number.EPSILON) * 10000) / 10000;
const fmtNum = (v: any, digits = 4) =>
  v == null || v === '' ? '-' : Number(v).toLocaleString('zh-CN', { maximumFractionDigits: digits });

/**
 * 合同物资清单（需求修正3）
 * - 默认展示当前项目下**所有合同**的物资清单（按行平铺）
 * - 支持供应商名称 / 合同物资名称 / 合同编号 多条件组合筛选（查询/重置）
 * - 选中具体合同后进入单合同维护视图（添加/派生/导入/排序等操作仍按合同维度）
 */
export default function ContractMaterials() {
  const [contracts, setContracts] = useState<any[]>([]);
  const [suppliers, setSuppliers] = useState<any[]>([]);
  const [contractId, setContractId] = useState<string>();
  const [header, setHeader] = useState<any>(null);
  const [rows, setRows] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);

  // 筛选（全项目视图）
  const [filters, setFilters] = useState<{ supplierName?: string; materialName?: string; contractCode?: string }>({});
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);
  const [total, setTotal] = useState(0);
  const [filterForm] = Form.useForm();

  // 行编辑弹窗
  const [modal, setModal] = useState(false);
  const [saving, setSaving] = useState(false);
  const [editing, setEditing] = useState<any>(null); // 行对象（编辑时）
  const [picked, setPicked] = useState<any>(null); // 选中基础物资
  const [form] = Form.useForm();

  // 选料弹窗（单个添加）
  const [pickerOpen, setPickerOpen] = useState(false);
  const [pickerKeyword, setPickerKeyword] = useState('');
  const [baseList, setBaseList] = useState<any[]>([]);
  const [baseLoading, setBaseLoading] = useState(false);

  // 派生弹窗（多选派生）
  const [deriveOpen, setDeriveOpen] = useState(false);
  const [deriveIds, setDeriveIds] = useState<string[]>([]);
  const [deriveSubmitting, setDeriveSubmitting] = useState(false);

  const contractMap = useMemo(
    () => Object.fromEntries((contracts || []).map((c: any) => [c.id, c])),
    [contracts],
  );

  /** 行数据补齐合同维度字段（单合同视图下从 header/合同下拉补齐） */
  const enrich = (list: any[]) =>
    (list || []).map((r: any) => ({
      ...r,
      contractCode: r.contract?.code || header?.code || contractMap[r.contractId]?.code || '-',
      contractName: r.contract?.name || header?.name || contractMap[r.contractId]?.name || '-',
      supplierName:
        r.contract?.supplier?.name || header?.supplierName || contractMap[r.contractId]?.supplierName || '-',
    }));

  const loadRows = async (
    cid: string | undefined = contractId,
    f: typeof filters = filters,
    p = page,
    ps = pageSize,
  ) => {
    setLoading(true);
    try {
      if (cid) {
        const res: any = await contractMaterialApi.list(cid);
        setHeader(res?.contract || null);
        const list = enrich(res?.list || []);
        setRows(list);
        setTotal(list.length);
      } else {
        setHeader(null);
        const res: any = await contractMaterialApi.listAll({
          ...f,
          page: p,
          pageSize: ps,
        });
        const data = res?.data ?? res;
        const list = enrich(data?.list || []);
        setRows(list);
        setTotal(data?.total ?? list.length);
      }
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    contractApi.options().then((res: any) => setContracts(res || []));
    supplierApi.options().then((res: any) => setSuppliers(res || []));
  }, []);

  useEffect(() => {
    loadRows();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [contractId, page, pageSize]);

  const loadBases = (keyword: string) => {
    setBaseLoading(true);
    materialApi.options(keyword)
      .then((res: any) => setBaseList(res || []))
      .finally(() => setBaseLoading(false));
  };

  const openPicker = () => {
    setPickerKeyword('');
    loadBases('');
    setPickerOpen(true);
  };

  // ---------- 筛选 ----------
  const handleSearch = () => {
    setPage(1);
    loadRows(contractId || undefined, filters, 1, pageSize);
  };

  const handleReset = () => {
    filterForm.resetFields();
    setFilters({});
    setPage(1);
    loadRows(contractId || undefined, {}, 1, pageSize);
  };

  // ---------- 行编辑 ----------
  const openEdit = (row?: any) => {
    if (!contractId) return message.warning('请先在上方选择合同，再维护该合同的物资清单');
    setEditing(row || null);
    setPicked(row?.materialBase || null);
    form.resetFields();
    if (row) {
      form.setFieldsValue({
        unit: row.unit, qty: row.qty, priceBeforeTax: row.priceBeforeTax,
        taxRatePct: row.taxRatePct, remark: row.remark, sortOrder: row.sortOrder,
      });
    }
    setModal(true);
  };

  const pickMaterial = (m: any) => {
    // 同合同内重复校验（添加时）
    if (!editing && rows.some((r) => r.materialBaseId === m.id)) {
      message.warning(`「${m.name} / ${m.spec}」已在当前合同清单中，同一物资只能出现一次`);
      return;
    }
    setPicked(m);
    setPickerOpen(false);
  };

  const reload = () => loadRows(contractId || undefined, filters, page, pageSize);

  const submit = async () => {
    const values = await form.validateFields();
    setSaving(true);
    try {
      if (editing) {
        await contractMaterialApi.update(editing.id, values);
      } else {
        if (!picked) return message.warning('请先从物资基础库中选择物资');
        await contractMaterialApi.create({ ...values, contractId, materialBaseId: picked.id });
      }
      message.success('保存成功');
      setModal(false);
      setEditing(null);
      setPicked(null);
      reload();
    } finally {
      setSaving(false);
    }
  };

  const removeRow = async (row: any) => {
    await contractMaterialApi.remove(row.id);
    message.success('已删除');
    reload();
  };

  const moveRow = async (index: number, dir: -1 | 1) => {
    const target = index + dir;
    if (target < 0 || target >= rows.length) return;
    const a = rows[index];
    const b = rows[target];
    await contractMaterialApi.sort([
      { id: a.id, sortOrder: b.sortOrder },
      { id: b.id, sortOrder: a.sortOrder },
    ]);
    reload();
  };

  const doDerive = async () => {
    if (!contractId) return message.warning('请先选择合同');
    if (!deriveIds.length) return message.warning('请选择要派生的物资');
    setDeriveSubmitting(true);
    try {
      const res: any = await contractMaterialApi.derive(contractId, deriveIds);
      message.success(`派生完成：已按所选物资重新生成 ${res?.created || 0} 行清单（请补录数量/单价，税率将自动继承合同税率）`);
      setDeriveOpen(false);
      setDeriveIds([]);
      reload();
    } finally {
      setDeriveSubmitting(false);
    }
  };

  // 编辑弹窗中的实时计算预览（Form.useWatch 跟随输入实时更新）
  const watched: any = Form.useWatch((values: any) => values, form) || {};
  const preview = useMemo(() => {
    const qty = watched.qty;
    const p = watched.priceBeforeTax;
    const pct = watched.taxRatePct;
    const withTax = p != null ? round4(Number(p) * (1 + (Number(pct) || 0) / 100)) : null;
    const total = withTax != null && qty != null ? round4(Number(qty) * withTax) : null;
    return { withTax, total };
  }, [watched]);

  return (
    <Card
      title="合同物资清单"
      extra={
        <Space>
          <ImportButton
            moduleName="合同物资清单"
            templateUrl={contractMaterialApi.templateUrl()}
            uploadUrl={contractId ? contractMaterialApi.importUrl(contractId) : ''}
            disabled={!contractId}
            onDone={reload}
            extraHint="物资名称 + 规格型号须与物资基础库一致。"
          />
          <Button
            icon={<ExportOutlined />}
            disabled={!contractId}
            onClick={() => window.open(withToken(contractMaterialApi.exportUrl(contractId!, 'xlsx')))}
          >
            导出 Excel
          </Button>
          <Button
            icon={<ExportOutlined />}
            disabled={!contractId}
            onClick={() => window.open(withToken(contractMaterialApi.exportUrl(contractId!, 'csv')))}
          >
            导出 CSV
          </Button>
          <Button
            icon={<SwapOutlined />}
            disabled={!contractId}
            onClick={() => { setDeriveIds([]); loadBases(''); setDeriveOpen(true); }}
          >
            从物资库派生
          </Button>
          <Button type="primary" icon={<PlusOutlined />} disabled={!contractId} onClick={() => openEdit()}>添加物资</Button>
        </Space>
      }
    >
      {/* 筛选区（需求修正3）：供应商名称 / 合同物资名称 / 合同编号，支持组合与重置 */}
      <Form form={filterForm} layout="inline" style={{ marginBottom: 12, rowGap: 8 }}>
        <Form.Item name="supplierName" label="供应商名称">
          <Select
            showSearch
            allowClear
            optionFilterProp="label"
            placeholder="选择或输入关键词"
            style={{ width: 200 }}
            options={suppliers.map((s: any) => ({ value: s.name, label: s.name }))}
            onChange={(v) => setFilters((prev) => ({ ...prev, supplierName: v || undefined }))}
          />
        </Form.Item>
        <Form.Item name="materialName" label="合同物资名称">
          <Input
            allowClear
            placeholder="物资名称关键词"
            style={{ width: 180 }}
            onChange={(e) => setFilters((prev) => ({ ...prev, materialName: e.target.value || undefined }))}
            onPressEnter={handleSearch}
          />
        </Form.Item>
        <Form.Item name="contractCode" label="合同编号">
          <Input
            allowClear
            placeholder="合同编号关键词"
            style={{ width: 200 }}
            onChange={(e) => setFilters((prev) => ({ ...prev, contractCode: e.target.value || undefined }))}
            onPressEnter={handleSearch}
          />
        </Form.Item>
        <Form.Item>
          <Space>
            <Button type="primary" icon={<SearchOutlined />} onClick={handleSearch}>查询</Button>
            <Button icon={<ReloadOutlined />} onClick={handleReset}>重置</Button>
          </Space>
        </Form.Item>
      </Form>

      {/* 合同切换（可选：进入单合同维护视图） */}
      <Space style={{ marginBottom: 16 }} wrap>
        <Select
          showSearch
          optionFilterProp="label"
          placeholder="按合同查看 / 维护（可留空查看全部）"
          allowClear
          style={{ minWidth: 360 }}
          value={contractId}
          onChange={(v) => { setContractId(v); setPage(1); }}
          options={contracts.map((c) => ({ value: c.id, label: `${c.code || ''} ${c.name || ''}`.trim() }))}
        />
      </Space>

      {header && (
        <Descriptions
          size="small"
          bordered
          column={3}
          style={{ marginBottom: 16 }}
          items={[
            { key: 'code', label: '合同编号', children: header.code || '-' },
            { key: 'project', label: '项目名称', children: header.projectName || '-' },
            { key: 'supplier', label: '供应商名称', children: header.supplierName || '-' },
          ]}
        />
      )}

      {!contractId && (
        <Alert
          type="info"
          showIcon
          style={{ marginBottom: 12 }}
          message="当前展示项目下所有合同的物资清单；可按供应商名称 / 合同物资名称 / 合同编号组合筛选。选择具体合同后可维护该合同清单（添加/派生/导入/排序）。"
        />
      )}

      <Table
        rowKey="id"
        loading={loading}
        dataSource={rows}
        pagination={
          contractId
            ? false
            : {
                current: page,
                pageSize,
                total,
                showSizeChanger: true,
                showTotal: (t: number) => `共 ${t} 条`,
                onChange: (p, ps) => { setPage(p); setPageSize(ps); },
              }
        }
        scroll={{ x: 1800 }}
        locale={{ emptyText: contractId ? '当前合同暂无物资清单，可「从物资库派生」或「添加物资」' : '暂无合同物资清单数据' }}
        columns={[
          { title: '序号', width: 70, fixed: 'left', render: (_, __, i) => (contractId ? i + 1 : (page - 1) * pageSize + i + 1) },
          { title: '合同编号', dataIndex: 'contractCode', width: 200, fixed: 'left', render: (v) => v || '-' },
          { title: '合同名称', dataIndex: 'contractName', width: 200, ellipsis: true, render: (v) => v || '-' },
          { title: '供应商名称', dataIndex: 'supplierName', width: 170, ellipsis: true, render: (v) => v || '-' },
          { title: '物资名称', width: 180, render: (_, r) => r.materialBase?.name || '-' },
          { title: '规格型号', width: 150, render: (_, r) => r.materialBase?.spec || '-' },
          { title: '计量单位', dataIndex: 'unit', width: 100 },
          { title: '暂定数量', dataIndex: 'qty', width: 120, align: 'right', render: (v) => fmtNum(v) },
          { title: '税前单价', dataIndex: 'priceBeforeTax', width: 130, align: 'right', render: (v) => fmtNum(v, 2) },
          { title: '税率(%)', dataIndex: 'taxRatePct', width: 100, align: 'right', render: (v) => (v == null ? '-' : `${Number(v).toFixed(2)}`) },
          { title: '含税单价（自动）', dataIndex: 'priceWithTax', width: 150, align: 'right', render: (v) => <Tag color="geekblue">{fmtNum(v, 2)}</Tag> },
          { title: '暂定含税合价（自动）', dataIndex: 'totalWithTax', width: 170, align: 'right', render: (v) => <Tag color="geekblue">{fmtNum(v, 2)}</Tag> },
          { title: '备注', dataIndex: 'remark', width: 160, ellipsis: true, render: (v) => v || '-' },
          {
            title: '操作',
            width: 200,
            fixed: 'right',
            render: (_, row, i) => (
              <Space size={2}>
                <Button type="link" size="small" icon={<ArrowUpOutlined />} disabled={!contractId || i === 0} onClick={() => moveRow(i, -1)} />
                <Button type="link" size="small" icon={<ArrowDownOutlined />} disabled={!contractId || i === rows.length - 1} onClick={() => moveRow(i, 1)} />
                <Button type="link" size="small" disabled={!contractId} onClick={() => openEdit(row)}>编辑</Button>
                <Popconfirm title="删除该行不影响物资基础库，确认删除？" onConfirm={() => removeRow(row)}>
                  <Button type="link" size="small" danger disabled={!contractId}>删除</Button>
                </Popconfirm>
              </Space>
            ),
          },
        ]}
      />

      {/* 行编辑弹窗 */}
      <Modal
        title={editing ? '编辑清单行' : '添加清单行'}
        open={modal}
        onOk={submit}
        onCancel={() => { setModal(false); setEditing(null); setPicked(null); }}
        confirmLoading={saving}
        width={680}
        destroyOnClose
        forceRender
      >
        <Form form={form} layout="vertical">
          <Form.Item label="物资（来自基础库，只读）" required>
            {picked ? (
              <Space wrap>
                <Tag color="blue">{picked.name}</Tag>
                <span>规格：{picked.spec}</span>
                {!editing && <Button size="small" onClick={openPicker}>重新选择</Button>}
              </Space>
            ) : (
              <Button type="primary" ghost onClick={openPicker}>从物资基础库选择</Button>
            )}
          </Form.Item>
          <Space size={16} wrap>
            <Form.Item name="unit" label="计量单位" rules={[{ required: true, message: '如 吨/台/米' }]} style={{ width: 140 }}>
              <Input placeholder="吨/台/米" />
            </Form.Item>
            <Form.Item name="qty" label="暂定数量" style={{ width: 160 }}>
              <InputNumber style={{ width: '100%' }} min={0} precision={4} />
            </Form.Item>
            <Form.Item name="priceBeforeTax" label="税前单价" style={{ width: 160 }}>
              <InputNumber style={{ width: '100%' }} min={0} precision={4} />
            </Form.Item>
            <Form.Item name="taxRatePct" label="税率 (%，留空继承合同税率)" style={{ width: 200 }}>
              <InputNumber style={{ width: '100%' }} min={0} max={100} precision={2} placeholder="留空自动继承" />
            </Form.Item>
            <Form.Item name="sortOrder" label="序号" style={{ width: 120 }}>
              <InputNumber style={{ width: '100%' }} precision={0} />
            </Form.Item>
          </Space>
          <Form.Item name="remark" label="备注"><Input.TextArea rows={2} /></Form.Item>
          <Alert
            type="info"
            showIcon={false}
            message={
              <span>
                实时计算预览：含税单价 <b>{fmtNum(preview.withTax, 2)}</b>，
                暂定含税合价 <b>{fmtNum(preview.total, 2)}</b>（保存时以服务端计算为准）
              </span>
            }
          />
        </Form>
      </Modal>

      {/* 选料弹窗（单个） */}
      <Modal
        title="从物资基础库选择物资"
        open={pickerOpen}
        onCancel={() => setPickerOpen(false)}
        footer={null}
        width={760}
        destroyOnClose
      >
        <Input.Search
          placeholder="搜索物资名称/规格/MDM/DSC编码"
          allowClear
          enterButton
          onSearch={(v) => loadBases(v)}
          onChange={(e) => { if (e.target.value) return; setPickerKeyword(''); loadBases(''); }}
          style={{ marginBottom: 12 }}
        />
        <Table
          rowKey="id"
          size="small"
          loading={baseLoading}
          dataSource={baseList}
          pagination={{ pageSize: 8 }}
          onRow={(record) => ({ onClick: () => pickMaterial(record), style: { cursor: 'pointer' } })}
          columns={[
            { title: '物资名称', dataIndex: 'name', width: 200 },
            { title: '规格型号', dataIndex: 'spec', width: 160 },
            { title: 'MDM编码', dataIndex: 'mdmCode', width: 140, render: (v) => v || '-' },
            { title: 'DSC编码', dataIndex: 'dscCode', width: 140, render: (v) => v || '-' },
          ]}
        />
        {baseList.length === 0 && !baseLoading && (
          <Alert type="warning" showIcon message="基础库中未找到匹配物资，请先到「物资基础库」页面维护。" />
        )}
      </Modal>

      {/* 派生弹窗（多选） */}
      <Modal
        title="从物资基础库派生合同清单"
        open={deriveOpen}
        onOk={doDerive}
        confirmLoading={deriveSubmitting}
        onCancel={() => setDeriveOpen(false)}
        width={620}
        destroyOnClose
      >
        <Alert
          type="warning"
          showIcon
          style={{ marginBottom: 12 }}
          message="派生将清空当前合同已有清单行，并按所选物资重新编号生成（序号从 1 开始）。税率自动继承合同税率，生成后请补录数量与单价，含税金额将自动计算。"
        />
        <Select
          mode="multiple"
          showSearch
          optionFilterProp="label"
          placeholder="选择要派生的物资（可多选）"
          style={{ width: '100%' }}
          value={deriveIds}
          onChange={setDeriveIds}
          options={baseList.map((m) => ({ value: m.id, label: `${m.name} / ${m.spec}` }))}
        />
      </Modal>
    </Card>
  );
}
