import { useEffect, useState } from 'react';
import { Button, Form, Input, InputNumber, Select, Space, Modal, message, Row, Col } from 'antd';
import { PlusOutlined } from '@ant-design/icons';
import { costApi, subcontractorApi } from '@/api/modules';
import ModuleListPage, { type ModuleListFilterField, type ModuleListRow } from '@/components/procurement/ModuleListPage';
import EditorTabPage from '@/components/editor/EditorTabPage';
import { useEditorTab, useTabRefresh } from '@/hooks/useTabs';

/**
 * 成本管理 · 分包领用汇总（附件需求 2026-10-17 新增模块）。
 * 结构化台账（无上传附件）：金额 = 数量 × 单价 由服务端计算；归档时按分包商分组导出 Excel。
 */
const LIST_PATH = '/cost/receiving';

export default function CostReceiving() {
  const editorTab = useEditorTab(LIST_PATH);
  if (editorTab.isEditor) {
    return <ReceivingEditor seed={editorTab.seed} />;
  }
  return <ReceivingList />;
}

function ReceivingList() {
  const editorTab = useEditorTab(LIST_PATH);
  const tabRefresh = useTabRefresh(LIST_PATH);
  const [listRefresh, setListRefresh] = useState(0);
  const refreshList = () => setListRefresh((k) => k + 1);

  const handleRemove = (row: ModuleListRow) => {
    Modal.confirm({
      title: '确认删除该领用记录？',
      okText: '确认删除',
      okType: 'danger',
      onOk: async () => {
        await costApi.receiving.remove(row.id);
        message.success('已删除');
        refreshList();
      },
    });
  };

  const extraFilters: ModuleListFilterField[] = [
    { key: 'period', label: '账期', control: 'input', placeholder: '如 2026.10' },
    { key: 'keyword', label: '关键词', control: 'input', placeholder: '分包商 / 物资名称' },
  ];

  const extraColumns: any[] = [
    { title: '分包商', dataIndex: 'subcontractorName', width: 200, fixed: 'left' },
    { title: '账期', dataIndex: 'period', width: 100, render: (v: any) => v || '-' },
    { title: '物资名称', dataIndex: 'materialName', width: 160, render: (v: any) => v || '-' },
    { title: '规格型号', dataIndex: 'spec', width: 130, render: (v: any) => v || '-' },
    { title: '计量单位', dataIndex: 'unit', width: 90, render: (v: any) => v || '-' },
    { title: '数量', dataIndex: 'qty', width: 100, align: 'right' as const, render: (v: any) => (v == null ? '-' : Number(v).toLocaleString('zh-CN')) },
    { title: '单价', dataIndex: 'unitPrice', width: 110, align: 'right' as const, render: (v: any) => (v == null ? '-' : `¥${Number(v).toLocaleString('zh-CN', { minimumFractionDigits: 2 })}`) },
    {
      title: '金额',
      dataIndex: 'amount',
      width: 130,
      align: 'right' as const,
      render: (v: any) => (v == null ? '-' : <b>¥{Number(v).toLocaleString('zh-CN', { minimumFractionDigits: 2 })}</b>),
    },
    { title: '使用部位', dataIndex: 'useLocation', width: 130, render: (v: any) => v || '-' },
    { title: '备注', dataIndex: 'remark', width: 160, ellipsis: true, render: (v: any) => v || '-' },
  ];

  return (
    <ModuleListPage
      mode="generic"
      columnConfigKey="cost.receiving"
      fetcher={(params) => costApi.receiving.list(params)}
      extraFilters={extraFilters}
      extraColumns={extraColumns}
      refreshKey={listRefresh + tabRefresh}
      emptyText="暂无分包领用记录"
      onEdit={(row) => editorTab.openEdit(row.id, row)}
      onDelete={handleRemove}
      toolbarLeft={
        <Button type="primary" icon={<PlusOutlined />} onClick={() => editorTab.openCreate()}>
          新增领用
        </Button>
      }
    />
  );
}

function ReceivingEditor({ seed }: { seed: unknown }) {
  const [form] = Form.useForm();
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [subcontractors, setSubcontractors] = useState<any[]>([]);
  const editing = seed as any | undefined;

  useEffect(() => {
    subcontractorApi.list({ pageSize: 1000 }).then((res: any) => setSubcontractors(res?.list || []));
  }, []);

  useEffect(() => {
    form.resetFields();
    if (editing) form.setFieldsValue(editing);
    setDirty(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editing]);

  const submit = async () => {
    const values = await form.validateFields();
    setSaving(true);
    try {
      if (editing) await costApi.receiving.update(editing.id, { ...values, version: editing.version });
      else await costApi.receiving.create(values);
      message.success('保存成功');
    } finally {
      setSaving(false);
    }
  };

  return (
    <EditorTabPage
      listPath={LIST_PATH}
      title={editing ? '编辑分包领用' : '新增分包领用'}
      saving={saving}
      dirty={dirty}
      onSave={submit}
    >
      <Form form={form} layout="vertical" onValuesChange={() => setDirty(true)}>
        <Row gutter={16}>
          <Col xs={24} md={12}>
            <Form.Item name="subcontractorId" label="分包商（从档案选择）">
              <Select
                showSearch
                allowClear
                optionFilterProp="label"
                placeholder="请选择分包商"
                options={subcontractors.map((s: any) => ({ value: s.id, label: s.subcontractorName }))}
                onChange={(id: string) => {
                  const hit = subcontractors.find((s) => s.id === id);
                  if (hit) form.setFieldsValue({ subcontractorName: hit.subcontractorName });
                }}
              />
            </Form.Item>
          </Col>
          <Col xs={24} md={12}>
            <Form.Item
              name="subcontractorName"
              label="分包商名称"
              rules={[{ required: true, message: '请填写分包商名称' }]}
            >
              <Input />
            </Form.Item>
          </Col>
          <Col xs={24} md={8}>
            <Form.Item name="period" label="账期" extra="如 2026.10；归档按账期分组">
              <Input placeholder="如 2026.10" />
            </Form.Item>
          </Col>
          <Col xs={24} md={8}>
            <Form.Item name="materialName" label="物资名称"><Input /></Form.Item>
          </Col>
          <Col xs={24} md={8}>
            <Form.Item name="spec" label="规格型号"><Input /></Form.Item>
          </Col>
          <Col xs={24} md={8}>
            <Form.Item name="unit" label="计量单位"><Input /></Form.Item>
          </Col>
          <Col xs={24} md={8}>
            <Form.Item name="qty" label="数量">
              <InputNumber style={{ width: '100%' }} min={0} precision={3} />
            </Form.Item>
          </Col>
          <Col xs={24} md={8}>
            <Form.Item name="unitPrice" label="单价" tooltip="金额 = 数量 × 单价，服务端自动计算">
              <InputNumber style={{ width: '100%' }} min={0} precision={2} />
            </Form.Item>
          </Col>
          <Col xs={24} md={12}>
            <Form.Item name="useLocation" label="使用部位"><Input /></Form.Item>
          </Col>
          <Col xs={24} md={12}>
            <Form.Item name="remark" label="备注"><Input /></Form.Item>
          </Col>
        </Row>
      </Form>
    </EditorTabPage>
  );
}
