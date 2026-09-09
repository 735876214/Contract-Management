import { useEffect, useMemo, useState } from 'react';
import { Input, Modal, Table, Space, Alert } from 'antd';
import { SearchOutlined } from '@ant-design/icons';
import { materialApi } from '@/api/business';

/**
 * 物资基础库检索弹窗（合同起草「物料编码清单」导入用）
 * - 支持按名称 / 规格 / MDM 编码 / DSC 编码检索
 * - 支持单条勾选与全选（全选作用于当前检索结果）
 * - 已导入（存在于 excludeIds）的物资默认勾选并禁用，避免重复导入
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

  return (
    <Modal
      title="从物资基础库导入物料"
      open={open}
      onCancel={onCancel}
      onOk={() => onOk(selected)}
      okText={`确认导入${selected.length ? `（${selected.length}）` : ''}`}
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
        </Space>
        {excludeSet.size > 0 && (
          <Alert type="info" showIcon message="灰显且不可勾选的物资为已导入本合同的物料，避免重复添加。" />
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
    </Modal>
  );
}
