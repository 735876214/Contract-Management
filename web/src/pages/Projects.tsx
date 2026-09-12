import { useEffect, useState } from 'react';
import { Card, Table, Button, Form, Input, InputNumber, Space, Modal, Select, Popconfirm, message, Tag, Row, Col } from 'antd';
import { PlusOutlined, SearchOutlined } from '@ant-design/icons';
import { projectApi } from '@/api/business';
import { systemApi } from '@/api/auth';
import { useTable } from '@/hooks/useTable';
import ImportButton from '@/components/ImportButton';
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
        <Space>
          <ImportButton moduleName="项目信息" templateUrl={projectApi.templateUrl()} onUpload={(f) => projectApi.import(f)} onDone={reload} />
          <Button type="primary" icon={<PlusOutlined />} onClick={() => { setEditing(null); form.resetFields(); setModal(true); }}>
            新建项目
          </Button>
        </Space>
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
        scroll={{ x: 1950 }}
        columns={[
          { title: '项目编码', dataIndex: 'code', width: 150 },
          { title: '项目全称', dataIndex: 'name', width: 220 },
          { title: '简称（文字）', dataIndex: 'nameAbbr', width: 150 },
          { title: '简称（字母）', dataIndex: 'codeAbbr', width: 120, render: (v) => <Tag color="geekblue">{v || '-'}</Tag> },
          { title: '承接单位', dataIndex: 'undertaker', width: 150 },
          { title: '自施合同额(万元)', dataIndex: 'selfContractAmount', width: 150, render: (v) => (v == null ? '-' : Number(v).toLocaleString('zh-CN', { maximumFractionDigits: 2 })) },
          { title: '项目业态', dataIndex: 'industryType', width: 110, render: (v) => <DictTag typeCode="industry_type" value={v} /> },
          { title: '项目所在省市', dataIndex: 'provinceCity', width: 130, render: (v) => v || '-' },
          { title: '工程地点', dataIndex: 'siteLocation', width: 180, ellipsis: true, render: (v) => v || '-' },
          { title: '项目地址', dataIndex: 'projectAddress', width: 200, ellipsis: true, render: (v) => v || '-' },
          { title: '项目状态', dataIndex: 'status', width: 110, render: (v) => <DictTag typeCode="project_status" value={v} /> },
          { title: '描述', dataIndex: 'description', ellipsis: true },
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
          <Row gutter={12}>
            <Col xs={24} md={12}>
              <Form.Item name="code" label="项目编码" rules={[{ required: true }]}><Input disabled={!!editing} /></Form.Item>
            </Col>
            <Col xs={24} md={12}>
              <Form.Item name="name" label="项目全称" rules={[{ required: true }]}><Input /></Form.Item>
            </Col>
            <Col xs={24} md={12}>
              <Form.Item name="nameAbbr" label="项目简称（文字版）" rules={[{ required: true }]}><Input maxLength={50} /></Form.Item>
            </Col>
            <Col xs={24} md={12}>
              <Form.Item
                name="codeAbbr"
                label="项目简称（字母版，用于合同编号）"
                rules={[
                  { required: true, message: '字母简称用于合同编号，必填' },
                  { pattern: /^[A-Z0-9]+$/, message: '仅允许大写字母和数字' },
                ]}
              >
                <Input maxLength={20} placeholder="如 ZJJXM" />
              </Form.Item>
            </Col>
            <Col xs={24} md={12}>
              <Form.Item name="undertaker" label="承接单位" rules={[{ required: true }]}><Input maxLength={100} /></Form.Item>
            </Col>
            <Col xs={24} md={12}>
              <Form.Item name="selfContractAmount" label="项目自施合同额（万元）" rules={[{ required: true }]}>
                <InputNumber style={{ width: '100%' }} min={0} precision={2} />
              </Form.Item>
            </Col>
            <Col xs={24} md={12}>
              <Form.Item name="industryType" label="项目业态" rules={[{ required: true }]}>
                <DictSelect typeCode="industry_type" />
              </Form.Item>
            </Col>
            <Col xs={24} md={12}>
              <Form.Item name="provinceCity" label="项目所在省市"><Input maxLength={50} placeholder="如 广东省深圳市" /></Form.Item>
            </Col>
            <Col xs={24} md={12}>
              <Form.Item name="siteLocation" label="工程地点"><Input maxLength={100} placeholder="如 深圳市南山区科技园南区" /></Form.Item>
            </Col>
            <Col xs={24}>
              <Form.Item name="projectAddress" label="项目地址"><Input maxLength={150} placeholder="如 深圳市南山区科苑南路 3099 号" /></Form.Item>
            </Col>
            <Col xs={24} md={12}>
              <Form.Item name="status" label="项目状态"><DictSelect typeCode="project_status" /></Form.Item>
            </Col>
            <Col xs={24}>
              <Form.Item name="description" label="项目描述"><Input.TextArea rows={3} /></Form.Item>
            </Col>
          </Row>
        </Form>
      </Modal>

      <Modal title={`项目成员 · ${current?.name || ''}`} width={520} centered open={memberDrawer} onCancel={() => setMemberDrawer(false)} footer={null} styles={{ body: { maxHeight: 'calc(100vh - 220px)', overflowY: 'auto' } }}>
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
      </Modal>
    </Card>
  );
}
