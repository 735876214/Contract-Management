import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Alert, Button, Card, Modal, Space, Table, Tag, message } from 'antd';
import { DeleteOutlined, EditOutlined, PlusOutlined } from '@ant-design/icons';
import dayjs from 'dayjs';
import { contractApi } from '@/api/business';
import { DictTag } from '@/components/DictSelect';

/** 草稿超时阈值（需求 2.1.3：新增后 2 小时内未完成即视为超时） */
const OVERDUE_HOURS = 2;

const money = (v: number) =>
  v == null ? '-' : `¥${Number(v).toLocaleString('zh-CN', { maximumFractionDigits: 2 })}`;

/** 计算草稿超时剩余/超出分钟数：正数为剩余，负数为已超时 */
function overdueMinutes(createTime: string): number {
  return OVERDUE_HOURS * 60 - dayjs().diff(dayjs(createTime), 'minute');
}

/**
 * 合同起草页面（需求 2.1）
 * - 草稿列表：当前用户「未提交/未完成」（执行情况为 DRAFT 或空）的合同，数据隔离仅本人可见
 * - 新增合同：跳转至已有合同创建流程（合同台账页）
 * - 继续编辑：携带 ?edit=<id> 跳转合同台账页并自动打开编辑弹窗，保留已填数据
 * - 删除草稿：弹窗确认后物理删除
 */
export default function ContractDraft() {
  const navigate = useNavigate();
  const [rows, setRows] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res: any = await contractApi.drafts();
      setRows(Array.isArray(res) ? res : res?.list || []);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const handleRemove = (row: any) => {
    Modal.confirm({
      title: '删除草稿',
      content: `确认删除草稿「${row.name || row.code}」？删除后不可恢复。`,
      okText: '删除',
      okType: 'danger',
      cancelText: '取消',
      onOk: async () => {
        await contractApi.removeDraft(row.id);
        message.success('草稿已删除');
        load();
      },
    });
  };

  const overdueCount = useMemo(
    () => rows.filter((r) => overdueMinutes(r.createdAt) <= 0).length,
    [rows],
  );

  return (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      {overdueCount > 0 && (
        <Alert
          type="warning"
          showIcon
          message={`您有 ${overdueCount} 份合同草稿已超过 ${OVERDUE_HOURS} 小时未完成，请及时处理`}
        />
      )}

      <Card
        title="合同起草"
        extra={
          <Button type="primary" icon={<PlusOutlined />} onClick={() => navigate('/contracts')}>
            新增合同
          </Button>
        }
      >
        <Table
          rowKey="id"
          loading={loading}
          dataSource={rows}
          pagination={{ pageSize: 10, showTotal: (t: number) => `共 ${t} 条` }}
          scroll={{ x: 1100 }}
          columns={[
            { title: '合同编号', dataIndex: 'code', width: 200 },
            { title: '合同名称', dataIndex: 'name', width: 220, ellipsis: true },
            { title: '供应商名称', dataIndex: ['supplier', 'name'], width: 200, ellipsis: true, render: (v) => v || '-' },
            { title: '合同类型', dataIndex: 'typeCode', width: 140, render: (v) => (v ? <DictTag typeCode="contract_type" value={v} /> : '-') },
            { title: '合同额', dataIndex: 'amount', width: 140, align: 'right', render: money },
            {
              title: '创建时间',
              dataIndex: 'createdAt',
              width: 170,
              render: (v) => v?.slice(0, 19).replace('T', ' '),
            },
            {
              title: '最后编辑时间',
              dataIndex: 'updatedAt',
              width: 170,
              render: (v) => v?.slice(0, 19).replace('T', ' '),
            },
            {
              title: '状态',
              key: 'draftStatus',
              width: 130,
              render: (_, row) => {
                const mins = overdueMinutes(row.createdAt);
                return mins > 0 ? (
                  <Tag>剩余 {Math.floor(mins / 60)} 小时 {mins % 60} 分</Tag>
                ) : (
                  <Tag color="orange">已超时 {-mins} 分钟</Tag>
                );
              },
            },
            {
              title: '操作',
              key: 'action',
              width: 170,
              fixed: 'right',
              render: (_, row) => (
                <Space size={4}>
                  <Button
                    type="link"
                    size="small"
                    icon={<EditOutlined />}
                    onClick={() => navigate(`/contracts?edit=${row.id}`)}
                  >
                    继续编辑
                  </Button>
                  <Button type="link" size="small" danger icon={<DeleteOutlined />} onClick={() => handleRemove(row)}>
                    删除
                  </Button>
                </Space>
              ),
            },
          ]}
        />
      </Card>
    </Space>
  );
}
