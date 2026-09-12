import { useCallback, useEffect, useState } from 'react';
import { withToken } from '../utils/download';
import {
  Card, Tabs, Table, Button, Form, Input, InputNumber, Select, Space, Modal, Popconfirm,
  message, Statistic, Descriptions, Collapse, Tag, DatePicker, Switch, Alert, Empty,
} from 'antd';
import { PlusOutlined, ExportOutlined, SettingOutlined, QuestionCircleOutlined, DeleteOutlined, EditOutlined } from '@ant-design/icons';
import dayjs from 'dayjs';
import { contractApi } from '@/api/business';
import { financeApi } from '@/api/modules';

const money = (v: any) => (v === null || v === undefined || v === '' ? '-' : Number(v).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
const dateStr = (v: any) => (v ? dayjs(v).format('YYYY-MM-DD') : '-');

const FACTORING_HELP = (
  <ol style={{ margin: 0, paddingLeft: 18, lineHeight: 1.9 }}>
    <li>保理费用明确已含税，签执行合同时要注明。</li>
    <li>保理费用不再给 13 个点税。</li>
    <li>保理费用可谈，不给或者给一定比例，注意谈判。</li>
    <li>每个供应商一个标签页。</li>
    <li>此表为保理费用开累统计，每次办理结算完，当月数据应录入日报。</li>
  </ol>
);

const OVERDUE_HELP = (
  <ol style={{ margin: 0, paddingLeft: 18, lineHeight: 1.9 }}>
    <li>项目必须自己计算逾期，为防止错误，对账前先向供应商索要逾期利息金额。</li>
    <li>一个供应商一个表格，一个月一个标签，月度对账按标签打印，作为附加。</li>
    <li>逾期利息为含税金额，不再给 13 个点税。</li>
    <li>月利率、付款比例、逾期是否宽限根据合同调整（可在「参数设置」中按合同覆盖默认值）。</li>
    <li>仅材料款计算逾期利息，逾期利息、保理贴息等资金费用不计息，不能利滚利。</li>
    <li>逾期天数短可谈判减免：勾选「减免」后利息记 0，备注注明减免。</li>
    <li>付款一定要按逾期起始日期的时间顺序进行分配，并优先分配已逾期的。</li>
    <li>月利率不一定是 0.6%，具体要看合同。</li>
    <li>表格的格式和公式不能改动：逾期利息 = ROUND(计息金额 × 逾期天数 × 月利率 ÷ 30, 2)，逾期天数按 DAYS360。</li>
  </ol>
);

export default function Finance() {
  const [contracts, setContracts] = useState<any[]>([]);
  const [contractId, setContractId] = useState<string>('');
  const [params, setParams] = useState<any>(null);
  const [tab, setTab] = useState('factoring');

  // 保理费用
  const [factoring, setFactoring] = useState<any>({ list: [], totals: {} });
  const [factoringLoading, setFactoringLoading] = useState(false);
  const [factoringModal, setFactoringModal] = useState(false);
  const [factoringForm] = Form.useForm();
  const [factoringEditing, setFactoringEditing] = useState<any>(null);
  const [saving, setSaving] = useState(false);

  // 逾期利息
  const [overdue, setOverdue] = useState<any>({ list: [], stats: {} });
  const [overdueLoading, setOverdueLoading] = useState(false);
  const [overdueModal, setOverdueModal] = useState(false);
  const [overdueEditing, setOverdueEditing] = useState<any>(null);
  const [overdueForm] = Form.useForm();
  const [generateModal, setGenerateModal] = useState(false);
  const [generateForm] = Form.useForm();
  const [paramsModal, setParamsModal] = useState(false);
  const [paramsForm] = Form.useForm();

  useEffect(() => {
    contractApi.options().then((res: any) => setContracts(res || []));
  }, []);

  const loadAll = useCallback(async (cid: string) => {
    if (!cid) return;
    setFactoringLoading(true);
    setOverdueLoading(true);
    try {
      const [p, f, o] = await Promise.all([
        financeApi.contractParams(cid),
        financeApi.factoring(cid),
        financeApi.overdue(cid),
      ]);
      setParams(p);
      setFactoring(f);
      setOverdue(o);
    } finally {
      setFactoringLoading(false);
      setOverdueLoading(false);
    }
  }, []);

  const selectContract = (cid: string) => {
    setContractId(cid);
    setParams(null);
    setFactoring({ list: [], totals: {} });
    setOverdue({ list: [], stats: {} });
    if (cid) loadAll(cid);
  };

  // ==================== 保理费用 ====================
  const submitFactoring = async () => {
    const values = await factoringForm.validateFields();
    setSaving(true);
    try {
      const data = {
        ...values,
        financingDate: values.financingDate ? values.financingDate.format('YYYY-MM-DD') : null,
      };
      if (factoringEditing) await financeApi.updateFactoring(factoringEditing.id, data);
      else await financeApi.createFactoring({ ...data, contractId });
      message.success('保存成功');
      setFactoringModal(false);
      setFactoringEditing(null);
      loadAll(contractId);
    } finally {
      setSaving(false);
    }
  };

  const factoringColumns = [
    { title: '序号', dataIndex: 'seqNo', width: 60 },
    { title: '融资到账时间', dataIndex: 'financingDate', width: 110, render: dateStr },
    { title: '融资金额', dataIndex: 'financingAmount', width: 110, align: 'right' as const, render: money },
    { title: '实际到账金额', dataIndex: 'actualReceipt', width: 120, align: 'right' as const, render: money },
    { title: '融资利息', dataIndex: 'financingInterest', width: 100, align: 'right' as const, render: money },
    { title: '手续费', dataIndex: 'handlingFee', width: 90, align: 'right' as const, render: money },
    { title: '费用合计（含税）', dataIndex: 'totalCost', width: 130, align: 'right' as const, render: (v: any) => <b>{money(v)}</b> },
    { title: '结算月份', dataIndex: 'settlementMonth', width: 100 },
    { title: '备注', dataIndex: 'remark', ellipsis: true, render: (v: any) => v || '-' },
    {
      title: '操作', width: 100, fixed: 'right' as const,
      render: (_: any, row: any) => (
        <Space size={0}>
          <Button type="link" size="small" icon={<EditOutlined />} onClick={() => { setFactoringEditing(row); factoringForm.setFieldsValue({ ...row, financingDate: row.financingDate ? dayjs(row.financingDate) : null }); setFactoringModal(true); }}>编辑</Button>
          <Popconfirm title="确认删除该保理费用记录？" onConfirm={async () => { await financeApi.removeFactoring(row.id); message.success('已删除'); loadAll(contractId); }}>
            <Button type="link" size="small" danger icon={<DeleteOutlined />} />
          </Popconfirm>
        </Space>
      ),
    },
  ];

  // ==================== 逾期利息 ====================
  const stats = overdue?.stats || {};
  const submitOverdue = async () => {
    const values = await overdueForm.validateFields();
    setSaving(true);
    try {
      const data = {
        ...values,
        payableDate: values.payableDate ? values.payableDate.format('YYYY-MM-DD') : null,
        paymentDate: values.paymentDate ? values.paymentDate.format('YYYY-MM-DD') : null,
      };
      if (overdueEditing) await financeApi.updateOverdue(overdueEditing.id, data);
      else await financeApi.createOverdue({ ...data, contractId });
      message.success('保存成功，已自动重算台账');
      setOverdueModal(false);
      setOverdueEditing(null);
      loadAll(contractId);
    } finally {
      setSaving(false);
    }
  };

  const submitGenerate = async () => {
    const values = await generateForm.validateFields();
    setSaving(true);
    try {
      await financeApi.generateOverdue({ contractId, settlementMonth: values.settlementMonth.format('YYYY-MM'), materialAmount: values.materialAmount });
      message.success('已按付款模式生成应付款行');
      setGenerateModal(false);
      loadAll(contractId);
    } finally {
      setSaving(false);
    }
  };

  const submitParams = async () => {
    const values = await paramsForm.validateFields();
    setSaving(true);
    try {
      const data = {
        paymentMode: values.paymentMode,
        monthlyRate: values.monthlyRate ?? null,
        graceDays: values.graceDays ?? null,
        interestCapRatio: values.interestCapRatio ?? null,
      };
      await financeApi.saveContractParams(contractId, data);
      message.success('合同资金参数已保存');
      setParamsModal(false);
      loadAll(contractId);
    } finally {
      setSaving(false);
    }
  };

  const overdueColumns = [
    { title: '结算月份', dataIndex: 'settlementMonth', width: 90 },
    { title: '材料款金额', dataIndex: 'materialAmount', width: 110, align: 'right' as const, render: money },
    { title: '付款比例', dataIndex: 'paymentRatio', width: 80, align: 'right' as const, render: (v: any) => (v === null || v === undefined ? '-' : `${(Number(v) * 100).toFixed(0)}%`) },
    { title: '应付款金额', dataIndex: 'payableAmount', width: 110, align: 'right' as const, render: money },
    { title: '应付款日期', dataIndex: 'payableDate', width: 105, render: dateStr },
    { title: '逾期起始日期', dataIndex: 'overdueStartDate', width: 110, render: dateStr },
    { title: '付款日期', dataIndex: 'paymentDate', width: 105, render: dateStr },
    { title: '付款金额', dataIndex: 'paymentAmount', width: 105, align: 'right' as const, render: money },
    { title: '计息金额', dataIndex: 'interestAmount', width: 105, align: 'right' as const, render: money },
    { title: '逾期天数', dataIndex: 'overdueDays', width: 80, align: 'right' as const, render: (v: any, row: any) => (row.waived ? <Tag>减免</Tag> : v ?? '-') },
    { title: '延期月利率', dataIndex: 'monthlyRate', width: 95, align: 'right' as const, render: (v: any) => (v === null || v === undefined ? '-' : `${(Number(v) * 100).toFixed(2)}%`) },
    { title: '逾期利息（含税）', dataIndex: 'overdueInterest', width: 130, align: 'right' as const, render: (v: any, row: any) => <b>{money(row.waived ? 0 : v)}</b> },
    { title: '备注', dataIndex: 'remark', ellipsis: true, render: (v: any) => v || '-' },
    {
      title: '操作', width: 100, fixed: 'right' as const,
      render: (_: any, row: any) => (
        <Space size={0}>
          <Button type="link" size="small" icon={<EditOutlined />} onClick={() => {
            setOverdueEditing(row);
            overdueForm.setFieldsValue({
              ...row,
              payableDate: row.payableDate ? dayjs(row.payableDate) : null,
              paymentDate: row.paymentDate ? dayjs(row.paymentDate) : null,
            });
            setOverdueModal(true);
          }}>编辑</Button>
          <Popconfirm title="确认删除该行？" onConfirm={async () => { await financeApi.removeOverdue(row.id); message.success('已删除，已自动重算'); loadAll(contractId); }}>
            <Button type="link" size="small" danger icon={<DeleteOutlined />} />
          </Popconfirm>
        </Space>
      ),
    },
  ];

  return (
    <div
      style={{
        background: '#fff',
        borderRadius: 8,
        padding: 16,
        border: '1px solid #f0f0f0',
      }}
    >
      {/* 问题四：外框样式与其他标准列表页对齐；页面结构（选合同 → 双台账 + 统计）保持不变 */}
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          flexWrap: 'wrap',
          gap: 8,
          marginBottom: 16,
        }}
      >
        <span style={{ fontSize: 16, fontWeight: 600 }}>
          资金费用台账（保理费用 + 逾期利息）
        </span>
        <Select
          showSearch
          allowClear
          placeholder="选择合同（供应商）"
          style={{ width: 360 }}
          value={contractId || undefined}
          options={contracts.map((c: any) => ({ value: c.id, label: `${c.code} ${c.name}` }))}
          optionFilterProp="label"
          onChange={selectContract}
        />
      </div>
      {!contractId ? (
        <Empty description="请先在右上角选择合同" style={{ padding: 60 }} />
      ) : (
        <>
          {params && (
            <Descriptions size="small" column={4} style={{ marginBottom: 16 }} bordered>
              <Descriptions.Item label="供应商">{params.supplierName || '-'}</Descriptions.Item>
              <Descriptions.Item label="付款模式">
                <Space>
                  <Tag color="blue">{params.paymentMode === '3382' ? '3382 模式' : params.paymentMode === '100' ? '100% 模式' : '自定义'}</Tag>
                  <Button size="small" type="link" icon={<SettingOutlined />} onClick={() => {
                    paramsForm.setFieldsValue({
                      paymentMode: params.overrides?.paymentMode || params.paymentMode,
                      monthlyRate: params.overrides?.monthlyRate ?? params.monthlyRate,
                      graceDays: params.overrides?.graceDays ?? params.graceDays,
                      interestCapRatio: params.overrides?.interestCapRatio ?? params.interestCapRatio,
                    });
                    setParamsModal(true);
                  }}>参数设置</Button>
                </Space>
              </Descriptions.Item>
              <Descriptions.Item label="延期月利率">{`${(params.monthlyRate * 100).toFixed(2)}%`}</Descriptions.Item>
              <Descriptions.Item label="宽限期">{`${params.graceDays} 天`}</Descriptions.Item>
            </Descriptions>
          )}

          <Tabs
            activeKey={tab}
            onChange={setTab}
            items={[
              {
                key: 'factoring',
                label: '保理费用台账',
                children: (
                  <>
                    <Alert type="info" showIcon icon={<QuestionCircleOutlined />} style={{ marginBottom: 12 }}
                      message="填制说明" description={FACTORING_HELP} />
                    <Space style={{ marginBottom: 12 }}>
                      <Button type="primary" icon={<PlusOutlined />} onClick={() => { setFactoringEditing(null); factoringForm.resetFields(); setFactoringModal(true); }}>新增记录</Button>
                      <Button icon={<ExportOutlined />} onClick={() => window.open(withToken(financeApi.exportFactoringUrl(contractId)))}>导出 Excel</Button>
                    </Space>
                    <Table
                      rowKey="id"
                      loading={factoringLoading}
                      dataSource={factoring.list}
                      pagination={false}
                      scroll={{ x: 1100 }}
                      columns={factoringColumns}
                      summary={() => (
                        <Table.Summary fixed>
                          <Table.Summary.Row style={{ fontWeight: 600 }}>
                            <Table.Summary.Cell index={0}>合计</Table.Summary.Cell>
                            <Table.Summary.Cell index={1} />
                            <Table.Summary.Cell index={2} align="right">{money(factoring.totals?.financingAmount)}</Table.Summary.Cell>
                            <Table.Summary.Cell index={3} align="right">{money(factoring.totals?.actualReceipt)}</Table.Summary.Cell>
                            <Table.Summary.Cell index={4} align="right">{money(factoring.totals?.financingInterest)}</Table.Summary.Cell>
                            <Table.Summary.Cell index={5} align="right">{money(factoring.totals?.handlingFee)}</Table.Summary.Cell>
                            <Table.Summary.Cell index={6} align="right">{money(factoring.totals?.totalCost)}</Table.Summary.Cell>
                            <Table.Summary.Cell index={7} colSpan={3} />
                          </Table.Summary.Row>
                        </Table.Summary>
                      )}
                    />
                  </>
                ),
              },
              {
                key: 'overdue',
                label: '逾期利息台账',
                children: (
                  <>
                    <Alert type="info" showIcon icon={<QuestionCircleOutlined />} style={{ marginBottom: 12 }}
                      message="填制说明" description={OVERDUE_HELP} />
                    <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', marginBottom: 16 }}>
                      <Statistic title="材料款金额合计" value={stats.totalMaterial || 0} precision={2} prefix="¥" />
                      <Statistic title="付款金额合计" value={stats.totalPayment || 0} precision={2} prefix="¥" />
                      <Statistic title="本期开累逾期利息" value={stats.currentCumulative || 0} precision={2} prefix="¥" />
                      <Statistic title={`上限金额（${((stats.capRatio || 0) * 100).toFixed(1)}%）`} value={stats.capAmount || 0} precision={2} prefix="¥" />
                      <Statistic title="开累利息占材料款比例" value={stats.interestRatio || 0} precision={2} suffix="%" />
                      <Statistic title="上期开累逾期利息" value={stats.prevCumulative || 0} precision={2} prefix="¥" />
                      <Statistic title="本月结算逾期利息" value={stats.currentSettlement || 0} precision={2} prefix="¥" />
                    </div>
                    <Space style={{ marginBottom: 12 }}>
                      <Button type="primary" icon={<PlusOutlined />} onClick={() => { generateForm.resetFields(); setGenerateModal(true); }}>按付款模式生成应付款行</Button>
                      <Button icon={<PlusOutlined />} onClick={() => { setOverdueEditing(null); overdueForm.resetFields(); setOverdueModal(true); }}>手动新增行</Button>
                      <Button icon={<ExportOutlined />} onClick={() => window.open(withToken(financeApi.exportOverdueUrl(contractId)))}>导出计算表</Button>
                    </Space>
                    <Table
                      rowKey="id"
                      loading={overdueLoading}
                      dataSource={overdue.list}
                      pagination={false}
                      scroll={{ x: 1500 }}
                      columns={overdueColumns}
                      summary={() => (
                        <Table.Summary fixed>
                          <Table.Summary.Row style={{ fontWeight: 600 }}>
                            <Table.Summary.Cell index={0}>合计</Table.Summary.Cell>
                            <Table.Summary.Cell index={1} align="right">{money(stats.totalMaterial)}</Table.Summary.Cell>
                            <Table.Summary.Cell index={2} colSpan={4} />
                            <Table.Summary.Cell index={6} align="right">{money(stats.totalPayment)}</Table.Summary.Cell>
                            <Table.Summary.Cell index={7} colSpan={2} />
                            <Table.Summary.Cell index={9} align="right">{money(stats.currentCumulative)}</Table.Summary.Cell>
                            <Table.Summary.Cell index={10} colSpan={2} />
                          </Table.Summary.Row>
                        </Table.Summary>
                      )}
                    />
                    <Card size="small" style={{ marginTop: 16, background: '#fafafa' }}>
                      <div style={{ display: 'flex', gap: 48, color: '#555' }}>
                        <span>经办人：____________</span>
                        <span>物资经理：____________</span>
                        <span>商务经理：____________</span>
                        <span>项目经理：____________</span>
                      </div>
                    </Card>
                  </>
                ),
              },
            ]}
          />
        </>
      )}

      {/* 保理费用 录入弹窗 */}
      <Modal
        title={factoringEditing ? '编辑保理费用' : '新增保理费用'}
        open={factoringModal}
        onOk={submitFactoring}
        onCancel={() => { setFactoringModal(false); setFactoringEditing(null); }}
        confirmLoading={saving}
        destroyOnClose
      >
        <Form form={factoringForm} layout="vertical">
          <Space size={16} style={{ display: 'flex' }}>
            <Form.Item name="financingDate" label="融资到账时间" rules={[{ required: true, message: '请选择融资到账时间' }]}>
              <DatePicker format="YYYY-MM-DD" style={{ width: '100%' }} />
            </Form.Item>
            <Form.Item name="settlementMonth" label="结算月份">
              <Input placeholder="如 2026-04（已办结算月份）" />
            </Form.Item>
          </Space>
          <Space size={16} style={{ display: 'flex' }}>
            <Form.Item name="financingAmount" label="融资金额">
              <InputNumber style={{ width: 150 }} min={0} precision={2} />
            </Form.Item>
            <Form.Item name="actualReceipt" label="实际到账金额">
              <InputNumber style={{ width: 150 }} min={0} precision={2} />
            </Form.Item>
          </Space>
          <Space size={16} style={{ display: 'flex' }}>
            <Form.Item name="financingInterest" label="融资利息" rules={[{ required: true, message: '请输入融资利息' }]}>
              <InputNumber style={{ width: 150 }} min={0} precision={2} />
            </Form.Item>
            <Form.Item name="handlingFee" label="手续费（如有）">
              <InputNumber style={{ width: 150 }} min={0} precision={2} />
            </Form.Item>
          </Space>
          <Form.Item label="费用合计（含税）" tooltip="融资利息 + 手续费，系统自动计算">
            <InputNumber style={{ width: 150 }} disabled value={undefined} placeholder="自动计算" />
          </Form.Item>
          <Form.Item name="remark" label="备注"><Input.TextArea rows={2} /></Form.Item>
        </Form>
      </Modal>

      {/* 逾期利息 录入弹窗 */}
      <Modal
        title={overdueEditing ? '编辑逾期利息行' : '手动新增逾期利息行'}
        open={overdueModal}
        onOk={submitOverdue}
        onCancel={() => { setOverdueModal(false); setOverdueEditing(null); }}
        confirmLoading={saving}
        destroyOnClose
        width={560}
      >
        <Alert style={{ marginBottom: 12 }} type="info" showIcon
          message="应付款金额、逾期起始日期、计息金额、逾期天数、逾期利息均由系统按公式自动计算；付款金额填 0 表示对该笔剩余未付金额计息一次。" />
        <Form form={overdueForm} layout="vertical">
          <Space size={16} style={{ display: 'flex' }}>
            <Form.Item name="settlementMonth" label="结算月份" rules={[{ required: true, message: '如 2026-04' }]}>
              <Input placeholder="如 2026-04" />
            </Form.Item>
            <Form.Item name="periodSeq" label="行序号（同月多笔付款时）">
              <InputNumber min={1} precision={0} style={{ width: 160 }} />
            </Form.Item>
          </Space>
          <Space size={16} style={{ display: 'flex' }}>
            <Form.Item name="materialAmount" label="材料款金额">
              <InputNumber style={{ width: 200 }} min={0} precision={2} />
            </Form.Item>
            <Form.Item name="paymentRatio" label="付款比例" tooltip="0.8 表示 80%；留空按 100%">
              <InputNumber style={{ width: 160 }} min={0} max={1} step={0.05} />
            </Form.Item>
          </Space>
          <Space size={16} style={{ display: 'flex' }}>
            <Form.Item name="payableDate" label="应付款日期" tooltip="留空时由系统按付款模式推导">
              <DatePicker format="YYYY-MM-DD" style={{ width: 160 }} />
            </Form.Item>
            <Form.Item name="paymentDate" label="实际付款日期">
              <DatePicker format="YYYY-MM-DD" style={{ width: 160 }} />
            </Form.Item>
            <Form.Item name="paymentAmount" label="付款金额">
              <InputNumber style={{ width: 140 }} min={0} precision={2} />
            </Form.Item>
          </Space>
          <Space size={16} style={{ display: 'flex' }}>
            <Form.Item name="prevCumulative" label="上期开累逾期利息（期初，可留空自动结转）">
              <InputNumber style={{ width: 200 }} min={0} precision={2} />
            </Form.Item>
            <Form.Item name="waived" label="谈判减免（利息记 0）" valuePropName="checked">
              <Switch />
            </Form.Item>
          </Space>
          <Form.Item name="remark" label="备注"><Input.TextArea rows={2} placeholder="减免等特殊情况请注明" /></Form.Item>
        </Form>
      </Modal>

      {/* 按模式生成应付款行 */}
      <Modal
        title="按付款模式生成应付款行"
        open={generateModal}
        onOk={submitGenerate}
        onCancel={() => setGenerateModal(false)}
        confirmLoading={saving}
        destroyOnClose
      >
        <Alert style={{ marginBottom: 12 }} type="info" showIcon
          message={params?.paymentMode === '3382'
            ? '3382 模式：将生成 2 行——结算月+3 个月 25 日支付 80%，结算月+6 个月 25 日支付剩余 20%；逾期起始日期 = 应付款日期 + 宽限期 + 1 天。'
            : '100% 模式：生成 1 行——结算月次月 25 日支付 100%；逾期起始日期 = 应付款日期 + 宽限期 + 1 天。'} />
        <Form form={generateForm} layout="vertical">
          <Form.Item name="settlementMonth" label="结算月份" rules={[{ required: true, message: '请选择结算月份' }]}>
            <DatePicker picker="month" style={{ width: '100%' }} />
          </Form.Item>
          <Form.Item name="materialAmount" label="本月材料款金额（不含资金费用）" rules={[{ required: true, message: '请输入材料款金额' }]}>
            <InputNumber style={{ width: '100%' }} min={0.01} precision={2} />
          </Form.Item>
        </Form>
      </Modal>

      {/* 合同资金参数 */}
      <Modal
        title="合同资金参数（覆盖系统默认值）"
        open={paramsModal}
        onOk={submitParams}
        onCancel={() => setParamsModal(false)}
        confirmLoading={saving}
        destroyOnClose
      >
        <Form form={paramsForm} layout="vertical">
          <Form.Item name="paymentMode" label="付款模式" rules={[{ required: true }]}>
            <Select
              options={[
                { value: '100', label: `100% 模式：${params?.mode100Description || '次月25日前支付100%（逾期宽限7天）'}` },
                { value: '3382', label: `3382 模式：${params?.mode3382Description || '第3个月内支付80%，第6个月支付剩余（宽限7天）'}` },
                { value: 'CUSTOM', label: '自定义（手动录入应付款行）' },
              ]}
            />
          </Form.Item>
          <Space size={16} style={{ display: 'flex' }}>
            <Form.Item name="monthlyRate" label="延期月利率" tooltip="如 0.006 表示 0.6%，以合同条款为准">
              <InputNumber style={{ width: 160 }} min={0} max={1} step={0.0001} />
            </Form.Item>
            <Form.Item name="graceDays" label="逾期宽限天数">
              <InputNumber style={{ width: 160 }} min={0} precision={0} />
            </Form.Item>
            <Form.Item name="interestCapRatio" label="逾期利息上限比例" tooltip="如 0.05 表示材料款合计的 5%">
              <InputNumber style={{ width: 160 }} min={0} max={1} step={0.01} />
            </Form.Item>
          </Space>
          <Alert type="warning" showIcon message="留空的字段将回落到系统参数默认值（系统管理 → 系统参数中的 finance.overdue 组）。" />
        </Form>
      </Modal>
    </div>
  );
}
