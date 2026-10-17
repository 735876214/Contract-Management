import { useState } from 'react';
import { Button, Form, Input, InputNumber, Modal, message, Row, Col, Alert } from 'antd';
import { PlusOutlined } from '@ant-design/icons';
import { costApi } from '@/api/modules';
import ModuleListPage, { type ModuleListFilterField, type ModuleListRow } from '@/components/procurement/ModuleListPage';
import EditorTabPage from '@/components/editor/EditorTabPage';
import { useEditorTab, useTabRefresh } from '@/hooks/useTabs';

const money = (v: any) => (v == null ? '-' : `¥${Number(v).toLocaleString('zh-CN', { minimumFractionDigits: 2 })}`);
const pct = (v: any) => (v == null ? '-' : `${(Number(v) * 100).toFixed(2)}%`);

/**
 * 成本管理 · 降本创效主材盈亏分析（附件需求 2026-10-17 新增模块）。
 * 结构化台账（无上传附件）：盈亏额 = 结算额 − 实际成本、盈亏率 = 盈亏额 ÷ 结算额，服务端派生；
 * 归档时按账期导出「降本、创效、主材盈亏分析表-<账期>.xlsx」。
 */
const LIST_PATH = '/cost/profit-loss';

export default function CostProfitLoss() {
  const editorTab = useEditorTab(LIST_PATH);
  if (editorTab.isEditor) {
    return <ProfitEditor seed={editorTab.seed} />;
  }
  return <ProfitList />;
}

function ProfitList() {
  const editorTab = useEditorTab(LIST_PATH);
  const tabRefresh = useTabRefresh(LIST_PATH);
  const [listRefresh, setListRefresh] = useState(0);
  const refreshList = () => setListRefresh((k) => k + 1);

  const handleRemove = (row: ModuleListRow) => {
    Modal.confirm({
      title: '确认删除该盈亏分析记录？',
      okText: '确认删除',
      okType: 'danger',
      onOk: async () => {
        await costApi.profitLoss.remove(row.id);
        message.success('已删除');
        refreshList();
      },
    });
  };

  const extraFilters: ModuleListFilterField[] = [
    { key: 'period', label: '账期', control: 'input', placeholder: '如 2024.10' },
    { key: 'keyword', label: '主材名称', control: 'input' },
  ];

  const extraColumns: any[] = [
    { title: '账期', dataIndex: 'period', width: 100, fixed: 'left', render: (v: any) => v || '-' },
    { title: '主材名称', dataIndex: 'materialName', width: 180, render: (v: any) => v || '-' },
    { title: '合同额', dataIndex: 'contractAmount', width: 130, align: 'right' as const, render: money },
    { title: '结算额', dataIndex: 'settleAmount', width: 130, align: 'right' as const, render: money },
    { title: '实际成本', dataIndex: 'actualCost', width: 130, align: 'right' as const, render: money },
    {
      title: '盈亏额',
      dataIndex: 'profitLoss',
      width: 130,
      align: 'right' as const,
      render: (v: any) =>
        v == null ? '-' : <b style={{ color: Number(v) < 0 ? 'var(--cms-error)' : 'var(--cms-success)' }}>{money(v)}</b>,
    },
    { title: '盈亏率', dataIndex: 'profitRate', width: 100, align: 'right' as const, render: pct },
    { title: '备注', dataIndex: 'remark', width: 180, ellipsis: true, render: (v: any) => v || '-' },
  ];

  return (
    <ModuleListPage
      mode="generic"
      columnConfigKey="cost.profitLoss"
      fetcher={(params) => costApi.profitLoss.list(params)}
      extraFilters={extraFilters}
      extraColumns={extraColumns}
      refreshKey={listRefresh + tabRefresh}
      emptyText="暂无盈亏分析记录"
      onEdit={(row) => editorTab.openEdit(row.id, row)}
      onDelete={handleRemove}
      toolbarLeft={
        <Button type="primary" icon={<PlusOutlined />} onClick={() => editorTab.openCreate()}>
          新增分析
        </Button>
      }
    />
  );
}

function ProfitEditor({ seed }: { seed: unknown }) {
  const [form] = Form.useForm();
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  const editing = seed as any | undefined;

  const submit = async () => {
    const values = await form.validateFields();
    setSaving(true);
    try {
      if (editing) await costApi.profitLoss.update(editing.id, { ...values, version: editing.version });
      else await costApi.profitLoss.create(values);
      message.success('保存成功');
    } finally {
      setSaving(false);
    }
  };

  return (
    <EditorTabPage
      listPath={LIST_PATH}
      title={editing ? '编辑盈亏分析' : '新增盈亏分析'}
      saving={saving}
      dirty={dirty}
      onSave={submit}
    >
      <Alert
        type="info"
        showIcon
        style={{ marginBottom: 12 }}
        message="盈亏额 = 结算额 − 实际成本；盈亏率 = 盈亏额 ÷ 结算额。两项由服务端自动计算，不需要也不允许手填。"
      />
      <Form
        form={form}
        layout="vertical"
        onValuesChange={() => setDirty(true)}
        initialValues={editing ?? {}}
      >
        <Row gutter={16}>
          <Col xs={24} md={8}>
            <Form.Item name="period" label="账期" extra="如 2024.10；归档按账期导出">
              <Input placeholder="如 2024.10" />
            </Form.Item>
          </Col>
          <Col xs={24} md={8}>
            <Form.Item name="materialName" label="主材名称"><Input /></Form.Item>
          </Col>
          <Col xs={24} md={8}>
            <Form.Item name="contractAmount" label="合同额">
              <InputNumber style={{ width: '100%' }} min={0} precision={2} />
            </Form.Item>
          </Col>
          <Col xs={24} md={8}>
            <Form.Item name="settleAmount" label="结算额">
              <InputNumber style={{ width: '100%' }} precision={2} />
            </Form.Item>
          </Col>
          <Col xs={24} md={8}>
            <Form.Item name="actualCost" label="实际成本">
              <InputNumber style={{ width: '100%' }} precision={2} />
            </Form.Item>
          </Col>
          <Col xs={24}>
            <Form.Item name="remark" label="备注"><Input.TextArea rows={2} /></Form.Item>
          </Col>
        </Row>
      </Form>
    </EditorTabPage>
  );
}
