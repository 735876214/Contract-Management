import { useEffect, useState } from 'react';
import { withToken } from '../utils/download';
import {
  Button,
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
} from 'antd';
import { PlusOutlined, ExportOutlined, RollbackOutlined } from '@ant-design/icons';
import dayjs from 'dayjs';
import { settlementApi } from '@/api/modules';
import { dictApi, type DictOption } from '@/api/dict';
import { contractApi } from '@/api/business';
import ModuleListPage, { type ModuleListFilterField, type ModuleListRow } from '@/components/procurement/ModuleListPage';
import ImportButton from '@/components/ImportButton';
import DictSelect, { DictTag } from '@/components/DictSelect';

const money = (v: number) =>
  v == null ? '-' : `¥${Number(v).toLocaleString('zh-CN', { maximumFractionDigits: 2 })}`;

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

/**
 * 结算单页面（问题四：统一标准列表页规约）
 */
export function SettlementOrderPage() {
  const { contracts, contractOptions } = useContractOptions();
  const dicts = useFilterDicts(['settlement_type', 'settlement_status']);
  return <SettlementsTab contractOptions={contractOptions} dicts={dicts} />;
}

/**
 * 结算台账页面（问题四：统一标准列表页规约）
 */
export function SettlementLedgerPage() {
  const { contracts, contractOptions } = useContractOptions();
  const dicts = useFilterDicts(['yes_no']);
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
  const [form] = Form.useForm();
  const [modal, setModal] = useState(false);
  const [editing, setEditing] = useState<any>(null);
  const [listRefresh, setListRefresh] = useState(0);
  const refreshList = () => setListRefresh((k) => k + 1);

  const submit = async () => {
    const v = await form.validateFields();
    const payload = { ...v, settleDate: v.settleDate ? dayjs(v.settleDate).format('YYYY-MM-DD') : null };
    if (editing) await settlementApi.update(editing.id, payload);
    else await settlementApi.create(payload);
    message.success('保存成功');
    setModal(false);
    form.resetFields();
    setEditing(null);
    refreshList();
  };

  const openEdit = (row: any) => {
    setEditing(row);
    form.setFieldsValue({ ...row, settleDate: row.settleDate ? dayjs(row.settleDate) : null });
    setModal(true);
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
  /** 任务 7：结算驳回 → 回填（无审批流，纯状态回退到「草稿」） */
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
      <ModuleListPage
        mode="generic"
        fetcher={(params) => settlementApi.list(params)}
        extraFilters={extraFilters}
        extraColumns={extraColumns}
        refreshKey={listRefresh}
        onEdit={(row) => openEdit(row)}
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
          <Button
            type="primary"
            icon={<PlusOutlined />}
            onClick={() => {
              setEditing(null);
              form.resetFields();
              setModal(true);
            }}
          >
            新增结算单
          </Button>
        }
      />

      <Modal
        title={editing ? '编辑结算单' : '新增结算单'}
        open={modal}
        onOk={submit}
        onCancel={() => setModal(false)}
        width={860}
        destroyOnClose
      >
        <Form form={form} layout="vertical">
          <Row gutter={16}>
            <Col xs={24} md={12}>
              <Form.Item name="code" label="结算单编号" rules={[{ required: true }]}><Input /></Form.Item>
            </Col>
            <Col xs={24} md={12}>
              <Form.Item name="contractId" label="合同" rules={[{ required: true }]}>
                <Select
                  showSearch
                  optionFilterProp="label"
                  allowClear
                  placeholder="请选择合同"
                  options={contractOptions}
                />
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
      </Modal>
    </>
  );
}

function LedgerTab({
  contractOptions,
  dicts,
}: {
  contractOptions: any[];
  dicts: Record<string, DictOption[]>;
}) {
  const [form] = Form.useForm();
  const [modal, setModal] = useState(false);
  const [editing, setEditing] = useState<any>(null);
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

  const submit = async () => {
    const v = await form.validateFields();
    const payload = { ...v };
    if (editing) await settlementApi.updateLedger(editing.id, payload);
    else await settlementApi.createLedger(payload);
    message.success('保存成功');
    setModal(false);
    form.resetFields();
    setEditing(null);
    refreshList();
  };

  const openEdit = (row: any) => {
    setEditing(row);
    form.setFieldsValue(row);
    setModal(true);
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
        fetcher={(params) => settlementApi.ledger(params)}
        extraFilters={extraFilters}
        extraColumns={extraColumns}
        refreshKey={listRefresh}
        onEdit={(row) => openEdit(row)}
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
            <Button
              type="primary"
              icon={<PlusOutlined />}
              onClick={() => {
                setEditing(null);
                form.resetFields();
                setModal(true);
              }}
            >
              新增台账
            </Button>
          </Space>
        }
      />

      <Modal
        title={editing ? '编辑结算台账' : '新增结算台账'}
        open={modal}
        onOk={submit}
        onCancel={() => setModal(false)}
        width={960}
        destroyOnClose
      >
        <Form form={form} layout="vertical">
          <Row gutter={16}>
            <Col xs={24} md={12}>
              <Form.Item name="contractId" label="合同" rules={[{ required: true }]}>
                <Select
                  showSearch
                  optionFilterProp="label"
                  allowClear
                  placeholder="请选择合同"
                  options={contractOptions}
                />
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
            <Col xs={24} md={8}><Form.Item name="factoringDiscount" label="保理贴息（自动抓取资金费用）"><InputNumber style={{ width: '100%' }} min={0} precision={2} disabled /></Form.Item></Col>
            <Col xs={24} md={8}><Form.Item name="overdueInterest" label="逾期利息（自动抓取资金费用）"><InputNumber style={{ width: '100%' }} min={0} precision={2} disabled /></Form.Item></Col>
            <Col xs={24} md={8}><Form.Item name="yearSettleIncome" label="本年结算对应收入"><InputNumber style={{ width: '100%' }} min={0} precision={2} /></Form.Item></Col>
            <Col xs={24} md={8}><Form.Item name="cumSettleIncome" label="开累结算对应收入"><InputNumber style={{ width: '100%' }} min={0} precision={2} /></Form.Item></Col>
            <Col xs={24} md={8}><Form.Item name="isOnAccount" label="是否挂账"><DictSelect typeCode="yes_no" /></Form.Item></Col>
          </Row>
        </Form>
      </Modal>
    </>
  );
}
