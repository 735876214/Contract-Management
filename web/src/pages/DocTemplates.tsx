import { useEffect, useState } from 'react';
import { Button, Form, Input, Select, Space, Modal, message, Table, Popconfirm, Tag, Card } from 'antd';
import { DeleteOutlined, EditOutlined, FileExcelOutlined, PlusOutlined, ReloadOutlined, SearchOutlined } from '@ant-design/icons';
import { docTemplateApi } from '@/api/modules';
import { dictApi, type DictOption } from '@/api/dict';
import DictSelect, { DictTag } from '@/components/DictSelect';
import EmptyState from '@/components/EmptyState';
import DocTemplateExcelField from '@/components/templates/DocTemplateExcelField';
import DocVariablePanel from '@/components/templates/DocVariablePanel';
import { PAYMENT_DOC_VAR_GROUPS, FINAL_SETTLEMENT_DOC_VAR_GROUPS } from '@/constants/docVariables';
import { toFileUrl } from '@/utils/templateFile';

/**
 * **分类 → 变量面板**：只给**已接生成路径**的分类提供变量清单
 * （当前：付款单、总结算单；其余三类插了也不会被替换，故面板层就不给）。
 * 新增生成路径时在这里加一行即可。
 */
const VAR_GROUPS_BY_CATEGORY: Record<string, typeof PAYMENT_DOC_VAR_GROUPS | undefined> = {
  PAYMENT: PAYMENT_DOC_VAR_GROUPS,
  FINAL_SETTLEMENT: FINAL_SETTLEMENT_DOC_VAR_GROUPS,
};

/**
 * 单据模板（基础信息管理，业务 2026-10-17/18）：五类单据的 **Excel 模板**。
 *
 * 业务口径：单据数据来自总日报等表格、导出也是 Excel —— 模板即**上传的 .xlsx 文件**
 * （占位符 `{{变量名}}` 写在单元格里，语法与合同/采购模板一致），生成时服务端
 * 读模板扫单元格替换（`doc-excel.ts`）。历史富文本模板的 content 字段保留但不再使用。
 * 文件落库用**相对存储键**（上传接口的 `key`），展示时统一 `toFileUrl()`——修掉历史上的双前缀。
 */
export default function DocTemplates() {
  const [form] = Form.useForm();
  const [filterForm] = Form.useForm();
  const [list, setList] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);
  const [modal, setModal] = useState(false);
  const [saving, setSaving] = useState(false);
  const [editing, setEditing] = useState<any>(null);
  const [categories, setCategories] = useState<DictOption[]>([]);

  const fetchList = async () => {
    const v = filterForm.getFieldsValue();
    setLoading(true);
    try {
      const res: any = await docTemplateApi.list({
        keyword: v.keyword || undefined,
        categoryCode: v.categoryCode || undefined,
        status: v.status ?? undefined,
      });
      setList(Array.isArray(res) ? res : res?.list || []);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    dictApi.options('doc_template_category').then((res: any) => setCategories(res || []));
    fetchList();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const submit = async () => {
    const v = await form.validateFields();
    if (!v.file?.fileUrl) return message.warning('请上传 Excel 模板文件（.xlsx）');
    const payload = {
      name: v.name,
      categoryCode: v.categoryCode,
      status: v.status === 0 ? 0 : 1,
      fileUrl: v.file.fileUrl,
      fileName: v.file.fileName,
    };
    setSaving(true);
    try {
      if (editing) await docTemplateApi.update(editing.id, { ...payload, version: editing.version });
      else await docTemplateApi.create(payload);
      message.success('保存成功');
      setModal(false);
      form.resetFields();
      setEditing(null);
      fetchList();
    } finally {
      setSaving(false);
    }
  };

  const openEdit = (row: any) => {
    setEditing(row);
    form.setFieldsValue({
      name: row.name,
      categoryCode: row.categoryCode,
      status: row.status === 0 ? 0 : 1,
      file: row.fileUrl ? { fileUrl: row.fileUrl, fileName: row.fileName || '模板.xlsx' } : null,
    });
    setModal(true);
  };

  const openCreate = () => {
    setEditing(null);
    form.resetFields();
    form.setFieldsValue({ status: 1, file: null });
    setModal(true);
  };

  const remove = async (row: any) => {
    await docTemplateApi.remove(row.id);
    message.success('已删除');
    fetchList();
  };

  const watchCategory = Form.useWatch('categoryCode', form);
  const varGroups = VAR_GROUPS_BY_CATEGORY[watchCategory as string];

  return (
    <Card
      title="单据模板"
      extra={
        <Space>
          <Button icon={<ReloadOutlined />} onClick={fetchList}>刷新</Button>
          <Button type="primary" icon={<PlusOutlined />} onClick={openCreate}>新增单据模板</Button>
        </Space>
      }
    >
      <Form form={filterForm} layout="inline" style={{ marginBottom: 16, rowGap: 8 }} onFinish={fetchList}>
        <Form.Item name="keyword">
          <Input placeholder="模板名称关键词" allowClear prefix={<SearchOutlined />} />
        </Form.Item>
        <Form.Item name="categoryCode">
          <Select allowClear style={{ minWidth: 180 }} placeholder="全部分类" options={categories} />
        </Form.Item>
        <Form.Item name="status">
          <Select
            allowClear
            style={{ minWidth: 120 }}
            placeholder="全部状态"
            options={[
              { value: 1, label: '启用' },
              { value: 0, label: '停用' },
            ]}
          />
        </Form.Item>
        <Form.Item>
          <Space>
            <Button type="primary" htmlType="submit">查询</Button>
            <Button onClick={() => { filterForm.resetFields(); fetchList(); }}>重置</Button>
          </Space>
        </Form.Item>
      </Form>

      <Table
        rowKey="id"
        loading={loading}
        dataSource={list}
        scroll={{ x: 1000 }}
        pagination={{ pageSize: 20, showSizeChanger: true, showTotal: (t) => `共 ${t} 条` }}
        locale={{ emptyText: <EmptyState compact description="暂无单据模板，点击右上角「新增单据模板」创建" /> }}
        columns={[
          { title: '模板名称', dataIndex: 'name', ellipsis: true },
          {
            title: '分类',
            dataIndex: 'categoryCode',
            width: 140,
            render: (v: any) => <DictTag typeCode="doc_template_category" value={v} />,
          },
          {
            title: 'Excel 模板',
            dataIndex: 'fileName',
            width: 220,
            render: (v: any, row: any) =>
              row.fileUrl ? (
                <a href={toFileUrl(row.fileUrl)} target="_blank" rel="noreferrer">
                  <FileExcelOutlined /> {v || '模板.xlsx'}
                </a>
              ) : (
                <Tag color="red">未上传</Tag>
              ),
          },
          {
            title: '状态',
            dataIndex: 'status',
            width: 90,
            render: (v: any) => (v === 0 ? <Tag>停用</Tag> : <Tag color="green">启用</Tag>),
          },
          { title: '版本', dataIndex: 'version', width: 80 },
          { title: '更新时间', dataIndex: 'updatedAt', width: 180, render: (v: any) => v?.slice(0, 19).replace('T', ' ') },
          {
            title: '操作',
            width: 150,
            fixed: 'right',
            render: (_v: any, row: any) => (
              <Space size={4}>
                <Button type="link" size="small" icon={<EditOutlined />} onClick={() => openEdit(row)}>
                  编辑
                </Button>
                <Popconfirm title="确认删除该单据模板？" onConfirm={() => remove(row)}>
                  <Button type="link" size="small" danger icon={<DeleteOutlined />}>
                    删除
                  </Button>
                </Popconfirm>
              </Space>
            ),
          },
        ]}
      />

      <Modal
        title={editing ? '编辑单据模板' : '新增单据模板'}
        open={modal}
        onOk={submit}
        onCancel={() => setModal(false)}
        okText="保存"
        confirmLoading={saving}
        width={960}
        destroyOnHidden
      >
        <Form form={form} layout="vertical">
          <Space size={16} style={{ display: 'flex', flexWrap: 'wrap' }}>
            <Form.Item name="name" label="模板名称" rules={[{ required: true }]} style={{ minWidth: 280 }}>
              <Input maxLength={100} placeholder="如 付款单（标准版）" />
            </Form.Item>
            <Form.Item name="categoryCode" label="分类" rules={[{ required: true }]} style={{ minWidth: 240 }}>
              <DictSelect typeCode="doc_template_category" placeholder="选择单据类别" />
            </Form.Item>
            <Form.Item name="status" label="状态" initialValue={1} style={{ minWidth: 110 }}>
              <Select
                options={[
                  { value: 1, label: '启用' },
                  { value: 0, label: '停用' },
                ]}
              />
            </Form.Item>
          </Space>

          <Form.Item
            name="file"
            label="Excel 模板文件（.xlsx；占位符写在单元格，如 {{单据编号}}）"
            rules={[{ required: true, message: '请上传 Excel 模板文件（.xlsx）' }]}
          >
            <DocTemplateExcelField />
          </Form.Item>

          {/* 变量清单（按分类展示）：Excel 模板时代变量面板只作**占位符名参考**（复制到单元格用） */}
          <Form.Item label="该分类可用的占位符（点击复制到 Excel 单元格）">
            <DocVariablePanel
              groups={varGroups}
              emptyHint="先选分类；「付款单」「总结算单」已接生成路径，其余三类待各自模块接入"
            />
          </Form.Item>
        </Form>
      </Modal>
    </Card>
  );
}
