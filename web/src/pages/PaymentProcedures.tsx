import { useEffect, useMemo, useState } from 'react';
import { withToken } from '../utils/download';
import { Button, Form, Input, Select, Space, Modal, message, Row, Col, DatePicker, Alert } from 'antd';
import { PlusOutlined } from '@ant-design/icons';
import dayjs from 'dayjs';
import { paymentProcedureApi, docTemplateApi } from '@/api/modules';
import { contractApi } from '@/api/business';
import ModuleListPage, { type ModuleListFilterField, type ModuleListRow } from '@/components/procurement/ModuleListPage';
import EditorTabPage from '@/components/editor/EditorTabPage';
import { useEditorTab, useTabRefresh } from '@/hooks/useTabs';

const money = (v: number) =>
  v == null ? '-' : `¥${Number(v).toLocaleString('zh-CN', { maximumFractionDigits: 2 })}`;

/**
 * 付款手续编制（业务口径 2026-10-16）：数据项为供应商名称 / 开累结算金额 / 开累付款金额 /
 * 付款时间 / 未付款金额。
 *
 * ⚠️ 「开累」两值与未付款金额**由服务端按合同链口径算出并快照**（结算排除草稿、付款排除失败/退款，
 * 与台账/预警同一实现），页面上**只读展示**、表单里不提交 —— 前端算一遍必然与后端漂移，
 * 而且单据要的是"编制当时的口径"，事后补录付款不该改写已出的单据。
 *
 * 列表与「编制/编辑」是同一路由的两种形态（`?editor=new|<id>`），见 `useEditorTab` 的注释。
 */
const LIST_PATH = '/settlement/payment-procedure';

export default function PaymentProcedures() {
  const [contracts, setContracts] = useState<any[]>([]);
  useEffect(() => {
    contractApi.list({ pageSize: 1000 }).then((res: any) => setContracts(res?.list || []));
  }, []);
  const contractOptions = useMemo(
    () => contracts.map((c) => ({ value: c.id, label: `${c.code} ${c.name}` })),
    [contracts],
  );

  const editorTab = useEditorTab(LIST_PATH);
  if (editorTab.isEditor) {
    return <ProcedureEditor contractOptions={contractOptions} seed={editorTab.seed} />;
  }
  return <ProcedureList contractOptions={contractOptions} />;
}

function ProcedureList({ contractOptions }: { contractOptions: any[] }) {
  const editorTab = useEditorTab(LIST_PATH);
  const tabRefresh = useTabRefresh(LIST_PATH);
  const [listRefresh, setListRefresh] = useState(0);
  const refreshList = () => setListRefresh((k) => k + 1);

  const handleRemove = (row: ModuleListRow) => {
    Modal.confirm({
      title: '确认删除该付款手续？',
      okText: '确认删除',
      okType: 'danger',
      onOk: async () => {
        await paymentProcedureApi.remove(row.id);
        message.success('已删除');
        refreshList();
      },
    });
  };

  const extraFilters: ModuleListFilterField[] = [
    { key: 'contractId', label: '合同', control: 'select', options: contractOptions },
    { key: 'keyword', label: '关键词', control: 'input', placeholder: '编号 / 合同 / 供应商' },
  ];

  const extraColumns: any[] = [
    { title: '单据编号', dataIndex: 'code', width: 200, fixed: 'left' },
    { title: '供应商名称', width: 220, render: (_v: any, r: any) => r.supplier?.name || r.contract?.supplier?.name || '-' },
    { title: '合同编号', width: 170, render: (_v: any, r: any) => r.contract?.code || '-' },
    { title: '合同名称', width: 240, ellipsis: true, render: (_v: any, r: any) => r.contract?.name || '-' },
    { title: '开累结算金额', dataIndex: 'settleCumAmount', width: 150, align: 'right', render: money },
    { title: '开累付款金额', dataIndex: 'paidCumAmount', width: 150, align: 'right', render: money },
    {
      title: '未付款金额',
      dataIndex: 'unpaidAmount',
      width: 150,
      align: 'right',
      // 付超了（未付款为负）用错误色标出来 —— 这正是付款手续要暴露的异常
      render: (v: any) =>
        v == null ? '-' : (
          <span style={Number(v) < 0 ? { color: 'var(--cms-error)' } : undefined}>{money(v)}</span>
        ),
    },
    { title: '付款时间', dataIndex: 'payDate', width: 120, render: (v: any) => v?.slice(0, 10) || '-' },
    { title: '备注', dataIndex: 'remark', width: 160, ellipsis: true },
  ];

  return (
    <ModuleListPage
      mode="generic"
      columnConfigKey="paymentProcedure.list"
      fetcher={(params) => paymentProcedureApi.list(params)}
      extraFilters={extraFilters}
      extraColumns={extraColumns}
      refreshKey={listRefresh + tabRefresh}
      onEdit={(row) => editorTab.openEdit(row.id, row)}
      onDelete={handleRemove}
      rowMenuItems={(row: ModuleListRow) => [
        {
          key: 'doc',
          label: '导出付款单',
          // 用「单据模板」里启用中的付款单模板渲染（未配置时后端会明确提示去哪儿配）
          onClick: () => window.open(withToken(docTemplateApi.renderPaymentUrl(row.id))),
        },
      ]}
      toolbarLeft={
        <Space wrap size={8}>
          <Button type="primary" icon={<PlusOutlined />} onClick={() => editorTab.openCreate()}>
            编制付款手续
          </Button>
        </Space>
      }
    />
  );
}

function ProcedureEditor({ contractOptions, seed }: { contractOptions: any[]; seed: unknown }) {
  const [form] = Form.useForm();
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  const editing = seed as any | undefined;

  useEffect(() => {
    if (!editing) return;
    form.setFieldsValue({
      contractId: editing.contractId,
      code: editing.code,
      payDate: editing.payDate ? dayjs(editing.payDate) : null,
      remark: editing.remark,
    });
    setDirty(false);
    // 仅在换记录时回填（form 实例稳定）
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editing]);

  const submit = async () => {
    const v = await form.validateFields();
    const payload = {
      contractId: v.contractId,
      payDate: v.payDate ? dayjs(v.payDate).format('YYYY-MM-DD') : null,
      code: v.code || undefined,
      remark: v.remark ?? null,
    };
    setSaving(true);
    try {
      if (editing) await paymentProcedureApi.update(editing.id, { ...payload, version: editing.version });
      else await paymentProcedureApi.create(payload);
      message.success('保存成功');
    } finally {
      setSaving(false);
    }
  };

  return (
    <EditorTabPage
      listPath={LIST_PATH}
      title={editing ? '编辑付款手续' : '编制付款手续'}
      titleExtra={editing?.code ? <span className="cms-hint">{editing.code}</span> : null}
      saving={saving}
      dirty={dirty}
      onSave={submit}
    >
      <Form form={form} layout="vertical" onValuesChange={() => setDirty(true)}>
        <Alert
          type="info"
          showIcon
          style={{ marginBottom: 16 }}
          message="开累结算 / 开累付款 / 未付款金额由服务端按合同链口径自动取数"
          description="保存时抓取（结算排除草稿、付款排除失败与退款，与结算台账同一口径）并写入单据；单据上的数字是编制当时的快照，事后补录付款不会改写它。"
        />
        <Row gutter={16}>
          <Col xs={24} md={12}>
            <Form.Item name="contractId" label="合同" rules={[{ required: true, message: '请选择合同' }]}>
              <Select showSearch allowClear optionFilterProp="label" placeholder="请选择合同" options={contractOptions} />
            </Form.Item>
          </Col>
          <Col xs={24} md={12}>
            <Form.Item name="code" label="单据编号" extra="留空则自动生成（FK-合同编号-日期）">
              <Input placeholder="自动生成" />
            </Form.Item>
          </Col>
          <Col xs={24} md={12}>
            <Form.Item name="payDate" label="付款时间">
              <DatePicker format="YYYY-MM-DD" style={{ width: '100%' }} />
            </Form.Item>
          </Col>
          {editing && (
            <>
              <Col xs={24} md={8}>
                <Form.Item label="开累结算金额（快照）">
                  <Input readOnly value={money(editing.settleCumAmount)} />
                </Form.Item>
              </Col>
              <Col xs={24} md={8}>
                <Form.Item label="开累付款金额（快照）">
                  <Input readOnly value={money(editing.paidCumAmount)} />
                </Form.Item>
              </Col>
              <Col xs={24} md={8}>
                <Form.Item label="未付款金额（快照）">
                  <Input readOnly value={money(editing.unpaidAmount)} />
                </Form.Item>
              </Col>
            </>
          )}
          <Col xs={24}>
            <Form.Item name="remark" label="备注">
              <Input.TextArea rows={2} />
            </Form.Item>
          </Col>
        </Row>
      </Form>
    </EditorTabPage>
  );
}
