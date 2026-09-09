import { useCallback, useEffect, useState } from 'react';
import { Button, Popconfirm, Space, Table, message } from 'antd';
import { DeleteOutlined, ImportOutlined, PlusOutlined } from '@ant-design/icons';
import { contractApi } from '@/api/business';
import MaterialPickerModal from './MaterialPickerModal';

/**
 * 合同起草 · Tab1：物料编码清单（合同专属物资池）
 * - 从【物资基础库】检索并勾选/全选导入
 * - 展示 4 个核心字段：物资名称、规格型号、MDM编码、DSC编码
 * - 支持删除误导入的物料（删除时同步移除其在合同清单中的行）
 */
export default function MaterialPoolTab({
  contractId,
  onChanged,
}: {
  contractId: string;
  onChanged?: () => void;
}) {
  const [rows, setRows] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);
  const [picker, setPicker] = useState(false);

  const load = useCallback(async () => {
    if (!contractId) return;
    setLoading(true);
    try {
      const res: any = await contractApi.poolList(contractId);
      setRows(Array.isArray(res) ? res : res?.list || []);
    } finally {
      setLoading(false);
    }
  }, [contractId]);

  useEffect(() => {
    load();
  }, [load]);

  const handleImport = async (ids: string[]) => {
    if (!ids.length) return message.warning('请勾选要导入的物料');
    const res: any = await contractApi.poolAdd(contractId, ids);
    message.success(`已导入 ${res?.added ?? ids.length} 项${res?.skipped ? `，跳过重复 ${res.skipped} 项` : ''}`);
    setPicker(false);
    load();
    onChanged?.();
  };

  const handleRemove = async (id: string) => {
    await contractApi.poolRemove(contractId, id);
    message.success('已删除');
    load();
    onChanged?.();
  };

  return (
    <Space direction="vertical" size={12} style={{ width: '100%' }}>
      <Space>
        <Button type="primary" icon={<PlusOutlined />} onClick={() => setPicker(true)}>
          添加物料
        </Button>
        <Button icon={<ImportOutlined />} onClick={() => setPicker(true)}>
          从物资基础库导入
        </Button>
      </Space>
      <Table
        rowKey="id"
        size="small"
        loading={loading}
        dataSource={rows}
        pagination={false}
        scroll={{ x: 800 }}
        columns={[
          { title: '序号', width: 70, render: (_, __, i) => i + 1 },
          { title: '物资名称', dataIndex: 'name' },
          { title: '规格型号', dataIndex: 'spec', width: 180 },
          { title: 'MDM编码', dataIndex: 'mdmCode', width: 160, render: (v) => v || '-' },
          { title: 'DSC编码', dataIndex: 'dscCode', width: 160, render: (v) => v || '-' },
          {
            title: '操作',
            width: 90,
            render: (_, row) => (
              <Popconfirm title="确认删除该物料？其在合同清单中的行也会一并移除。" onConfirm={() => handleRemove(row.id)}>
                <Button type="link" size="small" danger icon={<DeleteOutlined />}>
                  删除
                </Button>
              </Popconfirm>
            ),
          },
        ]}
      />

      <MaterialPickerModal
        open={picker}
        excludeIds={rows.map((r) => r.materialBaseId)}
        onCancel={() => setPicker(false)}
        onOk={handleImport}
      />
    </Space>
  );
}
