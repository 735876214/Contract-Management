import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Alert,
  Button,
  Card,
  Col,
  Drawer,
  Form,
  Input,
  Modal,
  Row,
  Select,
  Space,
  Spin,
  Table,
  Tabs,
  Tag,
  message,
} from 'antd';
import {
  DeleteOutlined,
  EditOutlined,
  EyeOutlined,
  PlusOutlined,
  SendOutlined,
  SaveOutlined,
} from '@ant-design/icons';
import dayjs from 'dayjs';
import { contractApi, supplierApi, templateApi } from '@/api/business';
import DictSelect, { DictTag } from '@/components/DictSelect';
import { useAuthStore } from '@/store/auth';
import MaterialPoolTab from '@/components/contract/MaterialPoolTab';
import ContractItemTab from '@/components/contract/ContractItemTab';

/** 草稿超时阈值（需求 2.1.3：新增后 2 小时内未完成即视为超时） */
const OVERDUE_HOURS = 2;

const money = (v: number) =>
  v == null ? '-' : `¥${Number(v).toLocaleString('zh-CN', { maximumFractionDigits: 2 })}`;

/** 计算草稿超时剩余/超出分钟数：正数为剩余，负数为已超时 */
function overdueMinutes(createTime: string): number {
  return OVERDUE_HOURS * 60 - dayjs().diff(dayjs(createTime), 'minute');
}

/**
 * 合同起草页面（需求 2.1 / 2.4）
 * - 草稿列表：仅展示当前用户「未完成」（status=DRAFT 或空）的草稿（需求 2.3），
 *   发布后的合同自动流转至「合同查询」菜单，不再出现在本列表
 * - 列表点击「编辑」直接在本页打开起草抽屉（不再跳转合同台账）
 * - 新增合同：弹窗录入 类型/供应商/物资描述/模板 → 创建草稿 → 直接进入起草抽屉
 * - 起草抽屉：基础信息 + Tab1 物料编码清单 + Tab2 合同清单（税率为只读自动带出）
 * - 状态流转：保存（存草稿）→ 预览确认（模板变量替换 HTML）→ 发布（完成，清单推送至合同物资）
 */
export default function ContractDraft() {
  const currentProjectId = useAuthStore((s) => s.currentProjectId);
  const [rows, setRows] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  // ===== 新增弹窗 =====
  const [createOpen, setCreateOpen] = useState(false);
  const [createForm] = Form.useForm();
  const [suppliers, setSuppliers] = useState<any[]>([]);
  const [templates, setTemplates] = useState<any[]>([]);
  const [creating, setCreating] = useState(false);

  // ===== 起草抽屉 =====
  const [editorOpen, setEditorOpen] = useState(false);
  const [editing, setEditing] = useState<any>(null); // 当前草稿合同
  const [basicForm] = Form.useForm();
  const [saving, setSaving] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const [activeTab, setActiveTab] = useState('pool');

  // ===== 预览 =====
  const [previewOpen, setPreviewOpen] = useState(false);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [preview, setPreview] = useState<{ templateName: string; html: string } | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res: any = await contractApi.drafts();
      setRows(Array.isArray(res) ? res : res?.list || []);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
    supplierApi.options().then((res: any) => setSuppliers(res || []));
    templateApi.list({ pageSize: 200, page: 1 }).then((res: any) => setTemplates(res?.list || res || []));
  }, [load]);

  // ==================== 新增草稿 ====================
  const handleCreate = async () => {
    const values = await createForm.validateFields();
    setCreating(true);
    try {
      // 编号自动生成：CSCEC-WZCG-项目字母简称-层级-日期顺序码
      let code = '';
      try {
        const nc: any = await contractApi.nextCode({
          typeCode: values.typeCode,
          projectId: currentProjectId,
        });
        code = nc?.code || '';
      } catch {
        /* 映射缺失时由用户稍后在台账页补填 */
      }
      if (!code) {
        message.error('合同编号自动生成失败，请检查系统参数 contract.code 配置');
        return;
      }
      const created: any = await contractApi.create({ ...values, code, status: 'DRAFT' });
      message.success('草稿已创建，请完善清单后发布');
      setCreateOpen(false);
      createForm.resetFields();
      await load();
      openEditor(created?.id || created?.data?.id);
    } finally {
      setCreating(false);
    }
  };

  // ==================== 打开起草抽屉 ====================
  const openEditor = async (id: string) => {
    const detail: any = await contractApi.detail(id);
    setEditing(detail);
    basicForm.setFieldsValue({
      code: detail.code,
      name: detail.name,
      typeCode: detail.typeCode,
      subTypeCode: detail.subTypeCode,
      supplierId: detail.supplierId,
      materialDescription: detail.materialDescription,
      templateId: detail.templateId,
      signDate: detail.signDate,
      taxRate: detail.taxRate,
    });
    setActiveTab('pool');
    setEditorOpen(true);
  };

  /** 保存基础信息（自动触发名称重建：后端按 TMHB-XX-项目-物资-类型-供应商 规则生成） */
  const saveBasic = async (silent = false): Promise<boolean> => {
    if (!editing) return false;
    const values = await basicForm.validateFields();
    setSaving(true);
    try {
      await contractApi.update(editing.id, {
        typeCode: values.typeCode,
        subTypeCode: values.subTypeCode,
        supplierId: values.supplierId,
        materialDescription: values.materialDescription,
        templateId: values.templateId,
        signDate: values.signDate || null,
        taxRate: values.taxRate ?? null,
      });
      const detail: any = await contractApi.detail(editing.id);
      setEditing(detail);
      basicForm.setFieldsValue({ code: detail.code, name: detail.name });
      if (!silent) message.success('已保存');
      return true;
    } finally {
      setSaving(false);
    }
  };

  // ==================== 预览确认（需求 2.4） ====================
  const handlePreview = async () => {
    const ok = await saveBasic(true);
    if (!ok) return;
    const templateId = basicForm.getFieldValue('templateId');
    if (!templateId) {
      message.warning('请先在基础信息中选择合同模板');
      return;
    }
    setPreviewLoading(true);
    try {
      const res: any = await templateApi.generate({ templateId, contractId: editing.id });
      setPreview({ templateName: res?.templateName || '合同预览', html: res?.html || '' });
      setPreviewOpen(true);
    } finally {
      setPreviewLoading(false);
    }
  };

  // ==================== 发布（完成） ====================
  const handlePublish = async () => {
    if (!basicForm.getFieldValue('templateId')) {
      message.warning('发布前请先选择合同模板并保存');
      setActiveTab('basic');
      return;
    }
    Modal.confirm({
      title: '发布确认',
      width: 520,
      content: (
        <div>
          <p>发布后将执行以下动作，确认继续？</p>
          <ol style={{ paddingLeft: 20, margin: 0 }}>
            <li>合同清单推送至「合同物资」，作为正式执行数据；</li>
            <li>合同状态置为「已完成」，从草稿列表移除；</li>
            <li>按所选模板生成合同正文（可先点击「预览合同」确认）。</li>
          </ol>
        </div>
      ),
      okText: '确认发布',
      cancelText: '再检查一下',
      onOk: async () => {
        const ok = await saveBasic(true);
        if (!ok) return;
        setPublishing(true);
        try {
          await contractApi.publish(editing.id);
          message.success('合同已发布完成');
          setEditorOpen(false);
          setEditing(null);
          load();
        } finally {
          setPublishing(false);
        }
      },
    });
  };

  // ==================== 删除草稿 ====================
  const handleRemove = (row: any) => {
    Modal.confirm({
      title: '删除草稿',
      content: `确认删除草稿「${row.name || row.code}」？删除后不可恢复。`,
      okText: '删除',
      okType: 'danger',
      cancelText: '取消',
      onOk: async () => {
        await contractApi.removeDraft(row.id);
        message.success('草稿已删除');
        load();
      },
    });
  };

  const overdueCount = useMemo(
    () => rows.filter((r) => overdueMinutes(r.createdAt) <= 0).length,
    [rows],
  );

  return (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      {overdueCount > 0 && (
        <Alert
          type="warning"
          showIcon
          message={`您有 ${overdueCount} 份合同草稿已超过 ${OVERDUE_HOURS} 小时未完成，请及时处理`}
        />
      )}

      <Card
        title="合同起草"
        extra={
          <Button
            type="primary"
            icon={<PlusOutlined />}
            onClick={() => {
              createForm.resetFields();
              setCreateOpen(true);
            }}
          >
            新增合同
          </Button>
        }
      >
        <Table
          rowKey="id"
          loading={loading}
          dataSource={rows}
          pagination={{ pageSize: 10, showTotal: (t: number) => `共 ${t} 条` }}
          scroll={{ x: 1200 }}
          onRow={(row) => ({ onClick: () => openEditor(row.id), style: { cursor: 'pointer' } })}
          columns={[
            { title: '合同编号', dataIndex: 'code', width: 200 },
            { title: '合同名称', dataIndex: 'name', width: 220, ellipsis: true },
            { title: '供应商名称', dataIndex: ['supplier', 'name'], width: 200, ellipsis: true, render: (v) => v || '-' },
            { title: '合同类型', dataIndex: 'typeCode', width: 140, render: (v) => (v ? <DictTag typeCode="contract_type" value={v} /> : '-') },
            { title: '合同额', dataIndex: 'amount', width: 140, align: 'right', render: money },
            {
              title: '状态',
              dataIndex: 'status',
              width: 100,
              render: (v) => (v === 'COMPLETED' ? <Tag color="green">已完成</Tag> : <Tag color="blue">草稿中</Tag>),
            },
            {
              title: '超时提醒',
              key: 'draftStatus',
              width: 160,
              render: (_, row) => {
                const mins = overdueMinutes(row.createdAt);
                return mins > 0 ? (
                  <Tag>剩余 {Math.floor(mins / 60)} 小时 {mins % 60} 分</Tag>
                ) : (
                  <Tag color="orange">已超时 {-mins} 分钟</Tag>
                );
              },
            },
            {
              title: '最后编辑时间',
              dataIndex: 'updatedAt',
              width: 170,
              render: (v) => v?.slice(0, 19).replace('T', ' '),
            },
            {
              title: '操作',
              key: 'action',
              width: 150,
              fixed: 'right',
              render: (_, row) => (
                <Space size={4} onClick={(e) => e.stopPropagation()}>
                  <Button type="link" size="small" icon={<EditOutlined />} onClick={() => openEditor(row.id)}>
                    编辑
                  </Button>
                  <Button type="link" size="small" danger icon={<DeleteOutlined />} onClick={() => handleRemove(row)}>
                    删除
                  </Button>
                </Space>
              ),
            },
          ]}
        />
      </Card>

      {/* ==================== 新增合同弹窗 ==================== */}
      <Modal
        title="新增合同草稿"
        open={createOpen}
        onCancel={() => setCreateOpen(false)}
        onOk={handleCreate}
        confirmLoading={creating}
        okText="创建草稿"
        cancelText="取消"
        width={560}
        destroyOnClose
      >
        <Form form={createForm} layout="vertical">
          <Form.Item name="typeCode" label="合同类型" rules={[{ required: true, message: '请选择合同类型' }]}>
            <DictSelect typeCode="contract_type" placeholder="请选择合同类型" />
          </Form.Item>
          <Form.Item name="supplierId" label="供应商" rules={[{ required: true, message: '请选择供应商' }]}>
            <Select
              showSearch
              optionFilterProp="label"
              placeholder="请选择供应商"
              options={suppliers.map((s: any) => ({ value: s.id, label: s.name }))}
            />
          </Form.Item>
          <Form.Item
            name="materialDescription"
            label="物资名称描述"
            rules={[{ required: true, message: '请输入物资名称描述（用于合同名称自动生成）' }]}
            extra="示例：步道砖、盲道砖 —— 将用于合同名称 TMHB-CG-项目-物资描述-类型-供应商"
          >
            <Input placeholder="如：步道砖、盲道砖" />
          </Form.Item>
          <Form.Item
            name="templateId"
            label="合同模板"
            rules={[{ required: true, message: '请选择合同模板' }]}
            extra="发布时按模板自动生成合同正文，可在起草过程中随时更换"
          >
            <Select
              showSearch
              optionFilterProp="label"
              placeholder="请选择合同模板"
              options={templates.map((t: any) => ({ value: t.id, label: t.name }))}
            />
          </Form.Item>
        </Form>
      </Modal>

      {/* ==================== 起草抽屉 ==================== */}
      <Drawer
        title={
          <Space>
            <span>合同起草</span>
            {editing?.code && <Tag color="geekblue">{editing.code}</Tag>}
            {editing?.status === 'COMPLETED' ? <Tag color="green">已完成</Tag> : <Tag color="blue">草稿中</Tag>}
          </Space>
        }
        placement="right"
        width={1040}
        open={editorOpen}
        onClose={() => {
          setEditorOpen(false);
          setEditing(null);
          load();
        }}
        footer={
          <Space style={{ float: 'right' }}>
            <Button icon={<SaveOutlined />} loading={saving} onClick={() => saveBasic()}>
              保存（草稿）
            </Button>
            <Button icon={<EyeOutlined />} loading={previewLoading} onClick={handlePreview}>
              预览合同
            </Button>
            <Button type="primary" icon={<SendOutlined />} loading={publishing} onClick={handlePublish}>
              发布（完成）
            </Button>
          </Space>
        }
      >
        {editing ? (
          <Space direction="vertical" size={16} style={{ width: '100%' }}>
            <Card size="small" title="基础信息">
              <Form form={basicForm} layout="vertical">
                <Row gutter={16}>
                  <Col span={12}>
                    <Form.Item label="合同编号（自动生成，保存后不可变更）">
                      <Input value={basicForm.getFieldValue('code')} disabled />
                    </Form.Item>
                  </Col>
                  <Col span={12}>
                    <Form.Item label="合同名称（自动生成：TMHB-XX-项目-物资-类型-供应商）">
                      <Input value={basicForm.getFieldValue('name')} disabled />
                    </Form.Item>
                  </Col>
                </Row>
                <Row gutter={16}>
                  <Col span={8}>
                    <Form.Item name="typeCode" label="合同类型" rules={[{ required: true }]}>
                      <DictSelect typeCode="contract_type" />
                    </Form.Item>
                  </Col>
                  <Col span={8}>
                    <Form.Item name="supplierId" label="供应商" rules={[{ required: true }]}>
                      <Select
                        showSearch
                        optionFilterProp="label"
                        options={suppliers.map((s: any) => ({ value: s.id, label: s.name }))}
                      />
                    </Form.Item>
                  </Col>
                  <Col span={8}>
                    <Form.Item
                      name="materialDescription"
                      label="物资名称描述"
                      rules={[{ required: true }]}
                    >
                      <Input placeholder="如：步道砖、盲道砖" />
                    </Form.Item>
                  </Col>
                </Row>
                <Row gutter={16}>
                  <Col span={8}>
                    <Form.Item
                      name="templateId"
                      label="合同模板"
                      rules={[{ required: true, message: '发布前必须选择模板' }]}
                    >
                      <Select
                        showSearch
                        optionFilterProp="label"
                        placeholder="请选择合同模板"
                        options={templates.map((t: any) => ({ value: t.id, label: t.name }))}
                      />
                    </Form.Item>
                  </Col>
                  <Col span={8}>
                    <Form.Item name="signDate" label="签订日期">
                      <Input placeholder="YYYY-MM-DD" />
                    </Form.Item>
                  </Col>
                  <Col span={8}>
                    <Form.Item name="taxRate" label="税率(%)">
                      <Input type="number" placeholder="如 13" />
                    </Form.Item>
                  </Col>
                </Row>
              </Form>
            </Card>

            <Card size="small" title="物资清单">
              <Tabs
                activeKey={activeTab}
                onChange={setActiveTab}
                items={[
                  { key: 'pool', label: 'Tab1 · 物料编码清单', children: <MaterialPoolTab contractId={editing.id} /> },
                  { key: 'items', label: 'Tab2 · 合同清单', children: <ContractItemTab contractId={editing.id} /> },
                ]}
              />
            </Card>
          </Space>
        ) : (
          <Spin />
        )}
      </Drawer>

      {/* ==================== 合同正文预览 ==================== */}
      <Modal
        title={`预览确认 · ${preview?.templateName || ''}`}
        open={previewOpen}
        onCancel={() => setPreviewOpen(false)}
        footer={[
          <Button key="close" onClick={() => setPreviewOpen(false)}>
            关闭预览
          </Button>,
          <Button
            key="publish"
            type="primary"
            icon={<SendOutlined />}
            onClick={() => {
              setPreviewOpen(false);
              handlePublish();
            }}
          >
            预览无误，去发布
          </Button>,
        ]}
        width={900}
        destroyOnClose
      >
        <div
          style={{ maxHeight: 520, overflow: 'auto', border: '1px solid #f0f0f0', padding: 16, background: '#fff' }}
          dangerouslySetInnerHTML={{ __html: preview?.html || '' }}
        />
      </Modal>
    </Space>
  );
}
