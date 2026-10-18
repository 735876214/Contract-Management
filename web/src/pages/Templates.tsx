import { useEffect, useState } from 'react';
import {
  Card, Table, Button, Form, Input, Space, Modal, Popconfirm, message, Tag, Select,
  Checkbox,
} from 'antd';
import type { ColumnsType } from 'antd/es/table';
import {
  PlusOutlined, SearchOutlined, HistoryOutlined, ReloadOutlined, EditOutlined, DeleteOutlined,
} from '@ant-design/icons';
import { templateApi } from '@/api/business';
import { useTable } from '@/hooks/useTable';
import DictSelect, { DictTag } from '@/components/DictSelect';
import RichTextEditor from '@/components/RichTextEditor';
import EmptyState from '@/components/EmptyState';
import VersionHistoryModal from '@/components/templates/VersionHistoryModal';
import { checkPlaceholders } from '@/utils/placeholderCheck';
import { VARIABLE_GROUPS } from './Clauses';

interface ContractTemplateRow {
  id: string;
  name: string;
  categoryCode?: string;
  tags?: string;
  status: number;
  version: number;
  content?: string;
  pageSetup?: string;
  createdAt?: string;
}

export default function Templates() {
  const { loading, list, params, search, reload, pagination } = useTable<ContractTemplateRow>(
    (p) => templateApi.list({ ...p, includeHistory: params.includeHistory }),
  );
  const [form] = Form.useForm();
  const [filterForm] = Form.useForm();
  const [modal, setModal] = useState(false);
  const [editing, setEditing] = useState<ContractTemplateRow | null>(null);
  const [saving, setSaving] = useState(false);

  const [includeHistory, setIncludeHistory] = useState(false);

  // 页面设置（页边距/页眉/页脚页码），以 JSON 存入模板 pageSetup 字段
  const [ps, setPs] = useState<any>({ margin: 'normal', header: '', footerFormat: 'xofy', footerAlign: 'center' });
  const syncPs = (next: any) => {
    const merged = { ...ps, ...next };
    setPs(merged);
    form.setFieldValue('pageSetup', JSON.stringify(merged));
  };

  // 版本历史（共享弹窗：合同/采购视觉与列一致，不显示修改人）
  const [versionOpen, setVersionOpen] = useState(false);
  const [versionRow, setVersionRow] = useState<ContractTemplateRow | null>(null);
  const [versions, setVersions] = useState<any[]>([]);
  const [versionLoading, setVersionLoading] = useState(false);

  useEffect(() => {
    if (!versionOpen || !versionRow) return;
    setVersionLoading(true);
    templateApi
      .versions(versionRow.id)
      .then((res: any) => setVersions(res?.list || res || []))
      .finally(() => setVersionLoading(false));
  }, [versionOpen, versionRow]);

  const openEdit = (row?: ContractTemplateRow) => {
    setEditing(row || null);
    form.resetFields();
    form.setFieldsValue(row ? { ...row } : { status: 1 });
    try {
      setPs(row?.pageSetup ? JSON.parse(row.pageSetup) : { margin: 'normal', header: '', footerFormat: 'xofy', footerAlign: 'center' });
    } catch {
      setPs({ margin: 'normal', header: '', footerFormat: 'xofy', footerAlign: 'center' });
    }
    setModal(true);
  };

  const submit = async () => {
    const values = await form.validateFields();
    const problems = checkPlaceholders(values.content);
    const doSave = async () => {
      setSaving(true);
      try {
        if (editing) await templateApi.update(editing.id, { ...values, version: editing.version });
        else await templateApi.create(values);
        message.success('保存成功');
        setModal(false);
        setEditing(null);
        reload();
      } finally {
        setSaving(false);
      }
    };
    if (problems.length) {
      Modal.confirm({
        title: '占位符写法警告',
        width: 520,
        content: (
          <div>
            <p>以下写法会导致变量或清单表格无法替换（生成合同后残留占位符）：</p>
            <ul style={{ paddingLeft: 20 }}>
              {problems.map((p) => (
                <li key={p} style={{ marginBottom: 4 }}>{p}</li>
              ))}
            </ul>
            <p>仍要保存吗？</p>
          </div>
        ),
        onOk: doSave,
      });
      return;
    }
    await doSave();
  };

  const openVersions = (row: ContractTemplateRow) => {
    setVersionRow(row);
    setVersionOpen(true);
  };

  const rollback = async (targetId: string) => {
    if (!versionRow) return;
    await templateApi.rollback(versionRow.id, targetId);
    message.success('已回滚到该版本');
    setVersionOpen(false);
    setVersionRow(null);
    reload();
  };

  const toggleHistory = (checked: boolean) => {
    setIncludeHistory(checked);
    search({ includeHistory: checked });
  };

  const columns: ColumnsType<ContractTemplateRow> = [
    { title: '模板名称', dataIndex: 'name', ellipsis: true },
    {
      title: '模板分类',
      dataIndex: 'categoryCode',
      width: 140,
      render: (v) => <DictTag typeCode="contract_template_category" value={v} />,
    },
    {
      title: '标签',
      dataIndex: 'tags',
      width: 160,
      render: (v) => (v ? v.split(',').filter(Boolean).map((t: string) => <Tag key={t}>{t}</Tag>) : '-'),
    },
    { title: '版本号', dataIndex: 'version', width: 90, render: (v) => <Tag color="blue">v{v ?? 1}</Tag> },
    {
      title: '状态',
      dataIndex: 'status',
      width: 90,
      // 状态列是 Int（1/0）；yes_no 字典是 Y/N，用 DictTag 会显示成 "1"
      render: (v: number) => (v === 0 ? <Tag>停用</Tag> : <Tag color="green">启用</Tag>),
    },
    { title: '创建时间', dataIndex: 'createdAt', width: 180, render: (v) => v?.slice(0, 19).replace('T', ' ') },
    {
      title: '操作',
      width: 230,
      fixed: 'right',
      render: (_, row) => (
        <Space size={4}>
          <Button type="link" size="small" icon={<HistoryOutlined />} onClick={() => openVersions(row)}>版本</Button>
          <Button type="link" size="small" icon={<EditOutlined />} onClick={() => openEdit(row)}>编辑</Button>
          <Popconfirm title="删除后该模板所有版本将被移除" onConfirm={async () => { await templateApi.remove(row.id); message.success('已删除'); reload(); }}>
            <Button type="link" size="small" danger icon={<DeleteOutlined />}>删除</Button>
          </Popconfirm>
        </Space>
      ),
    },
  ];

  return (
    <Card
      title="合同模板"
      extra={
        <Space>
          <Button icon={<ReloadOutlined />} onClick={reload}>刷新</Button>
          <Button type="primary" icon={<PlusOutlined />} onClick={() => openEdit()}>新增模板</Button>
        </Space>
      }
    >
      <Form
        form={filterForm}
        layout="inline"
        style={{ marginBottom: 16, rowGap: 8 }}
        onFinish={(v) => search({ keyword: v.keyword || undefined, categoryCode: v.categoryCode || undefined })}
      >
        <Form.Item name="keyword">
          <Input placeholder="模板名称 / 标签关键词" allowClear prefix={<SearchOutlined />} />
        </Form.Item>
        <Form.Item name="categoryCode">
          <DictSelect typeCode="contract_template_category" placeholder="模板分类" />
        </Form.Item>
        <Form.Item>
          <Checkbox checked={includeHistory} onChange={(e) => toggleHistory(e.target.checked)}>
            显示历史版本
          </Checkbox>
        </Form.Item>
        <Form.Item>
          <Space>
            <Button type="primary" htmlType="submit">查询</Button>
            <Button
              onClick={() => {
                filterForm.resetFields();
                if (includeHistory) toggleHistory(false);
                search({ keyword: undefined, categoryCode: undefined });
              }}
            >
              重置
            </Button>
          </Space>
        </Form.Item>
      </Form>

      <Table<ContractTemplateRow>
        rowKey="id"
        loading={loading}
        dataSource={list}
        pagination={pagination}
        scroll={{ x: 'max-content' }}
        columns={columns}
        locale={{ emptyText: <EmptyState compact description="暂无合同模板，点击右上角「新增模板」创建" /> }}
      />

      {/* 新增/编辑模板 */}
      <Modal
        title={editing ? '编辑合同模板' : '新增合同模板'}
        open={modal}
        onOk={submit}
        onCancel={() => setModal(false)}
        okText="保存"
        confirmLoading={saving}
        width={960}
        destroyOnHidden
      >
        <Form form={form} layout="vertical">
          <Space size={16} style={{ display: 'flex', flexWrap: 'wrap' }}>
            <Form.Item name="name" label="模板名称" rules={[{ required: true }]} style={{ minWidth: 280 }}>
              <Input placeholder="如 采购合同模板" maxLength={100} />
            </Form.Item>
            <Form.Item name="categoryCode" label="模板分类" rules={[{ required: true }]} style={{ minWidth: 240 }}>
              <DictSelect typeCode="contract_template_category" />
            </Form.Item>
            <Form.Item name="tags" label="标签" style={{ minWidth: 180 }}>
              <Input placeholder="多个标签用逗号分隔" maxLength={100} />
            </Form.Item>
            <Form.Item name="status" label="状态" initialValue={1} style={{ minWidth: 110 }}>
              <Select
                options={[
                  { value: 1, label: '启用' },
                  { value: 0, label: '停用' },
                ]}
              />
            </Form.Item>
          </Space>
          <Form.Item name="content" label="模板内容" rules={[{ required: true, message: '请填写模板内容' }]}>
            <RichTextEditor
              variableGroups={VARIABLE_GROUPS}
              variableScope="contract"
              minHeight={380}
              placeholder="在此编辑合同正文，可点击「插入变量」把占位符插入到光标处（占位符语法：{{变量名}}，单花括号不生效）"
            />
          </Form.Item>
          <Form.Item label="页面设置（生成 Word 时生效）" style={{ marginBottom: 4 }}>
            <Card size="small" title="页边距 / 页眉 / 页码" extra={
              <Select
                style={{ width: 140 }}
                value={ps.margin}
                onChange={(v) => syncPs({ margin: v })}
                options={[
                  { label: '普通（上下2.54/左右2cm）', value: 'normal' },
                  { label: '窄（1.27cm）', value: 'narrow' },
                  { label: '适中（上下2.54/左右1.9cm）', value: 'moderate' },
                  { label: '宽（3.18cm）', value: 'wide' },
                ]}
              />
            }>
              <Space direction="vertical" style={{ width: '100%' }}>
                <Input
                  addonBefore="页眉"
                  placeholder="如：合同编号：{{合同编号}}    项目名称：{{项目名称}}"
                  value={ps.header}
                  onChange={(e) => syncPs({ header: e.target.value })}
                />
                <Space wrap>
                  <Select
                    style={{ width: 200 }}
                    value={ps.footerFormat}
                    onChange={(v) => syncPs({ footerFormat: v })}
                    options={[
                      { label: '页脚：第 X 页 / 共 Y 页', value: 'xofy' },
                      { label: '页脚：X / Y', value: 'xy' },
                      { label: '页脚：- X -', value: 'dash' },
                    ]}
                  />
                  <Select
                    style={{ width: 140 }}
                    value={ps.footerAlign}
                    onChange={(v) => syncPs({ footerAlign: v })}
                    options={[
                      { label: '页码居中', value: 'center' },
                      { label: '页码居右', value: 'right' },
                      { label: '页码居左', value: 'left' },
                    ]}
                  />
                </Space>
              </Space>
            </Card>
          </Form.Item>
          <Form.Item name="pageSetup" hidden><Input /></Form.Item>
          {editing && (
            <div style={{ color: 'var(--cms-muted-soft)' }}>
              提示：每次保存会生成新版本，旧版本可在「版本」里回滚；删除会把该模板所有版本一并移除。
            </div>
          )}
        </Form>
      </Modal>

      <VersionHistoryModal
        open={versionOpen}
        versions={versions}
        loading={versionLoading}
        emptyText="该模板还没有历史版本（每次编辑会自动保存一份）"
        onClose={() => { setVersionOpen(false); setVersionRow(null); }}
        onRollback={rollback}
      />
    </Card>
  );
}
