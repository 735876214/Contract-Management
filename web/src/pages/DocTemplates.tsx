import { useEffect, useState } from 'react';
import { Button, Form, Input, Select, Space, Modal, message, Table, Popconfirm, Tag, Switch } from 'antd';
import { PlusOutlined, DeleteOutlined } from '@ant-design/icons';
import { docTemplateApi } from '@/api/modules';
import { dictApi, type DictOption } from '@/api/dict';
import DictSelect, { DictTag } from '@/components/DictSelect';
import RichTextEditor from '@/components/RichTextEditor';
import { PAYMENT_DOC_VAR_GROUPS } from '@/constants/docVariables';

/**
 * 单据模板（基础信息管理，业务口径 2026-10-16）：管理**五类**单据的 Word 模板
 * —— 结算单 / 总结算单 / 保理单 / 逾期利息 / 付款单。
 *
 * 分类取自字典 `doc_template_category`（**不复用**合同模板分类：混在一起会让合同模板的分类下拉里
 * 冒出"付款单"）。存储复用 `ContractTemplate` 表。
 *
 * ⚠️ **变量面板只在「付款单」分类下提供**：本期只有付款单接了 Word 生成路径，
 * 其余四类插了变量也**不会被替换**（渲染器会原样留着占位符）。与其让人插了不生效，
 * 不如在面板层就不给 —— 等各自模块接上生成路径后再放开。
 */
export default function DocTemplates() {
  const [form] = Form.useForm();
  const [list, setList] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);
  const [modal, setModal] = useState(false);
  const [editing, setEditing] = useState<any>(null);
  const [categories, setCategories] = useState<DictOption[]>([]);
  const [filterCategory, setFilterCategory] = useState<string | undefined>(undefined);

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
    const payload = {
      name: v.name,
      categoryCode: v.categoryCode,
      content: v.content,
      status: v.status === false ? 0 : 1,
    };
    if (editing) await docTemplateApi.update(editing.id, { ...payload, version: editing.version });
    else await docTemplateApi.create(payload);
    message.success('保存成功');
    setModal(false);
    form.resetFields();
    setEditing(null);
    load();
  };

  const openEdit = (row: any) => {
    setEditing(row);
    form.setFieldsValue({
      name: row.name,
      categoryCode: row.categoryCode,
      content: row.content,
      status: row.status !== 0,
    });
    setModal(true);
  };

  const remove = async (row: any) => {
    await docTemplateApi.remove(row.id);
    message.success('已删除');
    load();
  };

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
        width={1000}
        destroyOnHidden
      >
        <Form form={form} layout="vertical">
          <Space size={16} style={{ display: 'flex', flexWrap: 'wrap' }}>
            <Form.Item name="name" label="模板名称" rules={[{ required: true }]} style={{ minWidth: 280 }}>
              <Input maxLength={100} placeholder="如 付款单（标准版）" />
            </Form.Item>
            <Form.Item name="categoryCode" label="分类" rules={[{ required: true }]} style={{ minWidth: 200 }}>
              <DictSelect typeCode="doc_template_category" placeholder="选择单据类别" />
            </Form.Item>
            <Form.Item name="status" label="启用" valuePropName="checked">
              <Switch />
            </Form.Item>
          </Space>
          {/* 变量面板只在「付款单」分类下提供 —— 这里必须用 Form.Item 的 shouldUpdate 读值，
              不能用 Form.useWatch：弹窗是 destroyOnHidden，关闭时 form 未连接，
              useWatch 会**停在初始值**（真渲染实测：编辑付款单模板时面板不出现） */}
          <Form.Item noStyle shouldUpdate={(prev, cur) => prev.categoryCode !== cur.categoryCode}>
            {({ getFieldValue }: any) => {
              const showVars = getFieldValue('categoryCode') === 'PAYMENT';
              return (
                <Form.Item name="content" label="模板内容" rules={[{ required: true, message: '请编辑模板内容' }]}>
                  <RichTextEditor
                    variableGroups={showVars ? PAYMENT_DOC_VAR_GROUPS : undefined}
                    variableScope={showVars ? 'doc' : undefined}
                    minHeight={360}
                    placeholder={
                      showVars
                        ? '在此编辑付款单模板，可点击「插入变量」把占位符插到光标处（语法 {{变量名}}，单花括号不生效）'
                        : '先在「分类」里选「付款单」才会出现该类的变量面板；其余四类的变量待各自模块接上生成路径后再放开'
                    }
                  />
                </Form.Item>
              );
            }}
          </Form.Item>
        </Form>
      </Modal>
    </>
  );
}
