import { useEffect, useState } from 'react';
import { withToken } from '../utils/download';
import { Card, Table, Button, Form, Input, Space, Popconfirm, Tag, Select } from 'antd';
import { message } from '@/utils/antdStatic';
import { PlusOutlined, SearchOutlined, ExportOutlined } from '@ant-design/icons';
import { otherProjectApi } from '@/api/business';
import { useTable } from '@/hooks/useTable';
import { useEditorTab, useTabRefresh } from '@/hooks/useTabs';
import { usePermission } from '@/hooks/usePermission';
import EditorTabPage from '@/components/editor/EditorTabPage';
import ImportButton from '@/components/ImportButton';
import Can from '@/components/Can';

/** 列表与「新增/编辑」是同一路由的两种形态（`?editor=new|<id>`），见 useEditorTab 注释 */
const LIST_PATH = '/base/other-project';

/**
 * 其他项目库（2026-11-20 新增）：收领单「供应单位 / 领用单位」里「其他项目」这一类
 * 从原来的字典项升格为独立主数据，便于登记编码与备注、按项目隔离与导入导出。
 */
export default function OtherProjects() {
  const editorTab = useEditorTab(LIST_PATH);
  if (editorTab.isEditor) {
    return <OtherProjectEditor seed={editorTab.seed} />;
  }
  return <OtherProjectList />;
}

function OtherProjectList() {
  const editorTab = useEditorTab(LIST_PATH);
  const tabRefresh = useTabRefresh(LIST_PATH);
  const canEdit = usePermission('other-project:edit');
  const { loading, list, search, reload, pagination } = useTable<any>((p) => otherProjectApi.list(p));

  // 编辑器标签保存后 bump 令牌 → 本（被缓存的）列表标签重新取数
  useEffect(() => {
    if (tabRefresh) reload();
  }, [tabRefresh, reload]);

  return (
    <Card
      title="其他项目库"
      extra={
        <Space>
          <Can code="other-project:edit">
            <ImportButton
              moduleName="其他项目"
              templateUrl={otherProjectApi.templateUrl()}
              uploadUrl={otherProjectApi.importUrl()}
              validateUrl={otherProjectApi.validateUrl()}
              onDone={reload}
            />
          </Can>
          <Button icon={<ExportOutlined />} onClick={() => window.open(withToken(otherProjectApi.exportUrl()))}>导出</Button>
          <Can code="other-project:edit">
            <Button type="primary" icon={<PlusOutlined />} onClick={() => editorTab.openCreate()}>
              新增其他项目
            </Button>
          </Can>
        </Space>
      }
    >
      <Form layout="inline" style={{ marginBottom: 16, rowGap: 8 }} onFinish={(v) => search(v)}>
        <Form.Item name="keyword"><Input placeholder="编码/名称" allowClear prefix={<SearchOutlined />} /></Form.Item>
        <Form.Item name="status">
          <Select
            allowClear
            placeholder="状态"
            style={{ width: 140 }}
            options={[{ value: 1, label: '启用' }, { value: 0, label: '停用' }]}
          />
        </Form.Item>
        <Form.Item><Button type="primary" htmlType="submit">查询</Button></Form.Item>
      </Form>

      <Table
        rowKey="id"
        loading={loading}
        dataSource={list}
        pagination={pagination}
        scroll={{ x: 900 }}
        columns={[
          { title: '项目编码', dataIndex: 'code', width: 160, render: (v: any) => v || '-' },
          { title: '项目名称', dataIndex: 'name', ellipsis: true },
          { title: '备注', dataIndex: 'remark', ellipsis: true, render: (v: any) => v || '-' },
          {
            title: '状态',
            dataIndex: 'status',
            width: 90,
            render: (s) => (s === 1 ? <Tag color="green">启用</Tag> : <Tag>停用</Tag>),
          },
          {
            title: '操作',
            width: 200,
            fixed: 'right',
            render: (_, row) =>
              canEdit ? (
                <Space size={4}>
                  <Button type="link" size="small" onClick={() => editorTab.openEdit(row.id, row)}>编辑</Button>
                  <Button type="link" size="small" onClick={async () => { await otherProjectApi.toggle(row.id); reload(); }}>
                    {row.status === 1 ? '停用' : '启用'}
                  </Button>
                  <Popconfirm title="被收领单引用时不可删除" onConfirm={async () => { await otherProjectApi.remove(row.id); message.success('已删除'); reload(); }}>
                    <Button type="link" size="small" danger>删除</Button>
                  </Popconfirm>
                </Space>
              ) : null,
          },
        ]}
      />
    </Card>
  );
}

function OtherProjectEditor({ seed }: { seed: unknown }) {
  const editorTab = useEditorTab(LIST_PATH);
  const [form] = Form.useForm();
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  const editing = seed as any | undefined;

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
      // 乐观锁：编辑态必须回传 version，否则后端 assertVersion 抛 409
      if (editing) await otherProjectApi.update(editing.id, { ...values, version: editing.version });
      else await otherProjectApi.create(values);
      message.success('保存成功');
      editorTab.closeEditor();
    } finally {
      setSaving(false);
    }
  };

  return (
    <EditorTabPage
      listPath={LIST_PATH}
      title={editing ? '编辑其他项目' : '新增其他项目'}
      saving={saving}
      dirty={dirty}
      onSave={submit}
    >
      <Form form={form} layout="vertical" onValuesChange={() => setDirty(true)}>
        <Form.Item name="name" label="项目名称（本项目内唯一）" rules={[{ required: true }]}><Input /></Form.Item>
        <Form.Item name="code" label="项目编码"><Input placeholder="可选，用于与其他项目台账对号" /></Form.Item>
        <Form.Item name="remark" label="备注"><Input.TextArea rows={2} /></Form.Item>
      </Form>
    </EditorTabPage>
  );
}
