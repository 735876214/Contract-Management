import { useEffect, useState } from 'react';
import {
  Card,
  Tabs,
  Table,
  Button,
  Form,
  Input,
  Select,
  Tree,
  Space,
  Modal,
  Popconfirm,
  Tag,
  InputNumber,
  message,
} from 'antd';
import { PlusOutlined, ReloadOutlined, DeleteOutlined } from '@ant-design/icons';
import { systemApi } from '@/api/auth';
import { useTable } from '@/hooks/useTable';

const STATUS_TAG = (v: any) => (v === 1 || v === '1' ? <Tag color="green">启用</Tag> : <Tag>停用</Tag>);

/* ---------------- 用户管理 ---------------- */
function UsersTab() {
  const { loading, list, pagination, reload } = useTable<any>((p) => systemApi.users(p));
  const [depts, setDepts] = useState<any[]>([]);
  const [roles, setRoles] = useState<any[]>([]);
  const [modal, setModal] = useState(false);
  const [editing, setEditing] = useState<any>(null);
  const [pwdModal, setPwdModal] = useState(false);
  const [pwdUser, setPwdUser] = useState<any>(null);
  const [pwd, setPwd] = useState('');
  const [form] = Form.useForm();

  useEffect(() => {
    systemApi.depts().then((r: any) => setDepts(r || []));
    systemApi.roles().then((r: any) => setRoles(r || []));
  }, []);

  const openCreate = () => {
    setEditing(null);
    form.resetFields();
    form.setFieldsValue({ status: 1 });
    setModal(true);
  };

  const openEdit = (row: any) => {
    setEditing(row);
    form.resetFields();
    form.setFieldsValue({
      ...row,
      roles: row.roles ? (Array.isArray(row.roles) ? row.roles : String(row.roles).split(',')) : [],
    });
    setModal(true);
  };

  const submit = async () => {
    const values: any = await form.validateFields();
    const payload = { ...values, roles: values.roles || [] };
    if (editing) await systemApi.updateUser(editing.id, payload);
    else await systemApi.createUser(payload);
    message.success('保存成功');
    setModal(false);
    reload();
  };

  const openReset = (row: any) => {
    setPwdUser(row);
    setPwd('');
    setPwdModal(true);
  };

  const submitReset = async () => {
    await systemApi.resetPassword(pwdUser.id, pwd);
    message.success('密码已重置');
    setPwdModal(false);
  };

  return (
    <Card
      title="用户管理"
      extra={<Button type="primary" icon={<PlusOutlined />} onClick={openCreate}>新增用户</Button>}
    >
      <Table
        rowKey="id"
        loading={loading}
        dataSource={list}
        pagination={pagination}
        scroll={{ x: 1400 }}
        columns={[
          { title: '用户名', dataIndex: 'username', width: 160 },
          { title: '姓名', dataIndex: 'realName', width: 120 },
          { title: '部门', dataIndex: 'deptName', width: 140 },
          { title: '手机', dataIndex: 'phone', width: 140 },
          { title: '邮箱', dataIndex: 'email', width: 200, ellipsis: true },
          { title: '状态', dataIndex: 'status', width: 90, render: STATUS_TAG },
          { title: '角色', dataIndex: 'roleNames', width: 220, ellipsis: true },
          {
            title: '操作',
            width: 220,
            fixed: 'right',
            render: (_: any, row: any) => (
              <Space size={4}>
                <Button type="link" size="small" onClick={() => openEdit(row)}>编辑</Button>
                <Button type="link" size="small" icon={<ReloadOutlined />} onClick={() => openReset(row)}>重置密码</Button>
                <Popconfirm title="确认删除该用户？" onConfirm={async () => { await systemApi.removeUser(row.id); message.success('已删除'); reload(); }}>
                  <Button type="link" size="small" danger>删除</Button>
                </Popconfirm>
              </Space>
            ),
          },
        ]}
      />

      <Modal title={editing ? '编辑用户' : '新增用户'} open={modal} onOk={submit} onCancel={() => setModal(false)} width={640} destroyOnClose>
        <Form form={form} layout="vertical">
          <Form.Item name="username" label="用户名" rules={[{ required: true }]}>
            <Input disabled={!!editing} />
          </Form.Item>
          {!editing && (
            <Form.Item name="password" label="密码" rules={[{ required: true }]}>
              <Input.Password />
            </Form.Item>
          )}
          <Form.Item name="realName" label="姓名" rules={[{ required: true }]}>
            <Input />
          </Form.Item>
          <Form.Item name="phone" label="手机"><Input /></Form.Item>
          <Form.Item name="email" label="邮箱"><Input /></Form.Item>
          <Form.Item name="deptId" label="部门">
            <Select
              allowClear
              placeholder="请选择部门"
              options={depts.map((d) => ({ value: d.id, label: d.name }))}
            />
          </Form.Item>
          <Form.Item name="status" label="状态" rules={[{ required: true }]}>
            <Select options={[{ value: 1, label: '启用' }, { value: 0, label: '停用' }]} />
          </Form.Item>
          <Form.Item name="roles" label="角色">
            <Select
              mode="multiple"
              allowClear
              placeholder="请选择角色"
              options={roles.map((r) => ({ value: r.id, label: r.name }))}
            />
          </Form.Item>
        </Form>
      </Modal>

      <Modal title={`重置密码 - ${pwdUser?.realName || pwdUser?.username}`} open={pwdModal} onOk={submitReset} onCancel={() => setPwdModal(false)} okText="确认重置">
        <Input.Password placeholder="请输入新密码" value={pwd} onChange={(e) => setPwd(e.target.value)} />
      </Modal>
    </Card>
  );
}

/* ---------------- 角色管理 ---------------- */
function RolesTab() {
  const [roles, setRoles] = useState<any[]>([]);
  const [permissions, setPermissions] = useState<any[]>([]);
  const [modal, setModal] = useState(false);
  const [editing, setEditing] = useState<any>(null);
  const [form] = Form.useForm();
  const [checkedKeys, setCheckedKeys] = useState<any[]>([]);

  const load = () => systemApi.roles().then((r: any) => setRoles(r || []));
  useEffect(() => {
    load();
    systemApi.permissions().then((r: any) => setPermissions(r || []));
  }, []);

  const treeData = permissions.map((p) => ({
    title: p.module,
    key: p.module,
    selectable: false,
    children: (p.items || []).map((i: any) => ({ title: i.name, key: i.id })),
  }));

  const openCreate = () => {
    setEditing(null);
    form.resetFields();
    setCheckedKeys([]);
    setModal(true);
  };

  const openEdit = (row: any) => {
    setEditing(row);
    form.resetFields();
    form.setFieldsValue({ code: row.code, name: row.name, remark: row.remark });
    setCheckedKeys(row.permissionIds || []);
    setModal(true);
  };

  const submit = async () => {
    const values: any = await form.validateFields();
    const payload = { ...values, permissionIds: checkedKeys };
    if (editing) await systemApi.updateRole(editing.id, payload);
    else await systemApi.createRole(payload);
    message.success('保存成功');
    setModal(false);
    load();
  };

  return (
    <Card title="角色管理" extra={<Button type="primary" icon={<PlusOutlined />} onClick={openCreate}>新增角色</Button>}>
      <Table
        rowKey="id"
        dataSource={roles}
        pagination={false}
        columns={[
          { title: '角色编码', dataIndex: 'code', width: 180 },
          { title: '名称', dataIndex: 'name', width: 180 },
          { title: '备注', dataIndex: 'remark', ellipsis: true },
          { title: '权限数', dataIndex: 'permissionCount', width: 100, render: (v: any) => v ?? (editing?.permissionIds?.length || 0) },
          {
            title: '操作',
            width: 160,
            render: (_: any, row: any) => (
              <Space size={4}>
                <Button type="link" size="small" onClick={() => openEdit(row)}>编辑</Button>
                <Popconfirm title="确认删除该角色？" onConfirm={async () => { await systemApi.removeRole(row.id); message.success('已删除'); load(); }}>
                  <Button type="link" size="small" danger>删除</Button>
                </Popconfirm>
              </Space>
            ),
          },
        ]}
      />
      <Modal title={editing ? '编辑角色' : '新增角色'} open={modal} onOk={submit} onCancel={() => setModal(false)} width={560} destroyOnClose>
        <Form form={form} layout="vertical">
          <Form.Item name="code" label="角色编码" rules={[{ required: true }]}><Input disabled={!!editing} /></Form.Item>
          <Form.Item name="name" label="名称" rules={[{ required: true }]}><Input /></Form.Item>
          <Form.Item name="remark" label="备注"><Input.TextArea rows={2} /></Form.Item>
          <Form.Item label="权限">
            <Tree
              checkable
              treeData={treeData}
              checkedKeys={checkedKeys}
              onCheck={(keys) => setCheckedKeys(keys as any[])}
            />
          </Form.Item>
        </Form>
      </Modal>
    </Card>
  );
}

/* ---------------- 部门管理 ---------------- */
function DeptsTab() {
  const [depts, setDepts] = useState<any[]>([]);
  const [modal, setModal] = useState(false);
  const [editing, setEditing] = useState<any>(null);
  const [form] = Form.useForm();

  const load = () => systemApi.depts().then((r: any) => setDepts(r || []));
  useEffect(() => { load(); }, []);

  const buildTree = (list: any[]) => {
    const map: any = {};
    const roots: any[] = [];
    list.forEach((d) => (map[d.id] = { ...d, children: [] }));
    list.forEach((d) => {
      if (d.parentId && map[d.parentId]) map[d.parentId].children.push(map[d.id]);
      else roots.push(map[d.id]);
    });
    return roots;
  };

  const openCreate = (parentId?: string) => {
    setEditing(null);
    form.resetFields();
    form.setFieldsValue({ parentId, sort: 0 });
    setModal(true);
  };

  const openEdit = (row: any) => {
    setEditing(row);
    form.resetFields();
    form.setFieldsValue(row);
    setModal(true);
  };

  const submit = async () => {
    const values: any = await form.validateFields();
    if (editing) await systemApi.updateDept(editing.id, values);
    else await systemApi.createDept(values);
    message.success('保存成功');
    setModal(false);
    load();
  };

  return (
    <Card title="部门管理" extra={<Button type="primary" icon={<PlusOutlined />} onClick={() => openCreate()}>新增部门</Button>}>
      <Table
        rowKey="id"
        dataSource={buildTree(depts)}
        pagination={false}
        columns={[
          { title: '部门名称', dataIndex: 'name', width: 240 },
          { title: '排序', dataIndex: 'sort', width: 100 },
          { title: '备注', dataIndex: 'remark', ellipsis: true },
          {
            title: '操作',
            width: 220,
            render: (_: any, row: any) => (
              <Space size={4}>
                <Button type="link" size="small" onClick={() => openCreate(row.id)}>新增子部门</Button>
                <Button type="link" size="small" onClick={() => openEdit(row)}>编辑</Button>
                <Popconfirm title="确认删除该部门？" onConfirm={async () => { await systemApi.removeDept(row.id); message.success('已删除'); load(); }}>
                  <Button type="link" size="small" danger>删除</Button>
                </Popconfirm>
              </Space>
            ),
          },
        ]}
      />
      <Modal title={editing ? '编辑部门' : '新增部门'} open={modal} onOk={submit} onCancel={() => setModal(false)} width={520} destroyOnClose>
        <Form form={form} layout="vertical">
          <Form.Item name="name" label="部门名称" rules={[{ required: true }]}><Input /></Form.Item>
          <Form.Item name="parentId" label="上级部门">
            <Select
              allowClear
              placeholder="顶级部门"
              options={depts.map((d) => ({ value: d.id, label: d.name }))}
            />
          </Form.Item>
          <Form.Item name="sort" label="排序"><InputNumber min={0} style={{ width: '100%' }} /></Form.Item>
          <Form.Item name="remark" label="备注"><Input.TextArea rows={2} /></Form.Item>
        </Form>
      </Modal>
    </Card>
  );
}

/* ---------------- 系统参数 ---------------- */
const PARAM_REMARK: Record<string, string> = {
  'contract.code.unique.scope': '合同编号唯一性：GLOBAL 全局唯一 / PROJECT 项目内唯一',
  'supplier.share.scope': '供应商库共享范围',
  'multi.project.enabled': '是否启用多项目模式',
  'repayment.code.prefix': '还款协议编号前缀',
  'contract.code.prefix': '合同编号前缀',
  'contract.code.fixed_prefix': '合同编号固定前缀（第1段，如 CSCEC）',
  'contract.code.type_mapping': '合同类型→编号第2段映射（按字典「合同类型」项名称匹配）',
  'contract.code.sub_type_mapping': '合同子类型→编号第4段映射（按字典「合同子类型」项名称匹配）',
  'contract.code.seq_digits': '合同编号顺序码位数（如 3 → 001）',
  'contract.code.year_reset': '顺序码是否按年重置（true/false）',
};

/** JSON 映射表编辑器（名称 ↔ 编码段，支持增删改） */
function MappingEditor({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  let entries: [string, string][] = [];
  try {
    entries = Object.entries(JSON.parse(value || '{}'));
  } catch {
    /* JSON 损坏时视为空，保存后修复 */
  }
  const update = (list: [string, string][]) => {
    const out: Record<string, string> = {};
    list.forEach(([k, v]) => {
      if (k.trim()) out[k.trim()] = v.trim();
    });
    onChange(JSON.stringify(out));
  };
  return (
    <div>
      {entries.map(([k, v], i) => (
        <Space.Compact key={i} style={{ marginBottom: 4, display: 'flex' }}>
          <Input
            style={{ width: 150 }}
            value={k}
            placeholder="字典项名称"
            onChange={(e) => {
              const list = [...entries];
              list[i] = [e.target.value, v];
              update(list);
            }}
          />
          <Input
            style={{ width: 100 }}
            value={v}
            placeholder="编码段"
            onChange={(e) => {
              const list = [...entries];
              list[i] = [k, e.target.value];
              update(list);
            }}
          />
          <Button size="small" type="text" danger icon={<DeleteOutlined />} onClick={() => update(entries.filter((_, j) => j !== i))} />
        </Space.Compact>
      ))}
      <Button size="small" icon={<PlusOutlined />} onClick={() => update([...entries, ['', '']] as [string, string][])}>
        添加映射
      </Button>
    </div>
  );
}

function ParamsTab() {
  const [params, setParams] = useState<any[]>([]);

  const load = () => systemApi.params().then((r: any) => setParams(r || []));
  useEffect(() => { load(); }, []);

  const onChangeValue = (key: string, v: string) =>
    setParams((ps) => ps.map((p) => (p.key === key ? { ...p, value: v } : p)));

  const save = async () => {
    await systemApi.saveParams(params.map((p) => ({ key: p.key, value: p.value })));
    message.success('参数已保存');
    load();
  };

  return (
    <Card
      title="系统参数"
      extra={<Button type="primary" onClick={save}>保存</Button>}
    >
      <Table
        rowKey="key"
        dataSource={params}
        pagination={false}
        columns={[
          { title: '参数键', dataIndex: 'key', width: 260 },
          {
            title: '参数值',
            dataIndex: 'value',
            width: 340,
            render: (v: any, row: any) =>
              row.key.endsWith('_mapping') ? (
                <MappingEditor value={v} onChange={(nv) => onChangeValue(row.key, nv)} />
              ) : (
                <Input value={v} onChange={(e) => onChangeValue(row.key, e.target.value)} />
              ),
          },
          {
            title: '说明',
            dataIndex: 'remark',
            ellipsis: true,
            render: (v: any, row: any) => v || PARAM_REMARK[row.key] || '-',
          },
        ]}
      />
    </Card>
  );
}

/* ---------------- 日志 ---------------- */
/** 尝试把 JSON 字符串格式化展示，失败原样输出 */
function tryPretty(v: any): string {
  if (!v) return '-';
  try {
    return JSON.stringify(JSON.parse(v), null, 2);
  } catch {
    return String(v);
  }
}

function LogsTab() {
  const op = useTable<any>((p) => systemApi.operationLogs(p));
  const login = useTable<any>((p) => systemApi.loginLogs(p));
  const [filters, setFilters] = useState<any>({});
  const [detail, setDetail] = useState<any>(null);

  const applyFilters = () => op.search(filters);
  const resetFilters = () => {
    setFilters({});
    op.search({ keyword: undefined, module: undefined, action: undefined, result: undefined });
  };

  return (
    <Card title="日志">
      <Tabs
        items={[
          {
            key: 'op',
            label: '操作日志',
            children: (
              <>
                <Space style={{ marginBottom: 12 }} wrap>
                  <Input
                    allowClear
                    placeholder="关键字（用户 / 动作 / 请求 / 业务ID）"
                    style={{ width: 240 }}
                    value={filters.keyword}
                    onChange={(e) => setFilters((f: any) => ({ ...f, keyword: e.target.value }))}
                  />
                  <Select
                    allowClear
                    placeholder="模块"
                    style={{ width: 150 }}
                    value={filters.module}
                    onChange={(v) => setFilters((f: any) => ({ ...f, module: v }))}
                    options={[
                      '项目信息', '供应商库', '合同台账', '合同物资清单', '物资基础库', '物资日报',
                      '结算单', '结算台账', '付款台账', '发票台账', '还款协议', '资产管理台账',
                      '数据字典', '合同模板', '资金费用', '系统管理',
                    ].map((v) => ({ label: v, value: v }))}
                  />
                  <Select
                    allowClear
                    placeholder="动作"
                    style={{ width: 110 }}
                    value={filters.action}
                    onChange={(v) => setFilters((f: any) => ({ ...f, action: v }))}
                    options={['新增', '修改', '删除', '导入', '导出', '启停'].map((v) => ({ label: v, value: v }))}
                  />
                  <Select
                    allowClear
                    placeholder="结果"
                    style={{ width: 110 }}
                    value={filters.result}
                    onChange={(v) => setFilters((f: any) => ({ ...f, result: v }))}
                    options={[{ label: '成功', value: 'SUCCESS' }, { label: '失败', value: 'FAIL' }]}
                  />
                  <Button type="primary" onClick={applyFilters}>查询</Button>
                  <Button onClick={resetFilters}>重置</Button>
                  <Button icon={<ReloadOutlined />} onClick={op.reload}>刷新</Button>
                </Space>
                <Table
                  rowKey="id"
                  loading={op.loading}
                  dataSource={op.list}
                  pagination={op.pagination}
                  scroll={{ x: 1500 }}
                  columns={[
                    { title: '用户', dataIndex: 'username', width: 120, render: (v: any) => v || '-' },
                    { title: '模块', dataIndex: 'module', width: 130 },
                    { title: '动作', dataIndex: 'action', width: 80 },
                    {
                      title: '结果',
                      dataIndex: 'result',
                      width: 80,
                      render: (v: any) => <Tag color={v === 'FAIL' ? 'red' : 'green'}>{v === 'FAIL' ? '失败' : '成功'}</Tag>,
                    },
                    { title: '请求', dataIndex: 'url', ellipsis: true },
                    {
                      title: '导入统计',
                      dataIndex: 'importRows',
                      width: 130,
                      render: (v: any, row: any) =>
                        v == null ? '-' : (
                          <span>
                            共 {v} 行，成功 <span style={{ color: '#3f8600' }}>{row.successCount ?? 0}</span>
                            {row.failCount ? <span style={{ color: '#cf1322' }}>，失败 {row.failCount}</span> : null}
                          </span>
                        ),
                    },
                    { title: '耗时(ms)', dataIndex: 'duration', width: 90, render: (v: any) => v ?? '-' },
                    { title: 'IP', dataIndex: 'ip', width: 130 },
                    {
                      title: '时间',
                      dataIndex: 'createdAt',
                      width: 180,
                      render: (v: any) => (v ? new Date(v).toLocaleString('zh-CN') : '-'),
                    },
                    {
                      title: '操作',
                      width: 80,
                      fixed: 'right',
                      render: (_: any, row: any) => (
                        <Button type="link" size="small" onClick={() => setDetail(row)}>详情</Button>
                      ),
                    },
                  ]}
                />
                <Modal
                  title="操作日志详情"
                  open={!!detail}
                  onCancel={() => setDetail(null)}
                  footer={null}
                  width={860}
                >
                  {detail && (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                      <div>
                        <strong>请求参数</strong>
                        <pre style={{ maxHeight: 200, overflow: 'auto', background: '#fafafa', padding: 8, borderRadius: 4, margin: '4px 0 0' }}>
                          {tryPretty(detail.params)}
                        </pre>
                      </div>
                      <div>
                        <strong>变更前数据</strong>
                        <pre style={{ maxHeight: 240, overflow: 'auto', background: '#fff7e6', padding: 8, borderRadius: 4, margin: '4px 0 0' }}>
                          {tryPretty(detail.beforeData)}
                        </pre>
                      </div>
                      <div>
                        <strong>变更后数据</strong>
                        <pre style={{ maxHeight: 240, overflow: 'auto', background: '#f6ffed', padding: 8, borderRadius: 4, margin: '4px 0 0' }}>
                          {tryPretty(detail.afterData)}
                        </pre>
                      </div>
                      {detail.message && (
                        <div>
                          <strong>错误信息</strong>
                          <pre style={{ background: '#fff1f0', padding: 8, borderRadius: 4, margin: '4px 0 0', color: '#cf1322' }}>
                            {detail.message}
                          </pre>
                        </div>
                      )}
                    </div>
                  )}
                </Modal>
              </>
            ),
          },
          {
            key: 'login',
            label: '登录日志',
            children: (
              <Table
                rowKey="id"
                loading={login.loading}
                dataSource={login.list}
                pagination={login.pagination}
                scroll={{ x: 800 }}
                columns={[
                  { title: '用户名', dataIndex: 'username', width: 160 },
                  { title: 'IP', dataIndex: 'ip', width: 160 },
                  { title: '结果', dataIndex: 'result', width: 120, render: (v: any) => <Tag color={v === '成功' || v === 1 ? 'green' : 'red'}>{v}</Tag> },
                  { title: '时间', dataIndex: 'time', width: 200 },
                ]}
              />
            ),
          },
        ]}
      />
    </Card>
  );
}

export default function System() {
  return (
    <Card title="系统管理">
      <Tabs
        items={[
          { key: 'users', label: '用户管理', children: <UsersTab /> },
          { key: 'roles', label: '角色管理', children: <RolesTab /> },
          { key: 'depts', label: '部门管理', children: <DeptsTab /> },
          { key: 'params', label: '系统参数', children: <ParamsTab /> },
          { key: 'logs', label: '日志', children: <LogsTab /> },
        ]}
      />
    </Card>
  );
}
