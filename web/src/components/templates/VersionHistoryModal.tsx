import { Button, Modal, Popconfirm, Table, Tag } from 'antd';
import EmptyState from '@/components/EmptyState';

/**
 * 模板「版本历史」共享弹窗（合同模板 / 采购模板 2026-10-18 统一）。
 *
 * 业务口径：**不显示「修改人」**——两套模板的版本来源不同（合同是行式版本链、采购是快照表），
 * 只有采购存了 operator，继续展示会让两页看起来不一致；统一为「版本号 / 时间 / 操作」三列。
 *
 * 回滚语义由调用方决定（合同传 targetId、采购传 versionRecordId），本组件只把行 id 交回去。
 */
export interface TemplateVersionRow {
  id: string;
  version?: number;
  createdAt?: string | null;
  [key: string]: any;
}

interface Props {
  open: boolean;
  versions: TemplateVersionRow[];
  loading?: boolean;
  emptyText?: string;
  onClose: () => void;
  onRollback: (versionRecordId: string) => void;
}

export default function VersionHistoryModal({
  open,
  versions,
  loading,
  emptyText = '该模板还没有历史版本',
  onClose,
  onRollback,
}: Props) {
  return (
    <Modal title="版本历史" width={560} centered open={open} onCancel={onClose} footer={null} destroyOnHidden>
      <Table<TemplateVersionRow>
        scroll={{ x: 'max-content' }}
        rowKey="id"
        size="small"
        loading={loading}
        dataSource={versions}
        pagination={false}
        locale={{ emptyText: <EmptyState compact description={emptyText} /> }}
        columns={[
          {
            title: '版本号',
            dataIndex: 'version',
            width: 100,
            render: (v?: number) => <Tag color="blue">v{v ?? 1}</Tag>,
          },
          {
            title: '时间',
            dataIndex: 'createdAt',
            render: (v?: string) => (v ? String(v).slice(0, 19).replace('T', ' ') : '-'),
          },
          {
            title: '操作',
            width: 100,
            fixed: 'right',
            render: (_: unknown, row) => (
              <Popconfirm title="回滚后将基于该版本创建新版本" onConfirm={() => onRollback(row.id)}>
                <Button type="link" size="small">回滚</Button>
              </Popconfirm>
            ),
          },
        ]}
      />
    </Modal>
  );
}
