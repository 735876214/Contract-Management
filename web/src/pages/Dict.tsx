import { useEffect, useMemo, useState } from 'react';
import { withToken } from '../utils/download';
import {
  Row, Col, Card, Table, Button, Input, Space, Modal, Form, Tag, message, Popconfirm,
  InputNumber, Select, Tooltip, Upload, Descriptions,
} from 'antd';
import { PlusOutlined, ExportOutlined, ImportOutlined, ReloadOutlined } from '@ant-design/icons';
import { dictApi } from '@/api/dict';
import { useDictStore } from '@/store/dict';

const COLORS = ['blue', 'green', 'red', 'orange', 'gold', 'cyan', 'purple', 'magenta', 'volcano', 'geekblue', 'default'];

export default function Dict() {
  const [types, setTypes] = useState<any[]>([]);
  const [typeKeyword, setTypeKeyword] = useState('');
  const [currentType, setCurrentType] = useState<any>(null);
  const [items, setItems] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);
  const [typeModal, setTypeModal] = useState(false);
  const [itemModal, setItemModal] = useState(false);
  const [editingItem, setEditingItem] = useState<any>(null);
  const [editingType, setEditingType] = useState<any>(null);
  const [typeForm] = Form.useForm();
  const [itemForm] = Form.useForm();
  const invalidate = useDictStore((s) => s.invalidate);

  const loadTypes = async (keyword = '') => {
    const res: any = await dictApi.types({ keyword, pageSize: 500 });
    setTypes(res.list || []);
    if (!currentType && res.list?.length) setCurrentType(res.list[0]);
  };

  const loadItems = async (typeCode: string) => {
    if (!typeCode) return;
    setLoading(true);
    try {
      const res: any = await dictApi.items({ typeCode, pageSize: 500 });
      setItems(res || []);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadTypes();
  }, []);

  useEffect(() => {
    if (currentType) loadItems(currentType.code);
  }, [currentType?.code]);

  const filteredTypes = useMemo(
    () => types.filter((t) => !typeKeyword || t.code.includes(typeKeyword) || t.name.includes(typeKeyword)),
    [types, typeKeyword],
  );

  const submitType = async () => {
    const values = await typeForm.validateFields();
    if (editingType) await dictApi.updateType(editingType.id, values);
    else await dictApi.createType(values);
    message.success('保存成功');
    setTypeModal(false);
    typeForm.resetFields();
    setEditingType(null);
    loadTypes(typeKeyword);
    invalidate();
  };

  const submitItem = async () => {
    const values = await itemForm.validateFields();
    const payload = { ...values, typeCode: currentType.code };
    if (editingItem) await dictApi.updateItem(editingItem.id, payload);
    else await dictApi.createItem(payload);
    message.success('保存成功');
    setItemModal(false);
    itemForm.resetFields();
    setEditingItem(null);
    loadItems(currentType.code);
    invalidate(currentType.code);
  };

  const removeItem = async (row: any) => {
    await dictApi.removeItem(row.id);
    message.success('删除成功');
    loadItems(currentType.code);
    invalidate(currentType.code);
  };

  const toggleItem = async (row: any) => {
    await dictApi.toggleItem(row.id);
    loadItems(currentType.code);
    invalidate(currentType.code);
  };

  const move = async (row: any, dir: -1 | 1) => {
    const idx = items.findIndex((i) => i.id === row.id);
    const target = idx + dir;
    if (target < 0 || target >= items.length) return;
    const ids = items.map((i) => i.id);
    [ids[idx], ids[target]] = [ids[target], ids[idx]];
    await dictApi.sortItems(currentType.code, ids);
    loadItems(currentType.code);
    invalidate(currentType.code);
  };

  return (
    <Row gutter={16}>
      <Col xs={24} lg={7}>
        <Card
          title="字典类型"
          extra={
            <Button
              type="primary"
              size="small"
              icon={<PlusOutlined />}
              onClick={() => {
                setEditingType(null);
                typeForm.resetFields();
                setTypeModal(true);
              }}
            >
              新增
            </Button>
          }
        >
          <Input.Search placeholder="搜索编码/名称" allowClear onSearch={loadTypes} onChange={(e) => setTypeKeyword(e.target.value)} style={{ marginBottom: 12 }} />
          <div style={{ maxHeight: 'calc(100vh - 260px)', overflow: 'auto' }}>
            {filteredTypes.map((t) => (
              <div
                key={t.id}
                onClick={() => setCurrentType(t)}
                style={{
                  padding: '8px 12px',
                  cursor: 'pointer',
                  borderRadius: 6,
                  marginBottom: 4,
                  background: currentType?.id === t.id ? '#e6f4ff' : 'transparent',
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                }}
              >
                <Tooltip title={t.remark}>
                  <span>
                    {t.name} <span style={{ color: '#999', fontSize: 12 }}>{t.code}</span>
                  </span>
                </Tooltip>
                <Space size={4}>
                  <Tag>{t.itemCount ?? 0}</Tag>
                  <Button
                    type="link"
                    size="small"
                    onClick={(e) => {
                      e.stopPropagation();
                      setEditingType(t);
                      typeForm.setFieldsValue(t);
                      setTypeModal(true);
                    }}
                  >
                    编辑
                  </Button>
                </Space>
              </div>
            ))}
          </div>
        </Card>
      </Col>

      <Col xs={24} lg={17}>
        <Card
          title={currentType ? `字典项 · ${currentType.name}` : '字典项'}
          extra={
            <Space>
              <Button icon={<ReloadOutlined />} onClick={() => currentType && loadItems(currentType.code)} disabled={!currentType}>
                刷新
              </Button>
              <Button
                icon={<ImportOutlined />}
                disabled={!currentType}
                onClick={() => {
                  const input = document.createElement('input');
                  input.type = 'file';
                  input.accept = '.xlsx,.xls';
                  input.onchange = async () => {
                    const file = input.files?.[0];
                    if (!file) return;
                    const fd = new FormData();
                    fd.append('file', file);
                    const token = localStorage.getItem('cms_token');
                    const res = await fetch(dictApi.importUrl(currentType.code), {
                      method: 'POST',
                      headers: { Authorization: `Bearer ${token}` },
                      body: fd,
                    });
                    const body = await res.json();
                    if (body.code === 0) {
                      message.success(`导入完成：新增 ${body.data.created}，更新 ${body.data.updated}`);
                      loadItems(currentType.code);
                      invalidate(currentType.code);
                    } else message.error(body.message);
                  };
                  input.click();
                }}
              >
                导入
              </Button>
              <Button
                icon={<ExportOutlined />}
                disabled={!currentType}
                onClick={() => window.open(withToken(dictApi.exportUrl(currentType.code)))}
              >
                导出
              </Button>
              <Button
                type="primary"
                icon={<PlusOutlined />}
                disabled={!currentType}
                onClick={() => {
                  setEditingItem(null);
                  itemForm.resetFields();
                  itemForm.setFieldsValue({ status: 1, sortOrder: items.length + 1 });
                  setItemModal(true);
                }}
              >
                新增字典项
              </Button>
            </Space>
          }
        >
          {currentType?.remark && (
            <Descriptions size="small" column={1} style={{ marginBottom: 12 }}>
              <Descriptions.Item label="说明">{currentType.remark}</Descriptions.Item>
            </Descriptions>
          )}
          <Table
            rowKey="id"
            size="small"
            loading={loading}
            dataSource={items}
            scroll={{ x: 900 }}
            pagination={false}
            columns={[
              { title: '排序', dataIndex: 'sortOrder', width: 70 },
              { title: '字典项编码', dataIndex: 'itemCode', width: 150 },
              { title: '字典项名称', dataIndex: 'itemName', width: 160 },
              {
                title: '标签颜色',
                dataIndex: 'color',
                width: 110,
                render: (c: string) => (c ? <Tag color={c}>{c}</Tag> : '-'),
              },
              { title: '扩展字段1', dataIndex: 'extField1', width: 130, render: (v: string) => v || '-' },
              {
                title: '状态',
                dataIndex: 'status',
                width: 90,
                render: (s: number) => (s === 1 ? <Tag color="green">启用</Tag> : <Tag>停用</Tag>),
              },
              { title: '备注', dataIndex: 'remark', render: (v: string) => v || '-' },
              {
                title: '操作',
                width: 210,
                fixed: 'right',
                render: (_: any, row: any) => (
                  <Space size={4}>
                    <Button type="link" size="small" onClick={() => { setEditingItem(row); itemForm.setFieldsValue(row); setItemModal(true); }}>
                      编辑
                    </Button>
                    <Button type="link" size="small" onClick={() => toggleItem(row)}>
                      {row.status === 1 ? '停用' : '启用'}
                    </Button>
                    <Button type="link" size="small" onClick={() => move(row, -1)}>
                      上移
                    </Button>
                    <Button type="link" size="small" onClick={() => move(row, 1)}>
                      下移
                    </Button>
                    <Popconfirm
                      title="确认删除该字典项？被业务数据引用时不可删除"
                      onConfirm={() => removeItem(row)}
                    >
                      <Button type="link" size="small" danger>
                        删除
                      </Button>
                    </Popconfirm>
                  </Space>
                ),
              },
            ]}
          />
        </Card>
      </Col>

      <Modal
        title={editingType ? '编辑字典类型' : '新增字典类型'}
        open={typeModal}
        onOk={submitType}
        onCancel={() => setTypeModal(false)}
        destroyOnClose
      >
        <Form form={typeForm} layout="vertical">
          <Form.Item name="code" label="字典类型编码" rules={[{ required: true }]}>
            <Input placeholder="如 contract_type" disabled={!!editingType} />
          </Form.Item>
          <Form.Item name="name" label="字典类型名称" rules={[{ required: true }]}>
            <Input />
          </Form.Item>
          <Form.Item name="sort" label="排序号">
            <InputNumber style={{ width: '100%' }} />
          </Form.Item>
          <Form.Item name="status" label="状态">
            <Select options={[{ value: 1, label: '启用' }, { value: 0, label: '停用' }]} />
          </Form.Item>
          <Form.Item name="remark" label="备注">
            <Input.TextArea rows={2} />
          </Form.Item>
        </Form>
      </Modal>

      <Modal
        title={editingItem ? '编辑字典项' : '新增字典项'}
        open={itemModal}
        onOk={submitItem}
        onCancel={() => setItemModal(false)}
        destroyOnClose
      >
        <Form form={itemForm} layout="vertical">
          <Form.Item name="itemCode" label="字典项编码" rules={[{ required: true }]}>
            <Input placeholder="如 FRAMEWORK" disabled={!!editingItem} />
          </Form.Item>
          <Form.Item name="itemName" label="字典项名称" rules={[{ required: true }]}>
            <Input />
          </Form.Item>
          <Form.Item name="sortOrder" label="排序号">
            <InputNumber style={{ width: '100%' }} />
          </Form.Item>
          <Form.Item name="color" label="标签颜色（用于 Tag 展示）">
            <Select allowClear options={COLORS.map((c) => ({ value: c, label: c }))} />
          </Form.Item>
          <Form.Item name="extField1" label="扩展字段1（如关联材料类别编码）">
            <Input />
          </Form.Item>
          <Form.Item name="status" label="状态">
            <Select options={[{ value: 1, label: '启用' }, { value: 0, label: '停用' }]} />
          </Form.Item>
          <Form.Item name="remark" label="备注">
            <Input.TextArea rows={2} />
          </Form.Item>
        </Form>
      </Modal>
    </Row>
  );
}
