import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { withToken } from '../utils/download';
import {
  Button, Form, Input, Space, Modal, message, InputNumber, Select, Descriptions, Alert, Table, Tag,
} from 'antd';
import { PlusOutlined, ExportOutlined, SwapOutlined, ArrowUpOutlined, ArrowDownOutlined } from '@ant-design/icons';
import { contractMaterialApi, materialApi } from '@/api/modules';
import { contractApi, supplierApi } from '@/api/business';
import ImportButton from '@/components/ImportButton';
import ModuleListPage, { type ModuleListFilterField, type ModuleListRow } from '@/components/procurement/ModuleListPage';

/** 前端实时计算（与服务端同口径：4 位小数） */
const round4 = (n: number) => Math.round((n + Number.EPSILON) * 10000) / 10000;
const fmtNum = (v: any, digits = 4) =>
  v == null || v === '' ? '-' : Number(v).toLocaleString('zh-CN', { maximumFractionDigits: digits });

/**
 * 合同物资清单（需求修正3；问题四：统一标准列表页规约）
 * - 默认展示当前项目下**所有合同**的物资清单（按行平铺）
 * - 筛选区：供应商名称 / 合同物资名称 / 合同编号 多条件组合筛选（查询/重置）
 * - 工具栏：按合同查看/维护切换 + 导入/导出/派生/添加（单合同维度操作需先选中合同）
 * - 行操作：更多 → 上移/下移/编辑/删除（单合同视图可用）
 */
export default function ContractMaterials() {
  const [contracts, setContracts] = useState<any[]>([]);
  const [suppliers, setSuppliers] = useState<any[]>([]);
  const [contractId, setContractId] = useState<string>();
  const [header, setHeader] = useState<any>(null);

  // 列表刷新键（合同切换/保存/删除后 +1 触发重查）
  const [listRefresh, setListRefresh] = useState(0);
  const refreshList = useCallback(() => setListRefresh((k) => k + 1), []);
  /** 当前列表数据副本（用于上移/下移定位行序） */
  const listRef = useRef<any[]>([]);

  // 行编辑弹窗
  const [modal, setModal] = useState(false);
  const [saving, setSaving] = useState(false);
  const [editing, setEditing] = useState<any>(null); // 行对象（编辑时）
  const [picked, setPicked] = useState<any>(null); // 选中基础物资
  const [form] = Form.useForm();

  // 选料弹窗（单个添加）
  const [pickerOpen, setPickerOpen] = useState(false);
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
  const enrich = useCallback(
    (list: any[]) =>
      (list || []).map((r: any) => ({
        ...r,
        contractCode: r.contract?.code || header?.code || contractMap[r.contractId]?.code || '-',
        contractName: r.contract?.name || header?.name || contractMap[r.contractId]?.name || '-',
        supplierName:
          r.contract?.supplier?.name || header?.supplierName || contractMap[r.contractId]?.supplierName || '-',
      })),
    [header, contractMap],
  );

  /** 标准列表数据源：选中合同时按合同查全量（前端分页关闭由返回 total 控制），否则全项目分页查询 */
  const fetcher = useCallback(
    async (params: Record<string, any>) => {
      if (contractId) {
        const res: any = await contractMaterialApi.list(contractId);
        setHeader(res?.contract || null);
        const list = enrich(res?.list || []);
        listRef.current = list;
        return { list, total: list.length };
      }
      setHeader(null);
      const res: any = await contractMaterialApi.listAll({
        supplierName: params.supplierName,
        materialName: params.materialName,
        contractCode: params.contractCode,
        page: params.page,
        pageSize: params.pageSize,
      });
      const data = res?.data ?? res;
      const list = enrich(data?.list || []);
      listRef.current = list;
      return { list, total: data?.total ?? list.length };
    },
    [contractId, enrich],
  );

  useEffect(() => {
    contractApi.options().then((res: any) => setContracts(res || []));
    supplierApi.options().then((res: any) => setSuppliers(res || []));
  }, []);

  const loadBases = (keyword: string) => {
    setBaseLoading(true);
    materialApi.options(keyword)
      .then((res: any) => setBaseList(res || []))
      .finally(() => setBaseLoading(false));
  };

  // ---------- 行编辑 ----------
  const openEdit = (row?: any) => {
    if (!contractId) return message.warning('请先在工具栏选择合同，再维护该合同的物资清单');
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
    if (!editing && listRef.current.some((r) => r.materialBaseId === m.id)) {
      message.warning(`「${m.name} / ${m.spec}」已在当前合同清单中，同一物资只能出现一次`);
      return;
    }
    setPicked(m);
    setPickerOpen(false);
  };

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
      refreshList();
    } finally {
      setSaving(false);
    }
  };

  const removeRow = (row: ModuleListRow) => {
    Modal.confirm({
      title: '删除该清单行？',
      content: '删除该行不影响物资基础库。',
      okText: '确认删除',
      okType: 'danger',
      onOk: async () => {
        await contractMaterialApi.remove(row.id);
        message.success('已删除');
        refreshList();
      },
    });
  };

  const moveRow = async (row: ModuleListRow, dir: -1 | 1) => {
    const rows = listRef.current;
    const index = rows.findIndex((r) => r.id === row.id);
    const target = index + dir;
    if (index < 0 || target < 0 || target >= rows.length) return;
    const a = rows[index];
    const b = rows[target];
    await contractMaterialApi.sort([
      { id: a.id, sortOrder: b.sortOrder },
      { id: b.id, sortOrder: a.sortOrder },
    ]);
    refreshList();
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
      refreshList();
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

  /** 筛选项（问题四：标准筛选区） */
  const extraFilters: ModuleListFilterField[] = [
    {
      key: 'supplierName',
      label: '供应商名称',
      control: 'select',
      options: suppliers.map((s: any) => ({ value: s.name, label: s.name })),
      placeholder: '选择或输入关键词',
    },
    { key: 'materialName', label: '合同物资名称', control: 'input', placeholder: '物资名称关键词' },
    { key: 'contractCode', label: '合同编号', control: 'input', placeholder: '合同编号关键词' },
  ];

  /** 表格列（问题四：generic 模式完整列定义） */
  const extraColumns: any[] = [
    { title: '合同编号', dataIndex: 'contractCode', width: 200, fixed: 'left', render: (v: any) => v || '-' },
    { title: '合同名称', dataIndex: 'contractName', width: 200, ellipsis: true, render: (v: any) => v || '-' },
    { title: '供应商名称', dataIndex: 'supplierName', width: 170, ellipsis: true, render: (v: any) => v || '-' },
    { title: '物资名称', width: 180, render: (_: any, r: any) => r.materialBase?.name || '-' },
    { title: '规格型号', width: 150, render: (_: any, r: any) => r.materialBase?.spec || '-' },
    { title: '计量单位', dataIndex: 'unit', width: 100 },
    { title: '暂定数量', dataIndex: 'qty', width: 120, align: 'right' as const, render: (v: any) => fmtNum(v) },
    { title: '税前单价', dataIndex: 'priceBeforeTax', width: 130, align: 'right' as const, render: (v: any) => fmtNum(v, 2) },
    { title: '税率(%)', dataIndex: 'taxRatePct', width: 100, align: 'right' as const, render: (v: any) => (v == null ? '-' : `${Number(v).toFixed(2)}`) },
    { title: '含税单价（自动）', dataIndex: 'priceWithTax', width: 150, align: 'right' as const, render: (v: any) => <Tag color="geekblue">{fmtNum(v, 2)}</Tag> },
    { title: '暂定含税合价（自动）', dataIndex: 'totalWithTax', width: 170, align: 'right' as const, render: (v: any) => <Tag color="geekblue">{fmtNum(v, 2)}</Tag> },
    { title: '备注', dataIndex: 'remark', width: 160, ellipsis: true, render: (v: any) => v || '-' },
  ];

  return (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      {/* 选中合同时展示合同头信息 */}
      {header && (
        <Descriptions
          size="small"
          bordered
          column={3}
          style={{ marginBottom: 0 }}
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
          style={{ marginBottom: 0 }}
          message="当前展示项目下所有合同的物资清单；可按供应商名称 / 合同物资名称 / 合同编号组合筛选。选择具体合同后可维护该合同清单（上移/下移/编辑/删除/添加/派生/导入）。"
        />
      )}

      <ModuleListPage
        mode="generic"
        fetcher={fetcher}
        extraFilters={extraFilters}
        extraColumns={extraColumns}
        refreshKey={listRefresh}
        emptyText={contractId ? '当前合同暂无物资清单，可「从物资库派生」或「添加物资」' : '暂无合同物资清单数据'}
        rowEditable={() => !!contractId}
        rowDeletable={() => !!contractId}
        onEdit={(row) => openEdit(row)}
        onDelete={removeRow}
        rowMenuItems={(row) => {
          const rows = listRef.current;
          const index = rows.findIndex((r) => r.id === row.id);
          return [
            {
              key: 'moveUp',
              label: (
                <span>
                  <ArrowUpOutlined /> 上移
                </span>
              ),
              disabled: !contractId || index <= 0,
              onClick: () => moveRow(row, -1),
            },
            {
              key: 'moveDown',
              label: (
                <span>
                  <ArrowDownOutlined /> 下移
                </span>
              ),
              disabled: !contractId || index < 0 || index >= rows.length - 1,
              onClick: () => moveRow(row, 1),
            },
          ];
        }}
        toolbarLeft={
          <Space wrap size={8}>
            <Select
              showSearch
              optionFilterProp="label"
              placeholder="按合同查看 / 维护（可留空查看全部）"
              allowClear
              style={{ minWidth: 320 }}
              value={contractId}
              onChange={(v) => { setContractId(v); refreshList(); }}
              options={contracts.map((c) => ({ value: c.id, label: `${c.code || ''} ${c.name || ''}`.trim() }))}
            />
            <ImportButton
              moduleName="合同物资清单"
              templateUrl={contractMaterialApi.templateUrl()}
              uploadUrl={contractId ? contractMaterialApi.importUrl(contractId) : ''}
              disabled={!contractId}
              onDone={refreshList}
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
            <Button type="primary" icon={<PlusOutlined />} disabled={!contractId} onClick={() => openEdit()}>
              添加物资
            </Button>
          </Space>
        }
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
                {!editing && <Button size="small" onClick={() => { loadBases(''); setPickerOpen(true); }}>重新选择</Button>}
              </Space>
            ) : (
              <Button type="primary" ghost onClick={() => { loadBases(''); setPickerOpen(true); }}>从物资基础库选择</Button>
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
          onChange={(e) => { if (e.target.value) return; loadBases(''); }}
          style={{ marginBottom: 12 }}
        />
        <Space direction="vertical" style={{ width: '100%' }}>
          <TableInline baseList={baseList} baseLoading={baseLoading} onPick={pickMaterial} />
          {baseList.length === 0 && !baseLoading && (
            <Alert type="warning" showIcon message="基础库中未找到匹配物资，请先到「物资基础库」页面维护。" />
          )}
        </Space>
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
    </Space>
  );
}

/** 选料弹窗内嵌表格（局部组件，避免与外层标准列表混淆） */
function TableInline({ baseList, baseLoading, onPick }: { baseList: any[]; baseLoading: boolean; onPick: (m: any) => void }) {
  return (
    <Table
      rowKey="id"
      size="small"
      loading={baseLoading}
      dataSource={baseList}
      pagination={{ pageSize: 8 }}
      onRow={(record: any) => ({ onClick: () => onPick(record), style: { cursor: 'pointer' } })}
      columns={[
        { title: '物资名称', dataIndex: 'name', width: 200 },
        { title: '规格型号', dataIndex: 'spec', width: 160 },
        { title: 'MDM编码', dataIndex: 'mdmCode', width: 140, render: (v: any) => v || '-' },
        { title: 'DSC编码', dataIndex: 'dscCode', width: 140, render: (v: any) => v || '-' },
      ]}
    />
  );
}
