import { useEffect, useMemo, useState } from 'react';
import { Button, Form, Input, Select, Space, Modal, message, Row, Col, DatePicker } from 'antd';
import { PlusOutlined } from '@ant-design/icons';
import dayjs from 'dayjs';
import { laborApi, subcontractorApi } from '@/api/modules';
import ModuleListPage, { type ModuleListFilterField, type ModuleListRow } from '@/components/procurement/ModuleListPage';
import EditorTabPage from '@/components/editor/EditorTabPage';
import { useEditorTab, useTabRefresh } from '@/hooks/useTabs';

/**
 * 劳务管理 · 分包授权台账（附件需求 2026-10-17 新增模块）。
 * 台账登记：选中分包商自动带出名称/法人/授权人快照（可改）；归档时与分包商档案的照片合并导出。
 */
const LIST_PATH = '/labor/auth';

export default function LaborAuth() {
  const editorTab = useEditorTab(LIST_PATH);
  if (editorTab.isEditor) {
    return <AuthEditor seed={editorTab.seed} />;
  }
  return <AuthList />;
}

function AuthList() {
  const editorTab = useEditorTab(LIST_PATH);
  const tabRefresh = useTabRefresh(LIST_PATH);
  const [listRefresh, setListRefresh] = useState(0);
  const refreshList = () => setListRefresh((k) => k + 1);

  const handleRemove = (row: ModuleListRow) => {
    Modal.confirm({
      title: '确认删除该台账记录？',
      okText: '确认删除',
      okType: 'danger',
      onOk: async () => {
        await laborApi.remove(row.id);
        message.success('已删除');
        refreshList();
      },
    });
  };

  const extraFilters: ModuleListFilterField[] = [
    { key: 'keyword', label: '关键词', control: 'input', placeholder: '分包商 / 授权人 / 备注' },
  ];

  const extraColumns: any[] = [
    { title: '分包商名称', dataIndex: 'subcontractorName', width: 240, fixed: 'left' },
    { title: '法人代表', dataIndex: 'legalPerson', width: 140, render: (v: any) => v || '-' },
    { title: '授权委托人', dataIndex: 'authorizedPerson', width: 140, render: (v: any) => v || '-' },
    {
      title: '授权期间',
      key: 'authRange',
      width: 220,
      render: (_: any, r: any) =>
        r.authStartDate || r.authEndDate
          ? `${r.authStartDate ? r.authStartDate.slice(0, 10) : '?'} ~ ${r.authEndDate ? r.authEndDate.slice(0, 10) : '?'}`
          : '-',
    },
    { title: '备注', dataIndex: 'remark', width: 200, ellipsis: true, render: (v: any) => v || '-' },
  ];

  return (
    <ModuleListPage
      mode="generic"
      columnConfigKey="labor.auth"
      fetcher={(params) => laborApi.list(params)}
      extraFilters={extraFilters}
      extraColumns={extraColumns}
      refreshKey={listRefresh + tabRefresh}
      emptyText="暂无分包授权台账记录"
      onEdit={(row) => editorTab.openEdit(row.id, row)}
      onDelete={handleRemove}
      toolbarLeft={
        <Button type="primary" icon={<PlusOutlined />} onClick={() => editorTab.openCreate()}>
          新增台账
        </Button>
      }
    />
  );
}

function AuthEditor({ seed }: { seed: unknown }) {
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
    if (editing) {
      form.setFieldsValue({
        ...editing,
        authStartDate: editing.authStartDate ? dayjs(editing.authStartDate) : null,
        authEndDate: editing.authEndDate ? dayjs(editing.authEndDate) : null,
      });
    }
    setDirty(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editing]);

  const submit = async () => {
    const values = await form.validateFields();
    const payload = {
      ...values,
      authStartDate: values.authStartDate ? values.authStartDate.format('YYYY-MM-DD') : null,
      authEndDate: values.authEndDate ? values.authEndDate.format('YYYY-MM-DD') : null,
    };
    setSaving(true);
    try {
      if (editing) await laborApi.update(editing.id, { ...payload, version: editing.version });
      else await laborApi.create(payload);
      message.success('保存成功');
    } finally {
      setSaving(false);
    }
  };

  return (
    <EditorTabPage
      listPath={LIST_PATH}
      title={editing ? '编辑分包授权台账' : '新增分包授权台账'}
      saving={saving}
      dirty={dirty}
      onSave={submit}
    >
      <Form form={form} layout="vertical" onValuesChange={() => setDirty(true)}>
        <Row gutter={16}>
          <Col xs={24} md={12}>
            <Form.Item name="subcontractorId" label="分包商（从档案选择）" tooltip="选择后自动带出名称/法人/授权人快照">
              <Select
                showSearch
                allowClear
                optionFilterProp="label"
                placeholder="请选择分包商"
                options={subcontractors.map((s: any) => ({ value: s.id, label: s.subcontractorName }))}
                onChange={(id: string) => {
                  const hit = subcontractors.find((s) => s.id === id);
                  if (hit) {
                    form.setFieldsValue({
                      subcontractorName: hit.subcontractorName,
                      legalPerson: hit.legalPerson,
                      authorizedPerson: hit.authorizedPerson,
                    });
                  }
                }}
              />
            </Form.Item>
          </Col>
          <Col xs={24} md={12}>
            <Form.Item
              name="subcontractorName"
              label="分包商名称"
              rules={[{ required: true, message: '请填写分包商名称' }]}
              tooltip="选择分包商后自动带出，可改"
            >
              <Input />
            </Form.Item>
          </Col>
          <Col xs={24} md={12}>
            <Form.Item name="legalPerson" label="法人代表"><Input /></Form.Item>
          </Col>
          <Col xs={24} md={12}>
            <Form.Item name="authorizedPerson" label="授权委托人"><Input /></Form.Item>
          </Col>
          <Col xs={24} md={12}>
            <Form.Item name="authStartDate" label="授权期间起">
              <DatePicker format="YYYY-MM-DD" style={{ width: '100%' }} />
            </Form.Item>
          </Col>
          <Col xs={24} md={12}>
            <Form.Item name="authEndDate" label="授权期间止">
              <DatePicker format="YYYY-MM-DD" style={{ width: '100%' }} />
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
