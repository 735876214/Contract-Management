import { useEffect, useMemo, useState } from 'react';
import { Button, Form, Input, Modal, Table, Space, Alert, message } from 'antd';
import { PlusOutlined, SearchOutlined } from '@ant-design/icons';
import { materialApi } from '@/api/business';

/**
 * 物料选择弹窗（合同起草「物料编码清单」·「添加物料」用，需求修正1）
 * - 支持按名称 / 规格 / MDM 编码 / DSC 编码检索物资基础库
 * - 支持单条勾选与全选（全选作用于当前检索结果）
 * - 已添加（存在于 excludeIds）的物资灰显禁选，避免重复
 * - 支持手动新增物料：填写名称/规格等创建到物资基础库后自动勾选
 */
export default function MaterialPickerModal({
  open,
  excludeIds = [],
  onCancel,
  onOk,
}: {
  open: boolean;
  excludeIds?: string[];
  onCancel: () => void;
  onOk: (ids: string[]) => void;
}) {
  const [rows, setRows] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);
  const [keyword, setKeyword] = useState('');
  const [selected, setSelected] = useState<string[]>([]);
  const [createOpen, setCreateOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [createForm] = Form.useForm();

  const load = async (kw?: string) => {
    setLoading(true);
    try {
      const res: any = await materialApi.list({ keyword: kw || undefined, pageSize: 500, page: 1 });
      setRows(res?.list || res?.data?.list || (Array.isArray(res) ? res : []));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (open) {
      setKeyword('');
      setSelected([]);
      setCreateOpen(false);
      load();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const excludeSet = useMemo(() => new Set(excludeIds), [excludeIds]);
  const selectable = useMemo(() => rows.filter((r) => !excludeSet.has(r.id)), [rows, excludeSet]);
  const allChecked = selectable.length > 0 && selectable.every((r) => selected.includes(r.id));

  const toggleAll = (checked: boolean) => {
    if (checked) setSelected(Array.from(new Set([...selected, ...selectable.map((r) => r.id)])));
    else setSelected(selected.filter((id) => !selectable.some((r) => r.id === id)));
  };

  const toggleOne = (id: string, checked: boolean) => {
    setSelected((prev) => (checked ? Array.from(new Set([...prev, id])) : prev.filter((x) => x !== id)));
  };

  /** 手动新增物料：创建到物资基础库后自动勾选（需求修正1） */
  const handleCreate = async () => {
    const values = await createForm.validateFields();
    setCreating(true);
    try {
      const created: any = await materialApi.create(values);
      const id = created?.id || created?.data?.id;
      message.success('物料已创建到物资基础库');
      setCreateOpen(false);
      createForm.resetFields();
      await load(keyword);
      if (id) setSelected((prev) => Array.from(new Set([...prev, id])));
    } finally {
      setCreating(false);
    }
  };

  return (
    <Modal
      title="添加物料"
      open={open}
      onCancel={onCancel}
      onOk={() => onOk(selected)}
      okText={`确认添加${selected.length ? `（${selected.length}）` : ''}`}
      cancelText="取消"
      width={900}
      destroyOnClose
    >
      <Space direction="vertical" size={12} style={{ width: '100%' }}>
        <Space>
          <Input
            allowClear
            prefix={<SearchOutlined />}
            style={{ width: 320 }}
            placeholder="物资名称 / 规格型号 / MDM编码 / DSC编码"
            value={keyword}
            onChange={(e) => setKeyword(e.target.value)}
            onPressEnter={() => load(keyword)}
          />
          <a onClick={() => load(keyword)}>检索</a>
          <Button type="primary" ghost icon={<PlusOutlined />} onClick={() => setCreateOpen(true)}>
            手动新增物料
          </Button>
        </Space>
        {excludeSet.size > 0 && (
          <Alert type="info" showIcon message="灰显且不可勾选的物料为已添加至本合同的物料，避免重复。" />
        )}
        <Table
          rowKey="id"
          size="small"
          loading={loading}
          dataSource={rows}
          pagination={{ pageSize: 8, showTotal: (t: number) => `共 ${t} 条` }}
          rowSelection={{
            selectedRowKeys: selected,
            onSelect: (row, checked) => toggleOne(row.id, checked),
            onSelectAll: (checked) => toggleAll(checked),
            getCheckboxProps: (row: any) => ({ disabled: excludeSet.has(row.id) }),
          }}
          columns={[
            {
              title: '物资名称',
              dataIndex: 'name',
              render: (v, row) => (excludeSet.has(row.id) ? <span style={{ color: '#bfbfbf' }}>{v}</span> : v),
            },
            { title: '规格型号', dataIndex: 'spec', width: 180 },
            { title: 'MDM编码', dataIndex: 'mdmCode', width: 160, render: (v) => v || '-' },
            { title: 'DSC编码', dataIndex: 'dscCode', width: 160, render: (v) => v || '-' },
          ]}
        />
      </Space>

      {/* 手动新增物料弹窗 */}
      <Modal
        title="手动新增物料"
        open={createOpen}
        onCancel={() => setCreateOpen(false)}
        onOk={handleCreate}
        confirmLoading={creating}
        okText="创建并勾选"
        width={480}
        destroyOnClose
      >
        <Form form={createForm} layout="vertical">
          <Form.Item name="name" label="物资名称" rules={[{ required: true, message: '请输入物资名称' }]}>
            <Input placeholder="如：PE管" />
          </Form.Item>
          <Form.Item name="spec" label="规格型号" rules={[{ required: true, message: '请输入规格型号' }]}>
            <Input placeholder="如：DN300 PN1.0" />
          </Form.Item>
          <Space size={16}>
            <Form.Item name="mdmCode" label="MDM编码（选填）" style={{ width: 200 }}>
              <Input />
            </Form.Item>
            <Form.Item name="dscCode" label="DSC编码（选填）" style={{ width: 200 }}>
              <Input />
            </Form.Item>
          </Space>
          <Alert type="info" showIcon={false} message="新物料将同步保存到「物资基础库」，供其他合同复用。" />
        </Form>
      </Modal>
    </Modal>
  );
}
