import { useEffect, useState } from 'react';
import { Card, Table, Button, Form, Input, Space, Modal, Select, Popconfirm, message, Drawer, Tag, Row, Col } from 'antd';
import { PlusOutlined, SearchOutlined } from '@ant-design/icons';
import { projectApi } from '@/api/business';
import { systemApi } from '@/api/auth';
import { useTable } from '@/hooks/useTable';
import DictSelect, { DictTag } from '@/components/DictSelect';

export default function Projects() {
  const { loading, list, total, params, search, reload, pagination } = useTable<any>((p) => projectApi.list(p));
  const [form] = Form.useForm();
  const [modal, setModal] = useState(false);
  const [editing, setEditing] = useState<any>(null);
  const [memberDrawer, setMemberDrawer] = useState(false);
  const [current, setCurrent] = useState<any>(null);
  const [members, setMembers] = useState<any[]>([]);
  const [users, setUsers] = useState<any[]>([]);

  useEffect(() => {
    systemApi.users({ pageSize: 500 }).then((res: any) => setUsers(res.list || []));
  }, []);

  const submit = async () => {
    const values = await form.validateFields();
    if (editing) await projectApi.update(editing.id, values);
    else await projectApi.create(values);
    message.success('保存成功');
    setModal(false);
    form.resetFields();
    setEditing(null);
    reload();
  };

  const openMembers = async (row: any) => {
    setCurrent(row);
    const res: any = await projectApi.members(row.id);
    setMembers(res || []);
    setMemberDrawer(true);
  };

  const addMember = async (userId: string, roleCode: string) => {
    await projectApi.addMember(current.id, { userId, roleCode });
    const res: any = await projectApi.members(current.id);
    setMembers(res || []);
    message.success('已添加');
  };

  return (
    <Card
      title="项目管理"
      extra={
        <Button type="primary" icon={<PlusOutlined />} onClick={() => { setEditing(null); form.resetFields(); setModal(true); }}>
          新建项目
        </Button>
      }
    >
      <Form layout="inline" style={{ marginBottom: 16, rowGap: 8 }} onFinish={(v) => search(v)}>
        <Form.Item name="keyword"><Input placeholder="项目名称/编码" allowClear prefix={<SearchOutlined />} /></Form.Item>
        <Form.Item name="status"><DictSelect typeCode="project_status" placeholder="项目状态" /></Form.Item>
        <Form.Item><Button type="primary" htmlType="submit">查询</Button></Form.Item>
      </Form>

      <Table
        rowKey="id"
        loading={loading}
        dataSource={list}
        pagination={pagination}
        scroll={{ x: 1100 }}
        columns={[
          { title: '项目编码', dataIndex: 'code', width: 160 },
          { title: '项目名称', dataIndex: 'name', width: 220 },
          { title: '项目状态', dataIndex: 'status', width: 110, render: (v) => <DictTag typeCode="project_status" value={v} /> },
          { title: '描述', dataIndex: 'description' },
          {
            title: '成员数',
            width: 90,
            render: (_, row) => <Tag color="blue">{row.members?.length ?? 0}</Tag>,
          },
          { title: '创建时间', dataIndex: 'createdAt', width: 170, render: (v) => v?.slice(0, 19).replace('T', ' ') },
          {
            title: '操作',
            width: 200,
            fixed: 'right',
            render: (_, row) => (
              <Space size={4}>
                <Button type="link" size="small" onClick={() => openMembers(row)}>成员</Button>
                <Button type="link" size="small" onClick={() => { setEditing(row); form.setFieldsValue(row); setModal(true); }}>编辑</Button>
                <Popconfirm title="确认删除？有业务数据时不可删除" onConfirm={async () => { await projectApi.remove(row.id); message.success('已删除'); reload(); }}>
                  <Button type="link" size="small" danger>删除</Button>
                </Popconfirm>
              </Space>
            ),
          },
        ]}
      />

      <Modal title={editing ? '编辑项目' : '新建项目'} open={modal} onOk={submit} onCancel={() => setModal(false)} destroyOnClose>
        <Form form={form} layout="vertical">
          <Form.Item name="code" label="项目编码" rules={[{ required: true }]}><Input disabled={!!editing} /></Form.Item>
          <Form.Item name="name" label="项目名称" rules={[{ required: true }]}><Input /></Form.Item>
          <Form.Item name="status" label="项目状态"><DictSelect typeCode="project_status" /></Form.Item>
          <Form.Item name="description" label="项目描述"><Input.TextArea rows={3} /></Form.Item>
        </Form>
      </Modal>

      <Drawer title={`项目成员 · ${current?.name || ''}`} width={520} open={memberDrawer} onClose={() => setMemberDrawer(false)}>
        <Row gutter={8} style={{ marginBottom: 16 }}>
          <Col flex="auto">
            <Select
              style={{ width: '100%' }}
              placeholder="选择用户"
              options={users.map((u: any) => ({ value: u.id, label: `${u.realName}（${u.username}）` }))}
              onChange={(userId) => addMember(userId, 'MEMBER')}
              value={null}
            />
          </Col>
        </Row>
        <Table
          rowKey="id"
          size="small"
          dataSource={members}
          pagination={false}
          columns={[
            { title: '姓名', render: (_, row: any) => row.user?.realName },
            { title: '账号', render: (_, row: any) => row.user?.username },
            {
              title: '项目角色',
              dataIndex: 'roleCode',
              render: (v, row: any) => (
                <Select
                  size="small"
                  value={v}
                  style={{ width: 140 }}
                  onChange={(roleCode) => addMember(row.userId, roleCode)}
                  options={[
                    { value: 'ADMIN', label: '项目管理员' },
                    { value: 'MEMBER', label: '项目成员' },
                    { value: 'READONLY', label: '只读用户' },
                  ]}
                />
              ),
            },
            {
              title: '操作',
              render: (_, row: any) => (
                <Popconfirm title="移除该成员？" onConfirm={async () => {
                  await projectApi.removeMember(current.id, row.userId);
                  setMembers((await projectApi.members(current.id)) as any);
                }}>
                  <Button type="link" size="small" danger>移除</Button>
                </Popconfirm>
              ),
            },
          ]}
        />
      </Drawer>
    </Card>
  );
}
