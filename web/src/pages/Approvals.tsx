import { useState } from 'react';
import {
  Card,
  Table,
  Tabs,
  Button,
  Space,
  Modal,
  Input,
  Tag,
  message,
} from 'antd';
import { CheckOutlined, CloseOutlined, SwapOutlined } from '@ant-design/icons';
import { approvalApi } from '@/api/modules';
import { DictTag } from '@/components/DictSelect';
import { useTable } from '@/hooks/useTable';

interface ActionModalState {
  open: boolean;
  id: string;
  action: string;
  actionName: string;
}

function ApprovalList({ fetcher, withActions }: { fetcher: (p: any) => Promise<any>; withActions: boolean }) {
  const { loading, list, pagination, reload } = useTable<any>(fetcher);
  const [actionModal, setActionModal] = useState<ActionModalState>({ open: false, id: '', action: '', actionName: '' });
  const [comment, setComment] = useState('');

  const openAction = (row: any, action: string, actionName: string) => {
    setComment('');
    setActionModal({ open: true, id: row.id, action, actionName });
  };

  const submitAction = async () => {
    await approvalApi.handle(actionModal.id, actionModal.action, comment);
    message.success(`${actionModal.actionName}成功`);
    setActionModal({ ...actionModal, open: false });
    reload();
  };

  const columns: any[] = [
    { title: '标题', dataIndex: 'title', width: 260, ellipsis: true },
    { title: '业务类型', dataIndex: 'bizType', width: 140 },
    { title: '申请人', dataIndex: 'applicant', width: 130 },
    { title: '状态', dataIndex: 'status', width: 110, render: (v: any) => <DictTag typeCode="approval_status" value={v} /> },
    { title: '当前节点', dataIndex: 'currentNode', width: 160 },
    { title: '提交时间', dataIndex: 'submittedAt', width: 170 },
  ];

  if (withActions) {
    columns.push({
      title: '操作',
      width: 220,
      fixed: 'right',
      render: (_: any, row: any) => (
        <Space size={4}>
          <Button type="link" size="small" icon={<CheckOutlined />} onClick={() => openAction(row, 'approve', '通过')}>通过</Button>
          <Button type="link" size="small" danger icon={<CloseOutlined />} onClick={() => openAction(row, 'reject', '驳回')}>驳回</Button>
          <Button type="link" size="small" icon={<SwapOutlined />} onClick={() => openAction(row, 'transfer', '转办')}>转办</Button>
        </Space>
      ),
    });
  }

  return (
    <>
      <Table
        rowKey="id"
        loading={loading}
        dataSource={list}
        pagination={pagination}
        scroll={{ x: 1200 }}
        columns={columns}
        expandable={{
          expandedRowRender: (row: any) =>
            row.records && row.records.length ? (
              <Table
                rowKey="id"
                size="small"
                pagination={false}
                dataSource={row.records}
                columns={[
                  { title: '节点名', dataIndex: 'node', width: 160 },
                  { title: '审批人', dataIndex: 'approver', width: 140 },
                  { title: '动作', dataIndex: 'action', width: 100, render: (v: any) => <Tag>{v || '-'}</Tag> },
                  { title: '意见', dataIndex: 'comment', ellipsis: true },
                  { title: '时间', dataIndex: 'time', width: 170 },
                ]}
              />
            ) : (
              <span style={{ color: '#999' }}>暂无审批记录</span>
            ),
        }}
      />
      <Modal
        title={`${actionModal.actionName}审批`}
        open={actionModal.open}
        onOk={submitAction}
        onCancel={() => setActionModal({ ...actionModal, open: false })}
        okText="提交"
        destroyOnClose
      >
        <Input.TextArea
          rows={4}
          value={comment}
          onChange={(e) => setComment(e.target.value)}
          placeholder="请输入审批意见"
        />
      </Modal>
    </>
  );
}

export default function Approvals() {
  return (
    <Card title="审批中心">
      <Tabs
        items={[
          { key: 'todo', label: '待审批', children: <ApprovalList fetcher={(p) => approvalApi.todo(p)} withActions /> },
          { key: 'done', label: '已审批', children: <ApprovalList fetcher={(p) => approvalApi.done(p)} withActions={false} /> },
          { key: 'mine', label: '我发起的', children: <ApprovalList fetcher={(p) => approvalApi.mine(p)} withActions={false} /> },
        ]}
      />
    </Card>
  );
}
