import { useEffect, useState } from 'react';
import { withToken } from '../utils/download';
import { Card, Table, Button, Form, Input, Space, Modal, Popconfirm, message, Tag, Select } from 'antd';
import { PlusOutlined, SearchOutlined, ExportOutlined, StopOutlined, CheckCircleOutlined } from '@ant-design/icons';
import { materialApi } from '@/api/modules';
import { dictApi } from '@/api/dict';
import { useTable } from '@/hooks/useTable';
import ImportButton from '@/components/ImportButton';

export default function Materials() {
  const { loading, list, params, search, reload, pagination } = useTable<any>((p) => materialApi.list(p));
  const [form] = Form.useForm();
  const [modal, setModal] = useState(false);
  const [saving, setSaving] = useState(false);
  const [editing, setEditing] = useState<any>(null);
  // 物资一二级分类（需求 2.2）：一级 material_category、二级 material_type（extField1 关联一级 code）
  const [catL1, setCatL1] = useState<any[]>([]);
  const [catL2, setCatL2] = useState<any[]>([]);
  const watchCatL1 = Form.useWatch('categoryLevel1', form);

  useEffect(() => {
    dictApi.options('material_category').then((r) => setCatL1(r || [])).catch(() => undefined);
    dictApi.options('material_type').then((r) => setCatL2(r || [])).catch(() => undefined);
  }, []);

  useEffect(() => {
    if (modal) {
      form.resetFields();
      if (editing) form.setFieldsValue(editing);
    }
  }, [modal, editing]);

  // 二级分类按所选一级过滤（extField1 === 一级 value）；未选一级时展示全部
  const l2Options = catL2
    .filter((i: any) => !watchCatL1 || !i.extField1 || i.extField1 === catL1.find((x: any) => x.label === watchCatL1)?.value)
    .map((i: any) => ({ value: i.label ?? i.name, label: i.label ?? i.name }));

  const submit = async () => {
    const values = await form.validateFields();
    setSaving(true);
    try {
      if (editing) await materialApi.update(editing.id, values);
      else await materialApi.create(values);
      message.success('保存成功');
      setModal(false);
      setEditing(null);
      reload();
    } finally {
      setSaving(false);
    }
  };


  return (
    <Card
      title="物资基础库"
      extra={
        <Space>
          <ImportButton moduleName="物资基础库" templateUrl={materialApi.templateUrl()} uploadUrl={materialApi.importUrl()} onDone={reload} />
          <Button icon={<ExportOutlined />} onClick={() => window.open(withToken(materialApi.exportUrl()))}>导出</Button>
          <Button type="primary" icon={<PlusOutlined />} onClick={() => { setEditing(null); setModal(true); }}>新增物资</Button>
        </Space>
      }
    >
      <Form layout="inline" style={{ marginBottom: 16, rowGap: 8 }} onFinish={(v) => search(v)}>
        <Form.Item name="keyword">
          <Input placeholder="物资名称/规格/MDM/DSC编码" allowClear prefix={<SearchOutlined />} style={{ width: 260 }} />
        </Form.Item>
        <Form.Item name="categoryLevel1">
          <Select
            allowClear
            placeholder="一级分类"
            style={{ width: 140 }}
            options={catL1.map((i: any) => ({ value: i.label ?? i.name, label: i.label ?? i.name }))}
          />
        </Form.Item>
        <Form.Item name="categoryLevel2">
          <Select
            allowClear
            placeholder="二级分类"
            style={{ width: 160 }}
            options={catL2.map((i: any) => ({ value: i.label ?? i.name, label: i.label ?? i.name }))}
          />
        </Form.Item>
        <Form.Item><Button type="primary" htmlType="submit">查询</Button></Form.Item>
      </Form>

      <Table
        rowKey="id"
        loading={loading}
        dataSource={list}
        pagination={pagination}
        scroll={{ x: 1100 }}
        columns={[
          { title: '物资名称', dataIndex: 'name', width: 220, render: (v, row) => (
            <Space>{v}{row.status === 0 && <Tag color="default">已停用</Tag>}</Space>
          ) },
          { title: '规格型号', dataIndex: 'spec', width: 180 },
          { title: '一级分类', dataIndex: 'categoryLevel1', width: 130, render: (v) => v || '-' },
          { title: '二级分类', dataIndex: 'categoryLevel2', width: 130, render: (v) => v || '-' },
          { title: 'MDM编码', dataIndex: 'mdmCode', width: 160, render: (v) => v || '-' },
          { title: 'DSC编码', dataIndex: 'dscCode', width: 160, render: (v) => v || '-' },
          { title: '被引用次数', dataIndex: 'refCount', width: 110, render: (v) => (v > 0 ? <Tag color="blue">{v} 条</Tag> : '-') },
          { title: '备注', dataIndex: 'remark', width: 200, ellipsis: true, render: (v) => v || '-' },
          {
            title: '操作',
            width: 220,
            fixed: 'right',
            render: (_, row) => (
              <Space size={4}>
                <Button type="link" size="small" onClick={() => { setEditing(row); setModal(true); }}>编辑</Button>
                <Popconfirm
                  title={row.refCount > 0 ? `该物资已被 ${row.refCount} 条合同清单引用，删除会破坏历史合同数据，建议改为停用。仍要删除吗？` : '确认删除该物资？'}
                  okButtonProps={{ danger: row.refCount > 0 }}
                  onConfirm={async () => {
                    try {
                      await materialApi.remove(row.id);
                      message.success('已删除');
                      reload();
                    } catch { /* 后端已提示引用阻止 */ }
                  }}
                >
                  <Button type="link" size="small" danger>删除</Button>
                </Popconfirm>
                <Button
                  type="link"
                  size="small"
                  icon={row.status === 1 ? <StopOutlined /> : <CheckCircleOutlined />}
                  onClick={async () => {
                    await materialApi.toggle(row.id);
                    message.success(row.status === 1 ? '已停用（历史合同数据保留）' : '已启用');
                    reload();
                  }}
                >
                  {row.status === 1 ? '停用' : '启用'}
                </Button>
              </Space>
            ),
          },
        ]}
      />

      <Modal
        title={editing ? '编辑物资' : '新增物资'}
        open={modal}
        onOk={submit}
        onCancel={() => { setModal(false); setEditing(null); }}
        confirmLoading={saving}
        destroyOnClose
      >
        <Form form={form} layout="vertical">
          <Form.Item name="name" label="物资名称" rules={[{ required: true, message: '请输入物资名称' }]}>
            <Input placeholder="如：螺纹钢" />
          </Form.Item>
          <Form.Item name="spec" label="规格型号" rules={[{ required: true, message: '请输入规格型号' }]}>
            <Input placeholder="如：HRB400E Φ12" />
          </Form.Item>
          <Form.Item name="categoryLevel1" label="一级分类">
            <Select
              allowClear
              placeholder="请选择一级分类"
              options={catL1.map((i: any) => ({ value: i.label ?? i.name, label: i.label ?? i.name }))}
              onChange={() => form.setFieldValue('categoryLevel2', undefined)}
            />
          </Form.Item>
          <Form.Item name="categoryLevel2" label="二级分类">
            <Select allowClear placeholder="请选择二级分类" options={l2Options} />
          </Form.Item>
          <Form.Item name="mdmCode" label="MDM编码（可空）"><Input /></Form.Item>
          <Form.Item name="dscCode" label="DSC编码（可空）"><Input /></Form.Item>
          <Form.Item name="remark" label="备注"><Input.TextArea rows={2} /></Form.Item>
        </Form>
      </Modal>
    </Card>
  );
}
