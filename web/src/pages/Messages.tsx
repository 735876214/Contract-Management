import { useState } from 'react';
import {
  Card,
  Table,
  Button,
  Form,
  Select,
  Space,
  Tag,
  message,
} from 'antd';
import { ReadOutlined } from '@ant-design/icons';
import { notificationApi } from '@/api/modules';
import { useTable } from '@/hooks/useTable';

const READ_OPTIONS = [
  { value: '', label: '全部' },
  { value: 'unread', label: '未读' },
  { value: 'read', label: '已读' },
];

export default function Messages() {
  const { loading, list, pagination, search, reload } = useTable<any>((p) => notificationApi.list(p));
  const [queryForm] = Form.useForm();

  const markRead = async (id: string) => {
    await notificationApi.read(id);
    message.success('已标记为已读');
    reload();
  };

  const markAll = async () => {
    await notificationApi.readAll();
    message.success('已全部标记为已读');
    reload();
  };

  return (
    <Card
      title="消息中心"
      extra={
        <Button icon={<ReadOutlined />} onClick={markAll}>全部已读</Button>
      }
    >
      <Form layout="inline" style={{ marginBottom: 16, rowGap: 8 }} form={queryForm} onFinish={(v) => search(v)}>
        <Form.Item name="read" label="是否已读">
          <Select style={{ width: 160 }} options={READ_OPTIONS} allowClear />
        </Form.Item>
        <Form.Item><Button type="primary" htmlType="submit">查询</Button></Form.Item>
        <Form.Item><Button onClick={() => { queryForm.resetFields(); search({}); }}>重置</Button></Form.Item>
      </Form>

      <Table
        rowKey="id"
        loading={loading}
        dataSource={list}
        pagination={pagination}
        scroll={{ x: 1000 }}
        columns={[
          { title: '标题', dataIndex: 'title', width: 260, ellipsis: true },
          { title: '内容', dataIndex: 'content', ellipsis: true },
          {
            title: '类型',
            dataIndex: 'type',
            width: 120,
            render: (v: any) => <Tag color="blue">{v || '-'}</Tag>,
          },
          { title: '业务类型', dataIndex: 'bizType', width: 140 },
          {
            title: '已读状态',
            dataIndex: 'read',
            width: 110,
            render: (v: any, row: any) =>
              row.read || v ? <Tag color="green">已读</Tag> : <Tag color="red">未读</Tag>,
          },
          { title: '创建时间', dataIndex: 'createdAt', width: 180 },
          {
            title: '操作',
            width: 110,
            fixed: 'right',
            render: (_: any, row: any) =>
              row.read ? (
                <span style={{ color: '#999' }}>-</span>
              ) : (
                <Button type="link" size="small" onClick={() => markRead(row.id)}>标记已读</Button>
              ),
          },
        ]}
      />
    </Card>
  );
}
