import { useCallback, useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import {
  Card, Table, Button, Form, Input, Space, Modal, Popconfirm, message, Tag, Drawer, Tabs,
  Descriptions, InputNumber, DatePicker, Row, Col, Alert, Spin, Select, Typography,
} from 'antd';
import { PlusOutlined, SearchOutlined, ExportOutlined } from '@ant-design/icons';
import dayjs from 'dayjs';
import { contractApi, supplierApi, projectApi, materialApi } from '@/api/business';
import { useTable } from '@/hooks/useTable';
import ImportButton from '@/components/ImportButton';
import { useAuthStore } from '@/store/auth';
import DictSelect, { DictTag } from '@/components/DictSelect';
import Uploader, { UploadFile } from '@/components/Uploader';
import { templateApi } from '@/api/business';
import { CLAUSE_TYPE_OPTIONS, CLAUSE_TYPE_LABEL } from './Clauses';

const money = (v: number) => (v == null ? '-' : `¥${Number(v).toLocaleString('zh-CN', { maximumFractionDigits: 2 })}`);

/** 需求 2.3：四种条款类型对应的合同表单字段 */
const CLAUSE_FIELDS: { type: string; field: string }[] = [
  { type: 'technical', field: 'technicalClauseId' },
  { type: 'quality', field: 'qualityClauseId' },
  { type: 'payment', field: 'paymentClauseId' },
  { type: 'acceptance', field: 'acceptanceClauseId' },
];

export default function Contracts() {
  const { loading, list, total, params, search, reload, pagination } = useTable<any>((p) => contractApi.list(p));
  const [form] = Form.useForm();
  const [extForm] = Form.useForm();
  const [modal, setModal] = useState(false);
  const [editing, setEditing] = useState<any>(null);
  const [suppliers, setSuppliers] = useState<any[]>([]);
  const [materials, setMaterials] = useState<any[]>([]);
  const [supplier, setSupplier] = useState<any>(null);
  const [attachments, setAttachments] = useState<UploadFile[]>([]);
  const [codeStatus, setCodeStatus] = useState<'' | 'error' | 'success'>('');
  const [codeMsg, setCodeMsg] = useState('');
  const [detail, setDetail] = useState<any>(null);
  const [changes, setChanges] = useState<any[]>([]);
  const [codeTimer, setCodeTimer] = useState<any>(null);
  const [currentProject, setCurrentProject] = useState<any>(null);
  const [supModal, setSupModal] = useState(false);
  const [supForm] = Form.useForm();

  // 需求 2.3：合同条款（四种类型）选择
  const [clauseList, setClauseList] = useState<any[]>([]);
  const [clausePreview, setClausePreview] = useState<any[] | null>(null); // 预览全部条款
  const [clauseView, setClauseView] = useState<{ label: string; content: string } | null>(null); // 查看单条内容
  useEffect(() => {
    if (modal) {
      templateApi.clauses().then((res: any) => setClauseList(res?.list || res || []));
    }
  }, [modal]);
  const clausesByType = useCallback(
    (type: string) => clauseList.filter((c: any) => c.type === type),
    [clauseList],
  );

  useEffect(() => {
    supplierApi.options().then((res: any) => setSuppliers(res || []));
    materialApi.options().then((res: any) => setMaterials(res || []));
  }, []);

  // 当前项目（用于编号第3段字母简称）
  const currentProjectId = useAuthStore((s) => s.currentProjectId);
  useEffect(() => {
    if (currentProjectId) projectApi.detail(currentProjectId).then((res: any) => setCurrentProject(res));
  }, [currentProjectId]);

  // 自动生成合同编号（类型/子类型/项目变化时刷新）
  const genCode = async (typeCode?: string, subTypeCode?: string) => {
    if (editing) return; // 编辑态编号不可变更
    try {
      const res: any = await contractApi.nextCode({
        typeCode: typeCode ?? form.getFieldValue('typeCode'),
        subTypeCode: subTypeCode ?? form.getFieldValue('subTypeCode'),
        projectId: currentProjectId,
      });
      if (res?.code) {
        form.setFieldsValue({ code: res.code });
        setCodeStatus('success');
        setCodeMsg('已自动生成（可手动微调，保存后不可变更）');
        if (res.missing?.length) setCodeMsg(`已生成，但缺少：${res.missing.join('；')}`);
      }
    } catch {
      /* 映射缺失时静默，由用户手填 */
    }
  };

  // 监听类型/子类型变化自动刷新编号预览
  const watchedType = Form.useWatch('typeCode', form);
  // 需求 2.1：合同发布后（审批中/已签章）合同类型固化；历史空状态在 UI 上按「审批中」展示，同样锁定
  const typeLocked = !!editing && editing.status !== 'DRAFT';
  const watchedSubType = Form.useWatch('subTypeCode', form);
  useEffect(() => {
    if (modal && !editing) genCode(watchedType, watchedSubType);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [watchedType, watchedSubType, modal, editing]);

  // 合同编号实时查重
  const checkCode = (code: string) => {
    if (!code) {
      setCodeStatus('');
      setCodeMsg('');
      return;
    }
    if (codeTimer) clearTimeout(codeTimer);
    setCodeTimer(
      setTimeout(async () => {
        if (editing && editing.code === code) {
          setCodeStatus('success');
          setCodeMsg('当前编号');
          return;
        }
        const res: any = await contractApi.checkCode(code, editing?.id);
        if (res?.exists) {
          setCodeStatus('error');
          setCodeMsg(`合同编号已存在（${res.scope === 'GLOBAL' ? '全局唯一' : '项目内唯一'}）`);
        } else {
          setCodeStatus('success');
          setCodeMsg('编号可用');
        }
      }, 400),
    );
  };

  const onSupplierChange = (id: string) => {
    const hit = suppliers.find((s) => s.id === id);
    setSupplier(hit || null);
  };

  const submit = async () => {
    const values = await form.validateFields();
    if (codeStatus === 'error') {
      message.error('合同编号已存在，请修改');
      return;
    }
    const materialIds = values.materialIds;
    delete values.materialIds;
    const payload = {
      ...values,
      signDate: values.signDate ? values.signDate.format('YYYY-MM-DD') : null,
      attachments,
      ext: extForm.getFieldsValue(),
      materialIds: editing ? undefined : materialIds, // 仅创建时派生清单
    };
    if (editing) await contractApi.update(editing.id, payload);
    else await contractApi.create(payload);
    message.success(editing ? '保存成功' : '保存成功，已按所选物资生成合同物资清单');
    setModal(false);
    form.resetFields();
    extForm.resetFields();
    setEditing(null);
    setSupplier(null);
    setAttachments([]);
    reload();
  };

  const openEdit = (row: any) => {
    setEditing(row);
    form.setFieldsValue({
      ...row,
      signDate: row.signDate ? dayjs(row.signDate) : null,
    });
    extForm.setFieldsValue({
      ...(row.ext || {}),
      bidStartDate: row.ext?.bidStartDate ? dayjs(row.ext.bidStartDate) : null,
      bidWinDate: row.ext?.bidWinDate ? dayjs(row.ext.bidWinDate) : null,
      disclosureDate: row.ext?.disclosureDate ? dayjs(row.ext.disclosureDate) : null,
    });
    setSupplier(row.supplier || null);
    setAttachments(row.attachments || []);
    setCodeStatus('');
    setCodeMsg('');
    setModal(true);
  };

  const openDetail = async (row: any) => {
    const res: any = await contractApi.detail(row.id);
    setDetail(res);
    const ch: any = await contractApi.changes(row.id);
    setChanges(ch || []);
  };

  // 需求 2.1：合同起草页「继续编辑」携带 ?edit=<id> 跳入，自动拉取详情并打开编辑弹窗
  const [searchParams, setSearchParams] = useSearchParams();
  const editParam = searchParams.get('edit');
  useEffect(() => {
    if (!editParam) return;
    let alive = true;
    contractApi
      .detail(editParam)
      .then((res: any) => {
        if (alive && res) openEdit(res);
      })
      .catch(() => undefined)
      .finally(() => {
        if (alive) setSearchParams({}, { replace: true });
      });
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editParam]);


  return (
    <Card
      title="合同管理"
      extra={
        <Space>
          <ImportButton moduleName="合同台账" templateUrl={contractApi.templateUrl()} uploadUrl={contractApi.importUrl()} onDone={reload} />
          <Button type="primary" icon={<PlusOutlined />} onClick={() => { setEditing(null); form.resetFields(); extForm.resetFields(); setSupplier(null); setAttachments([]); setModal(true); }}>
            新建合同
          </Button>
        </Space>
      }
    >
      <Form layout="inline" style={{ marginBottom: 16, rowGap: 8 }} onFinish={(v) => search(v)}>
        <Form.Item name="keyword"><Input placeholder="合同编号/名称" allowClear prefix={<SearchOutlined />} /></Form.Item>
        <Form.Item name="typeCode"><DictSelect typeCode="contract_type" placeholder="合同类型" /></Form.Item>
        <Form.Item name="execStatus"><DictSelect typeCode="contract_execution_status" placeholder="执行情况" /></Form.Item>
        <Form.Item><Button type="primary" htmlType="submit">查询</Button></Form.Item>
      </Form>

      <Table
        rowKey="id"
        loading={loading}
        dataSource={list}
        pagination={pagination}
        scroll={{ x: 1500 }}
        columns={[
          { title: '合同编号', dataIndex: 'code', width: 160, fixed: 'left' },
          { title: '合同名称', dataIndex: 'name', width: 240 },
          { title: '合同类型', dataIndex: 'typeCode', width: 130, render: (v) => <DictTag typeCode="contract_type" value={v} /> },
          { title: '供应商', width: 220, render: (_, row) => row.supplier?.name || '-' },
          { title: '合同额', dataIndex: 'amount', width: 140, render: money },
          { title: '税率', dataIndex: 'taxRate', width: 90, render: (v) => (v == null ? '-' : `${(Number(v) * 100).toFixed(2)}%`) },
          { title: '签订日期', dataIndex: 'signDate', width: 120, render: (v) => v?.slice(0, 10) },
          { title: '执行情况', dataIndex: 'execStatus', width: 120, render: (v) => <DictTag typeCode="contract_execution_status" value={v} /> },
          {
            title: '操作',
            width: 200,
            fixed: 'right',
            render: (_, row) => (
              <Space size={4}>
                <Button type="link" size="small" onClick={() => openDetail(row)}>详情</Button>
                <Button type="link" size="small" onClick={() => openEdit(row)}>编辑</Button>
                <Popconfirm title="确认删除该合同？关联的清单、结算、付款等数据将一并删除。" onConfirm={async () => { await contractApi.remove(row.id); message.success('已删除'); reload(); }}>
                  <Button type="link" size="small" danger>删除</Button>
                </Popconfirm>
              </Space>
            ),
          },
        ]}
      />

      <Modal
        title={editing ? '编辑合同' : '新建合同'}
        open={modal}
        onOk={submit}
        onCancel={() => setModal(false)}
        width={960}
        destroyOnClose
      >
        <Tabs
          items={[
            {
              key: 'base',
              label: '基础信息',
              children: (
                <Form form={form} layout="vertical">
                  <Row gutter={16}>
                    <Col xs={24} md={12}>
                      <Form.Item
                        name="code"
                        label="合同编号"
                        rules={[{ required: true }]}
                        validateStatus={codeStatus}
                        help={codeMsg}
                        hasFeedback
                      >
                        <Input onChange={(e) => checkCode(e.target.value)} placeholder="如 HT-2026-0001" />
                      </Form.Item>
                    </Col>
                    <Col xs={24} md={12}>
                      <Form.Item name="name" label="合同名称" rules={[{ required: true }]}><Input /></Form.Item>
                    </Col>
                    <Col xs={24} md={12}>
                      {/* 需求 2.1：发布后（审批中/已签章）合同类型只读，后端同步校验 */}
                      <Form.Item
                        name="typeCode"
                        label={typeLocked ? '合同类型（发布后不可修改）' : '合同类型'}
                        rules={[{ required: true }]}
                      >
                        <DictSelect typeCode="contract_type" disabled={typeLocked} />
                      </Form.Item>
                    </Col>
                    <Col xs={24} md={12}>
                      <Form.Item name="subTypeCode" label="合同子类型" rules={[{ required: true }]}>
                        <DictSelect typeCode="contract_sub_type" />
                      </Form.Item>
                    </Col>
                    <Col xs={24} md={12}>
                      <Form.Item name="supplierId" label="供应商" rules={[{ required: true }]}>
                        <Select
                          showSearch
                          optionFilterProp="label"
                          placeholder="请选择供应商（选择后自动带出法人/授权人/银行等信息）"
                          onChange={onSupplierChange}
                          options={suppliers.map((s) => ({ value: s.id, label: s.name }))}
                        />
                      </Form.Item>
                    </Col>
                    <Col xs={24} md={8}>
                      <Form.Item name="signDate" label="签订日期"><DatePicker format="YYYY-MM-DD" style={{ width: '100%' }} /></Form.Item>
                    </Col>
                    {!editing && (
                      <Col xs={24} md={16}>
                        <Form.Item
                          name="materialIds"
                          label="初始物资（从项目物资清单派生合同清单，可多选）"
                          extra="创建合同后将按所选物资自动生成合同物资清单（唯一数据源），也可之后在「合同物资清单」页面派生或导入。"
                        >
                          <Select
                            mode="multiple"
                            showSearch
                            optionFilterProp="label"
                            allowClear
                            maxTagCount={4}
                            placeholder="选择物资（可留空，稍后在合同物资清单中派生）"
                            options={materials.map((m) => ({ value: m.id, label: `${m.name} / ${m.spec}` }))}
                          />
                        </Form.Item>
                      </Col>
                    )}
                    <Col xs={24} md={8}>
                      <Form.Item name="amount" label="合同额"><InputNumber style={{ width: '100%' }} min={0} precision={2} /></Form.Item>
                    </Col>
                    <Col xs={24} md={8}>
                      <Form.Item name="taxRate" label="税率"><InputNumber style={{ width: '100%' }} min={0} max={1} step={0.01} precision={4} /></Form.Item>
                    </Col>
                    <Col xs={24} md={8}>
                      <Form.Item name="paymentMethodCode" label="合同约定付款方式"><DictSelect typeCode="payment_method" /></Form.Item>
                    </Col>
                    <Col xs={24} md={8}>
                      <Form.Item name="isFramework" label="是否框架协议"><DictSelect typeCode="yes_no" /></Form.Item>
                    </Col>
                    <Col xs={24} md={8}>
                      <Form.Item name="isSupplement" label="是否补充协议"><DictSelect typeCode="yes_no" /></Form.Item>
                    </Col>
                    <Col xs={24} md={12}>
                      <Form.Item
                        noStyle
                        shouldUpdate={(prev, cur) => prev.isSupplement !== cur.isSupplement}
                      >
                        {({ getFieldValue }) =>
                          getFieldValue('isSupplement') === 'Y' ? (
                            <Form.Item name="supplementTypeCode" label="补充协议类型" rules={[{ required: true, message: '请选择补充协议类型' }]}>
                              <DictSelect typeCode="supplement_agreement_type" />
                            </Form.Item>
                          ) : null
                        }
                      </Form.Item>
                    </Col>
                    <Col xs={24} md={12}>
                      <Form.Item name="execStatus" label="合同执行情况"><DictSelect typeCode="contract_execution_status" /></Form.Item>
                    </Col>
                    <Col xs={24}>
                      <Form.Item name="remark" label="备注"><Input.TextArea rows={2} /></Form.Item>
                    </Col>
                    <Col xs={24}>
                      <Form.Item label="附件"><Uploader value={attachments} onChange={setAttachments} /></Form.Item>
                    </Col>
                    {/* 需求 2.3：合同条款 —— 四种类型分别下拉选择已维护的条款 */}
                    <Col xs={24}>
                      <Card
                        type="inner"
                        title="合同条款"
                        extra={
                          <Button
                            onClick={() => {
                              const rows = CLAUSE_FIELDS.map(({ type, field }) => {
                                const id = form.getFieldValue(field);
                                return { type, clause: clauseList.find((c: any) => c.id === id) || null };
                              });
                              setClausePreview(rows);
                            }}
                          >
                            预览全部条款
                          </Button>
                        }
                      >
                        <Row gutter={16}>
                          {CLAUSE_FIELDS.map(({ type, field }) => (
                            <Col xs={24} md={12} key={field}>
                              <Form.Item label={CLAUSE_TYPE_LABEL[type]}>
                                <Space.Compact style={{ width: '100%' }}>
                                  <Form.Item noStyle name={field}>
                                    <Select
                                      allowClear
                                      showSearch
                                      optionFilterProp="label"
                                      placeholder={`选择${CLAUSE_TYPE_LABEL[type]}`}
                                      options={clausesByType(type).map((c: any) => ({ value: c.id, label: c.title }))}
                                    />
                                  </Form.Item>
                                  <Button
                                    onClick={() => {
                                      const id = form.getFieldValue(field);
                                      const clause = clauseList.find((c: any) => c.id === id);
                                      if (!clause) return message.warning(`请先选择${CLAUSE_TYPE_LABEL[type]}`);
                                      setClauseView({ label: `${CLAUSE_TYPE_LABEL[type]}：${clause.title}`, content: clause.content });
                                    }}
                                  >
                                    查看内容
                                  </Button>
                                </Space.Compact>
                              </Form.Item>
                            </Col>
                          ))}
                        </Row>
                        <Alert
                          type="info"
                          showIcon
                          message="条款内容在「基础信息管理 → 合同条款」中维护；此处选择后随合同一起保存。"
                        />
                      </Card>
                    </Col>
                  </Row>

                  {supplier && (
                    <>
                      <Alert
                        type="info"
                        showIcon
                        style={{ marginBottom: 12 }}
                        message="以下信息由供应商库自动带出，只读展示；修改请在【供应商库】维护"
                      />
                      <Descriptions bordered size="small" column={2} style={{ marginBottom: 16 }}>
                        <Descriptions.Item label="法人姓名">{supplier.legalPerson || '-'}</Descriptions.Item>
                        <Descriptions.Item label="法人电话">{supplier.legalPhone || '-'}</Descriptions.Item>
                        <Descriptions.Item label="合同授权人姓名">{supplier.contractAuthPerson || '-'}</Descriptions.Item>
                        <Descriptions.Item label="合同授权人电话">{supplier.contractAuthPhone || '-'}</Descriptions.Item>
                        <Descriptions.Item label="授权人身份证号">{supplier.contractAuthIdNo || '-'}</Descriptions.Item>
                        <Descriptions.Item label="联系人姓名">{supplier.contactName || '-'}</Descriptions.Item>
                        <Descriptions.Item label="联系人电话">{supplier.contactPhone || '-'}</Descriptions.Item>
                        <Descriptions.Item label="联系人邮箱">{supplier.contactEmail || '-'}</Descriptions.Item>
                        <Descriptions.Item label="银行名称">{supplier.bankName || '-'}</Descriptions.Item>
                        <Descriptions.Item label="银行账号">{supplier.bankAccount || '-'}</Descriptions.Item>
                        <Descriptions.Item label="公司地址" span={2}>{supplier.address || '-'}</Descriptions.Item>
                      </Descriptions>
                    </>
                  )}
                </Form>
              ),
            },
            {
              key: 'ext',
              label: '台账补充信息',
              children: (
                <Form form={extForm} layout="vertical">
                  <Row gutter={16}>
                    <Col xs={24} md={12}>
                      <Form.Item name="financeCode" label="财务一体化合同编号"><Input /></Form.Item>
                    </Col>
                    <Col xs={24} md={12}>
                      <Form.Item name="bidName" label="招标名称"><Input /></Form.Item>
                    </Col>
                    <Col xs={24} md={12}>
                      <Form.Item name="procurementSrc" label="采购来源"><DictSelect typeCode="procurement_source" /></Form.Item>
                    </Col>
                    <Col xs={24} md={12}>
                      <Form.Item name="isDirectPurchase" label="是否厂家直采"><DictSelect typeCode="is_direct_purchase" /></Form.Item>
                    </Col>
                    <Col xs={24} md={12}>
                      <Form.Item name="supplierCategory" label="分供方类别"><DictSelect typeCode="supplier_category" /></Form.Item>
                    </Col>
                    <Col xs={24} md={12}>
                      <Form.Item name="currentPayRatio" label="当前合同付款比例"><InputNumber style={{ width: '100%' }} min={0} max={1} step={0.01} precision={4} /></Form.Item>
                    </Col>
                    <Col xs={24} md={8}>
                      <Form.Item name="bidStartDate" label="开始招标时间"><DatePicker format="YYYY-MM-DD" style={{ width: '100%' }} /></Form.Item>
                    </Col>
                    <Col xs={24} md={8}>
                      <Form.Item name="bidWinDate" label="定标时间"><DatePicker format="YYYY-MM-DD" style={{ width: '100%' }} /></Form.Item>
                    </Col>
                    <Col xs={24} md={8}>
                      <Form.Item name="disclosureDate" label="合同交底时间"><DatePicker format="YYYY-MM-DD" style={{ width: '100%' }} /></Form.Item>
                    </Col>
                    <Col xs={24}>
                      <Form.Item name="complaint" label="投诉情况"><Input.TextArea rows={2} /></Form.Item>
                    </Col>
                  </Row>
                </Form>
              ),
            },
          ]}
        />
      </Modal>

      {/* 需求 2.3：查看单条条款内容 */}
      <Modal
        title={clauseView?.label || '条款内容'}
        open={!!clauseView}
        onCancel={() => setClauseView(null)}
        footer={<Button type="primary" onClick={() => setClauseView(null)}>关闭</Button>}
        width={680}
      >
        <div
          style={{ maxHeight: 480, overflow: 'auto', border: '1px solid #f0f0f0', borderRadius: 6, padding: 16, background: '#fff' }}
          dangerouslySetInnerHTML={{ __html: clauseView?.content || '' }}
        />
      </Modal>

      {/* 需求 2.3：预览当前合同所选的全部四种条款 */}
      <Modal
        title="预览全部条款"
        open={!!clausePreview}
        onCancel={() => setClausePreview(null)}
        footer={<Button type="primary" onClick={() => setClausePreview(null)}>关闭</Button>}
        width={760}
      >
        <Space direction="vertical" size={16} style={{ width: '100%' }}>
          {(clausePreview || []).map(({ type, clause }) => (
            <div key={type}>
              <Typography.Title level={5} style={{ marginBottom: 8 }}>
                {CLAUSE_TYPE_LABEL[type]}
                {clause ? <Typography.Text type="secondary">（{clause.title}）</Typography.Text> : null}
              </Typography.Title>
              {clause ? (
                <div
                  style={{ maxHeight: 240, overflow: 'auto', border: '1px solid #f0f0f0', borderRadius: 6, padding: 12, background: '#fff' }}
                  dangerouslySetInnerHTML={{ __html: clause.content }}
                />
              ) : (
                <Typography.Text type="secondary">未选择</Typography.Text>
              )}
            </div>
          ))}
        </Space>
      </Modal>

      <Drawer title="合同详情" width={720} open={!!detail} onClose={() => setDetail(null)}>
        {detail ? (
          <>
            <Tabs
            items={[
              {
                key: 'info',
                label: '合同信息',
                children: (
                  <Descriptions column={2} size="small" bordered>
                    <Descriptions.Item label="合同编号">{detail.code}</Descriptions.Item>
                    <Descriptions.Item label="合同名称">{detail.name}</Descriptions.Item>
                    <Descriptions.Item label="合同类型"><DictTag typeCode="contract_type" value={detail.typeCode} /></Descriptions.Item>
                    <Descriptions.Item label="合同子类型"><DictTag typeCode="contract_sub_type" value={detail.subTypeCode} /></Descriptions.Item>
                    {detail.codeAbbrUsed && <Descriptions.Item label="编号项目简称">{detail.codeAbbrUsed}</Descriptions.Item>}
                    {detail.parentContractId && (
                      <Descriptions.Item label="父合同" span={2}>
                        {detail.parentContract ? `${detail.parentContract.code} ${detail.parentContract.name}` : '-'}
                      </Descriptions.Item>
                    )}
                    <Descriptions.Item label="供应商">{detail.supplier?.name || '-'}</Descriptions.Item>
                    <Descriptions.Item label="法人">{detail.supplier?.legalPerson || '-'}</Descriptions.Item>
                    <Descriptions.Item label="授权人">{detail.supplier?.contractAuthPerson || '-'}</Descriptions.Item>
                    <Descriptions.Item label="联系人">{detail.supplier?.contactName || '-'}</Descriptions.Item>
                    <Descriptions.Item label="联系人电话">{detail.supplier?.contactPhone || '-'}</Descriptions.Item>
                    <Descriptions.Item label="合同额">{money(detail.amount)}</Descriptions.Item>
                    <Descriptions.Item label="税率">{detail.taxRate != null ? `${(Number(detail.taxRate) * 100).toFixed(2)}%` : '-'}</Descriptions.Item>
                    <Descriptions.Item label="签订日期">{detail.signDate?.slice(0, 10)}</Descriptions.Item>
                    <Descriptions.Item label="执行情况"><DictTag typeCode="contract_execution_status" value={detail.execStatus} /></Descriptions.Item>
                    <Descriptions.Item label="备注" span={2}>{detail.remark || '-'}</Descriptions.Item>
                    {detail.attachments?.length ? (
                      <Descriptions.Item label="附件" span={2}>
                        {detail.attachments.map((a: any) => (
                          <Tag key={a.id}><a href={a.url} target="_blank" rel="noreferrer">{a.fileName}</a></Tag>
                        ))}
                      </Descriptions.Item>
                    ) : null}
                  </Descriptions>
                ),
              },
              {
                key: 'changes',
                label: `变更记录（${changes.length}）`,
                children: (
                  <Table
                    rowKey="id"
                    size="small"
                    dataSource={changes}
                    pagination={false}
                    columns={[
                      { title: '字段', dataIndex: 'fieldLabel' },
                      { title: '变更前', dataIndex: 'beforeValue' },
                      { title: '变更后', dataIndex: 'afterValue' },
                      { title: '操作人', dataIndex: 'operator' },
                      { title: '时间', dataIndex: 'createdAt', render: (v) => v?.slice(0, 19).replace('T', ' ') },
                    ]}
                  />
                ),
              },
            ]}
          />
          {detail.isSupplement !== 'Y' && (
            <div style={{ marginTop: 16 }}>
              <Space wrap>
                {detail.supplements?.map((s: any) => (
                  <Tag key={s.id} color="blue">{s.code}</Tag>
                ))}
              </Space>
              <Button
                type="primary"
                size="small"
                style={{ marginLeft: 8 }}
                onClick={async () => {
                  const res: any = await contractApi.nextSupplementCode(detail.id);
                  supForm.setFieldsValue({
                    code: res.code,
                    name: `${res.parentName}补充协议`,
                    supplementTypeCode: undefined,
                  });
                  setSupModal(true);
                }}
              >
                新增补充协议
              </Button>
            </div>
          )}
          </>
        ) : (
          <Spin />
        )}
      </Drawer>

      <Modal
        title="新增补充协议"
        open={supModal}
        onOk={async () => {
          const v = await supForm.validateFields();
          await contractApi.create({
            ...v,
            signDate: v.signDate ? v.signDate.format('YYYY-MM-DD') : null,
            isSupplement: 'Y',
            parentContractId: detail.id,
            typeCode: detail.typeCode,
            supplierId: detail.supplierId,
          });
          message.success('补充协议已创建');
          setSupModal(false);
          supForm.resetFields();
          const res: any = await contractApi.detail(detail.id);
          setDetail(res);
          reload();
        }}
        onCancel={() => setSupModal(false)}
        destroyOnClose
      >
        <Form form={supForm} layout="vertical">
          <Form.Item name="code" label="补充协议编号（自动生成，可微调）" rules={[{ required: true }]}>
            <Input />
          </Form.Item>
          <Form.Item name="name" label="协议名称" rules={[{ required: true }]}><Input /></Form.Item>
          <Form.Item name="supplementTypeCode" label="补充协议类型" rules={[{ required: true, message: '请选择补充协议类型' }]}>
            <DictSelect typeCode="supplement_agreement_type" />
          </Form.Item>
          <Form.Item name="signDate" label="签订日期"><DatePicker format="YYYY-MM-DD" style={{ width: '100%' }} /></Form.Item>
          <Form.Item name="remark" label="备注"><Input.TextArea rows={2} /></Form.Item>
        </Form>
      </Modal>
    </Card>
  );
}
