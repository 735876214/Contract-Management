import { useEffect, useState } from 'react';
import {
  Card, Table, Button, Form, Input, Space, Modal, Popconfirm, message, Tag, Drawer, Steps, Alert, Select,
  Row, Col, Tabs, InputNumber, Divider, Typography,
} from 'antd';
import { PlusOutlined, SearchOutlined, HistoryOutlined } from '@ant-design/icons';
import { templateApi, contractApi } from '@/api/business';
import { useTable } from '@/hooks/useTable';
import DictSelect, { DictTag } from '@/components/DictSelect';
import RichTextEditor from '@/components/RichTextEditor';
import { exportWord, printHtml, highlightPlaceholders } from '@/utils/docExport';
import { VARIABLES } from './Clauses';

export default function Templates() {
  const { loading, list, params, search, reload, pagination } = useTable<any>(
    (p) => templateApi.list({ ...p, includeHistory: params.includeHistory }),
  );
  const [form] = Form.useForm();
  const [modal, setModal] = useState(false);
  const [editing, setEditing] = useState<any>(null);

  const [includeHistory, setIncludeHistory] = useState(false);

  // 版本抽屉
  const [versionOpen, setVersionOpen] = useState(false);
  const [versionRow, setVersionRow] = useState<any>(null);
  const [versions, setVersions] = useState<any[]>([]);

  const onSearch = (v: any) => search(v);

  // 条款库已迁移至独立页面 Clauses（需求 2.3），此处仅保留模板管理

  useEffect(() => {
    if (versionOpen && versionRow) {
      templateApi.versions(versionRow.id).then((res: any) => setVersions(res?.list || res || []));
    }
  }, [versionOpen, versionRow]);

  const openEdit = (row?: any) => {
    setEditing(row || null);
    form.resetFields();
    if (row) form.setFieldsValue(row);
    setModal(true);
  };

  const submit = async () => {
    const values = await form.validateFields();
    if (editing) await templateApi.update(editing.id, values);
    else await templateApi.create(values);
    message.success('保存成功');
    setModal(false);
    setEditing(null);
    reload();
  };

  const openVersions = (row: any) => {
    setVersionRow(row);
    setVersionOpen(true);
  };

  const rollback = async (targetId: string) => {
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

  return (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      <Card
        title="合同模板管理"
        extra={
          <Space>
            <Button type="primary" icon={<PlusOutlined />} onClick={() => openEdit()}>新增模板</Button>
          </Space>
        }
      >
        <Form layout="inline" style={{ marginBottom: 16, rowGap: 8 }} onFinish={onSearch}>
          <Form.Item name="keyword"><Input placeholder="模板名称关键词" allowClear prefix={<SearchOutlined />} /></Form.Item>
          <Form.Item name="categoryCode"><DictSelect typeCode="contract_template_category" placeholder="模板分类" /></Form.Item>
          <Form.Item>
            <label style={{ marginLeft: 8 }}>
              <input type="checkbox" checked={includeHistory} onChange={(e) => toggleHistory(e.target.checked)} /> 显示历史版本
            </label>
          </Form.Item>
          <Form.Item><Button type="primary" htmlType="submit">查询</Button></Form.Item>
        </Form>

        <Table
          rowKey="id"
          loading={loading}
          dataSource={list}
          pagination={pagination}
          scroll={{ x: 1200 }}
          columns={[
            { title: '模板名称', dataIndex: 'name', width: 240, fixed: 'left' },
            { title: '模板分类', dataIndex: 'categoryCode', width: 140, render: (v) => <DictTag typeCode="contract_template_category" value={v} /> },
            { title: '标签', dataIndex: 'tags', width: 160, render: (v) => (v ? v.split(',').filter(Boolean).map((t: string) => <Tag key={t}>{t}</Tag>) : '-') },
            { title: '版本号', dataIndex: 'version', width: 90, render: (v) => <Tag color="blue">v{v ?? 1}</Tag> },
            { title: '状态', dataIndex: 'status', width: 100, render: (v) => <DictTag typeCode="yes_no" value={v} /> },
            { title: '创建时间', dataIndex: 'createdAt', width: 180, render: (v) => v?.slice(0, 19).replace('T', ' ') },
            {
              title: '操作',
              width: 240,
              fixed: 'right',
              render: (_, row) => (
                <Space size={4}>
                  <Button type="link" size="small" icon={<HistoryOutlined />} onClick={() => openVersions(row)}>版本</Button>
                  <Button type="link" size="small" onClick={() => openEdit(row)}>编辑</Button>
                  <Popconfirm title="删除后该模板所有版本将被移除" onConfirm={async () => { await templateApi.remove(row.id); message.success('已删除'); reload(); }}>
                    <Button type="link" size="small" danger>删除</Button>
                  </Popconfirm>
                </Space>
              ),
            },
          ]}
        />
      </Card>

      {/* 新增/编辑模板 */}
      <Modal
        title={editing ? '编辑模板' : '新增模板'}
        open={modal}
        onOk={submit}
        onCancel={() => setModal(false)}
        width={760}
        destroyOnClose
      >
        <Form form={form} layout="vertical">
          <Row gutter={16}>
            <Col xs={24} md={12}>
              <Form.Item name="name" label="模板名称" rules={[{ required: true }]}><Input placeholder="如 采购合同模板" /></Form.Item>
            </Col>
            <Col xs={24} md={12}>
              <Form.Item name="categoryCode" label="模板分类" rules={[{ required: true }]}>
                <DictSelect typeCode="contract_template_category" />
              </Form.Item>
            </Col>
            <Col xs={24} md={12}>
              <Form.Item name="tags" label="标签"><Input placeholder="多个标签用逗号分隔" /></Form.Item>
            </Col>
            <Col xs={24} md={12}>
              <Form.Item name="status" label="状态" initialValue="Y">
                <DictSelect typeCode="yes_no" />
              </Form.Item>
            </Col>
            <Col xs={24}>
              <Alert
                type="info"
                showIcon
                style={{ marginBottom: 12 }}
                message="可用变量占位符（在模板内容中使用如 {合同编号}、{供应商名称} 等，生成时将自动替换）"
                description={
                  <Space size={4} wrap>
                    {VARIABLES.map((v) => <Tag key={v}>{`{${v}}`}</Tag>)}
                    <Tag color="purple">{'{{MATERIAL_CODE_TABLE}}'}</Tag>
                    <Tag color="purple">{'{{CONTRACT_ITEM_TABLE}}'}</Tag>
                  </Space>
                }
              />
            </Col>
            <Col xs={24}>
              <Alert
                type="success"
                showIcon
                style={{ marginBottom: 12 }}
                message="表格占位符：{{MATERIAL_CODE_TABLE}} 生成「物料编码清单」（序号/物资名称/规格型号/MDM/DSC），{{CONTRACT_ITEM_TABLE}} 生成「合同清单」（序号/名称/规格/计量单位/暂定数量/税前单价/增值税/含税单价/暂定含税合价/备注），均取自合同物资清单并重新编号，可放在模板任意位置"
              />
            </Col>
            <Col xs={24}>
              <Form.Item name="content" label="模板内容" rules={[{ required: true, message: '请填写模板内容' }]}>
                <RichTextEditor variables={VARIABLES} minHeight={360} placeholder="在此编辑合同正文，可点击「插入变量」把占位符插入到光标处" />
              </Form.Item>
            </Col>
          </Row>
        </Form>
      </Modal>

      {/* 版本抽屉 */}
      <Drawer title="版本历史" width={560} open={versionOpen} onClose={() => { setVersionOpen(false); setVersionRow(null); }}>
        <Table
          rowKey="id"
          size="small"
          dataSource={versions}
          pagination={false}
          columns={[
            { title: '版本号', dataIndex: 'version', width: 90, render: (v) => <Tag color="blue">v{v}</Tag> },
            { title: '修改人', dataIndex: 'operator', width: 120 },
            { title: '时间', dataIndex: 'createdAt', render: (v) => v?.slice(0, 19).replace('T', ' ') },
            {
              title: '操作',
              width: 100,
              render: (_, row) => (
                <Popconfirm title="回滚后将基于该版本创建新版本" onConfirm={() => rollback(row.id)}>
                  <Button type="link" size="small">回滚</Button>
                </Popconfirm>
              ),
            },
          ]}
        />
      </Drawer>

    </Space>
  );
}
