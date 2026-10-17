import { useEffect, useState } from 'react';
import { Button, Form, Input, Select, Space, Modal, message, Table, Popconfirm, Tag, Switch, Upload } from 'antd';
import { DeleteOutlined, FileExcelOutlined, PlusOutlined, UploadOutlined } from '@ant-design/icons';
import { docTemplateApi } from '@/api/modules';
import { fileApi } from '@/api/auth';
import { dictApi, type DictOption } from '@/api/dict';
import DictSelect, { DictTag } from '@/components/DictSelect';
import { PAYMENT_DOC_VAR_GROUPS, FINAL_SETTLEMENT_DOC_VAR_GROUPS } from '@/constants/docVariables';

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
 * 单据模板（基础信息管理，业务 2026-10-17）：五类单据的 **Excel 模板**。
 *
 * 业务口径：单据数据来自总日报等表格、导出也是 Excel —— 模板即**上传的 .xlsx 文件**
 * （占位符 `{{变量名}}` 写在单元格里，语法与合同/采购模板一致），生成时服务端
 * 读模板扫单元格替换（`doc-excel.ts`）。历史富文本模板的 content 字段保留但不再使用。
 * 变量面板在本页只作**占位符名清单**展示（复制名称到 Excel 单元格用），不再插富文本。
 */
export default function DocTemplates() {
  const [form] = Form.useForm();
  const [list, setList] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);
  const [modal, setModal] = useState(false);
  const [editing, setEditing] = useState<any>(null);
  const [categories, setCategories] = useState<DictOption[]>([]);
  const [filterCategory, setFilterCategory] = useState<string | undefined>(undefined);
  // 上传的 Excel 模板（fileUrl 为 StorageService 相对键；展示用 /api/files/ 前缀）
  const [file, setFile] = useState<{ fileUrl: string; fileName: string } | null>(null);
  const [uploading, setUploading] = useState(false);

  const load = async (category: string | undefined = filterCategory) => {
    setLoading(true);
    try {
      const res: any = await docTemplateApi.list({ categoryCode: category });
      setList(Array.isArray(res) ? res : res?.list || []);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    dictApi.options('doc_template_category').then((res: any) => setCategories(res || []));
    load(undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const submit = async () => {
    const v = await form.validateFields();
    if (!file?.fileUrl) return message.warning('请上传 Excel 模板文件（.xlsx）');
    const payload = {
      name: v.name,
      categoryCode: v.categoryCode,
      status: v.status === false ? 0 : 1,
      fileUrl: file.fileUrl,
      fileName: file.fileName,
    };
    if (editing) await docTemplateApi.update(editing.id, { ...payload, version: editing.version });
    else await docTemplateApi.create(payload);
    message.success('保存成功');
    setModal(false);
    form.resetFields();
    setEditing(null);
    setFile(null);
    load();
  };

  const openEdit = (row: any) => {
    setEditing(row);
    form.setFieldsValue({ name: row.name, categoryCode: row.categoryCode, status: row.status !== 0 });
    setFile(row.fileUrl ? { fileUrl: row.fileUrl, fileName: row.fileName || '模板.xlsx' } : null);
    setModal(true);
  };

  const remove = async (row: any) => {
    await docTemplateApi.remove(row.id);
    message.success('已删除');
    load();
  };

  const watchCategory = Form.useWatch('categoryCode', form);
  const varGroups = VAR_GROUPS_BY_CATEGORY[watchCategory as string];

  return (
    <>
      <Space wrap size={8} style={{ marginBottom: 12 }}>
        <Select
          allowClear
          style={{ width: 180 }}
          placeholder="全部分类"
          value={filterCategory}
          options={categories}
          onChange={(v) => {
            setFilterCategory(v);
            load(v);
          }}
        />
        <Button
          type="primary"
          icon={<PlusOutlined />}
          onClick={() => {
            setEditing(null);
            form.resetFields();
            form.setFieldsValue({ status: true });
            setFile(null);
            setModal(true);
          }}
        >
          新增单据模板
        </Button>
      </Space>

      <Table
        rowKey="id"
        loading={loading}
        dataSource={list}
        scroll={{ x: 900 }}
        columns={[
          { title: '模板名称', dataIndex: 'name', width: 240 },
          {
            title: '分类',
            dataIndex: 'categoryCode',
            width: 140,
            render: (v: any) => <DictTag typeCode="doc_template_category" value={v} />,
          },
          {
            title: 'Excel 模板',
            dataIndex: 'fileName',
            width: 200,
            render: (v: any, row: any) =>
              row.fileUrl ? (
                <a href={`/api/files/${row.fileUrl}`} target="_blank" rel="noreferrer">
                  <FileExcelOutlined /> {v || '模板.xlsx'}
                </a>
              ) : (
                <Tag color="red">未上传</Tag>
              ),
          },
          {
            title: '状态',
            dataIndex: 'status',
            width: 100,
            render: (v: any) => (v === 0 ? <Tag>停用</Tag> : <Tag color="green">启用</Tag>),
          },
          { title: '版本', dataIndex: 'version', width: 80 },
          { title: '更新时间', dataIndex: 'updatedAt', width: 180, render: (v: any) => v?.slice(0, 19).replace('T', ' ') },
          {
            title: '操作',
            width: 160,
            fixed: 'right',
            render: (_v: any, row: any) => (
              <Space size={4}>
                <Button type="link" size="small" onClick={() => openEdit(row)}>
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
        width={860}
        destroyOnHidden
      >
        <Form form={form} layout="vertical">
          <Space size={16} style={{ display: 'flex', flexWrap: 'wrap' }}>
            <Form.Item name="name" label="模板名称" rules={[{ required: true }]} style={{ minWidth: 260 }}>
              <Input maxLength={100} placeholder="如 付款单（标准版）" />
            </Form.Item>
            <Form.Item name="categoryCode" label="分类" rules={[{ required: true }]} style={{ minWidth: 200 }}>
              <DictSelect typeCode="doc_template_category" placeholder="选择单据类别" />
            </Form.Item>
            <Form.Item name="status" label="启用" valuePropName="checked">
              <Switch />
            </Form.Item>
          </Space>

          <Form.Item label="Excel 模板文件（.xlsx；占位符写在单元格，如 {{单据编号}}）" required>
            <Space direction="vertical" size={4} style={{ width: '100%' }}>
              <Upload
                accept=".xlsx,.xlsm"
                maxCount={1}
                showUploadList={false}
                customRequest={async (options: any) => {
                  setUploading(true);
                  try {
                    const arr = await fileApi.upload([options.file as File]);
                    setFile({ fileUrl: arr?.[0]?.url, fileName: arr?.[0]?.fileName });
                    message.success(`「${arr?.[0]?.fileName}」上传成功`);
                    options.onSuccess?.(arr?.[0]);
                  } catch (e) {
                    options.onError?.(e);
                  } finally {
                    setUploading(false);
                  }
                }}
              >
                <Button icon={<UploadOutlined />} loading={uploading}>
                  {file ? '重新上传' : '上传 Excel 模板'}
                </Button>
              </Upload>
              {file ? (
                <a href={`/api/files/${file.fileUrl}`} target="_blank" rel="noreferrer">
                  <FileExcelOutlined /> {file.fileName}
                </a>
              ) : (
                <span style={{ color: 'var(--cms-muted-soft)' }}>
                  未上传。占位符写在单元格文本里（语法与合同模板一致），生成单据时服务端自动替换。
                </span>
              )}
            </Space>
          </Form.Item>

          {/* 变量清单（按分类展示）：Excel 模板时代变量面板只作**占位符名参考**（复制到单元格用） */}
          <Form.Item label="该分类可用的占位符（复制到 Excel 单元格）">
            {varGroups ? (
              <Space wrap size={4}>
                {varGroups.flatMap((g: any) => (g?.items || []).map((v: any) => (
                  <Tag key={v.key} color="geekblue" style={{ fontFamily: 'monospace' }}>{`{{${v.key}}}`}</Tag>
                )))}
              </Space>
            ) : (
              <span style={{ color: 'var(--cms-muted-soft)' }}>
                先选分类；「付款单」「总结算单」已接生成路径，其余三类待各自模块接入
              </span>
            )}
          </Form.Item>
        </Form>
      </Modal>
    </>
  );
}
