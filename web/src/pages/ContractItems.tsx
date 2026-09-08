import { useEffect, useState } from 'react';
import { Card, Table, Button, Form, Input, Space, Modal, Popconfirm, message, InputNumber, Select } from 'antd';
import { PlusOutlined, SearchOutlined, ExportOutlined, ImportOutlined, ThunderboltOutlined } from '@ant-design/icons';
import { itemApi, contractApi, supplierApi } from '@/api/business';
import { useTable } from '@/hooks/useTable';
import DictSelect, { DictTag } from '@/components/DictSelect';

const money = (v: number) => (v == null ? '-' : `¥${Number(v).toLocaleString('zh-CN', { maximumFractionDigits: 2 })}`);

export default function ContractItems() {
  const { loading, list, params, search, reload, pagination } = useTable<any>((p) => itemApi.list(p));
  const [form] = Form.useForm();
  const [modal, setModal] = useState(false);
  const [editing, setEditing] = useState<any>(null);

  const [contracts, setContracts] = useState<any[]>([]);
  const [suppliers, setSuppliers] = useState<any[]>([]);

  const [genOpen, setGenOpen] = useState(false);
  const [genContractId, setGenContractId] = useState<string>();
  const [genLoading, setGenLoading] = useState(false);

  useEffect(() => {
    contractApi.options().then((res: any) => setContracts(res || []));
    supplierApi.options().then((res: any) => setSuppliers(res || []));
  }, []);

  const openEdit = (row?: any) => {
    setEditing(row || null);
    form.resetFields();
    if (row) form.setFieldsValue(row);
    setModal(true);
  };

  const onContractChange = (id: string) => {
    const hit = contracts.find((c) => c.id === id);
    if (hit?.supplierId) {
      form.setFieldValue('supplierId', hit.supplierId);
      message.info(`已带出供应商：${hit.supplierName || ''}`);
    }
  };

  const submit = async () => {
    const values = await form.validateFields();
    const payload = {
      ...values,
      taxRate: values.taxRate == null ? undefined : Number(values.taxRate),
      qty: values.qty == null ? undefined : Number(values.qty),
      costPrice: values.costPrice == null ? undefined : Number(values.costPrice),
      comprehensivePrice: values.comprehensivePrice == null ? undefined : Number(values.comprehensivePrice),
    };
    if (editing) await itemApi.update(editing.id, payload);
    else await itemApi.create(payload);
    message.success('保存成功');
    setModal(false);
    setEditing(null);
    reload();
  };

  const openGenerate = () => {
    setGenOpen(true);
    setGenContractId(undefined);
  };

  const doGenerate = async () => {
    if (!genContractId) return message.warning('请选择合同');
    setGenLoading(true);
    try {
      await itemApi.generate(genContractId);
      message.success('已根据合同生成清单');
      setGenOpen(false);
      reload();
    } finally {
      setGenLoading(false);
    }
  };

  const importExcel = () => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.xlsx,.xls';
    input.onchange = async () => {
      const file = input.files?.[0];
      if (!file) return;
      const fd = new FormData();
      fd.append('file', file);
      const res = await fetch(itemApi.importUrl(), {
        method: 'POST',
        headers: { Authorization: `Bearer ${localStorage.getItem('cms_token')}` },
        body: fd,
      });
      const body = await res.json();
      if (body.code === 0) {
        message.success(`导入完成：新增 ${body.data.created}，更新 ${body.data.updated}`);
        reload();
      } else message.error(body.message);
    };
    input.click();
  };

  return (
    <Card
      title="合同清单"
      extra={
        <Space>
          <Button icon={<ThunderboltOutlined />} onClick={openGenerate}>由合同生成</Button>
          <Button icon={<ImportOutlined />} onClick={importExcel}>导入</Button>
          <Button icon={<ExportOutlined />} onClick={() => window.open(itemApi.exportUrl())}>导出</Button>
          <Button type="primary" icon={<PlusOutlined />} onClick={() => openEdit()}>新增清单</Button>
        </Space>
      }
    >
      <Form layout="inline" style={{ marginBottom: 16, rowGap: 8 }} onFinish={(v) => search(v)}>
        <Form.Item name="contractId">
          <Select
            showSearch
            optionFilterProp="label"
            placeholder="合同"
            allowClear
            style={{ minWidth: 200 }}
            options={contracts.map((c) => ({ value: c.id, label: `${c.code || ''} ${c.name || ''}`.trim() }))}
          />
        </Form.Item>
        <Form.Item name="supplierId">
          <Select
            showSearch
            optionFilterProp="label"
            placeholder="供应商"
            allowClear
            style={{ minWidth: 180 }}
            options={suppliers.map((s) => ({ value: s.id, label: s.name }))}
          />
        </Form.Item>
        <Form.Item name="materialCategory"><DictSelect typeCode="material_category" placeholder="物资类别" /></Form.Item>
        <Form.Item name="keyword"><Input placeholder="材料名称/规格" allowClear prefix={<SearchOutlined />} /></Form.Item>
        <Form.Item><Button type="primary" htmlType="submit">查询</Button></Form.Item>
      </Form>

      <Table
        rowKey="id"
        loading={loading}
        dataSource={list}
        pagination={pagination}
        scroll={{ x: 1600 }}
        columns={[
          { title: '供应商名称', width: 200, fixed: 'left', render: (_, row) => row.contract?.supplier?.name || '-' },
          { title: '供应物资类别', dataIndex: 'materialCategory', width: 140, render: (v) => <DictTag typeCode="material_category" value={v} /> },
          { title: '合同编号', width: 160, render: (_, row) => row.contract?.code || '-' },
          { title: '材料名称', dataIndex: 'materialName', width: 200 },
          { title: '规格型号', dataIndex: 'spec', width: 160 },
          { title: '计量单位', dataIndex: 'unit', width: 120, render: (v) => <DictTag typeCode="measurement_unit" value={v} /> },
          { title: '数量', dataIndex: 'qty', width: 120, render: (v) => (v == null ? '-' : Number(v).toLocaleString('zh-CN')) },
          { title: '成本单价', dataIndex: 'costPrice', width: 140, render: money },
          { title: '税率', dataIndex: 'taxRate', width: 100, render: (v) => (v == null ? '-' : `${(Number(v) * 100).toFixed(2)}%`) },
          { title: '综合单价', dataIndex: 'comprehensivePrice', width: 140, render: money },
          { title: '备注', dataIndex: 'remark', width: 200, ellipsis: true },
          {
            title: '操作',
            width: 160,
            fixed: 'right',
            render: (_, row) => (
              <Space size={4}>
                <Button type="link" size="small" onClick={() => openEdit(row)}>编辑</Button>
                <Popconfirm title="确认删除该清单项？" onConfirm={async () => { await itemApi.remove(row.id); message.success('已删除'); reload(); }}>
                  <Button type="link" size="small" danger>删除</Button>
                </Popconfirm>
              </Space>
            ),
          },
        ]}
      />

      <Modal
        title={editing ? '编辑清单' : '新增清单'}
        open={modal}
        onOk={submit}
        onCancel={() => setModal(false)}
        width={820}
        destroyOnClose
      >
        <Form form={form} layout="vertical">
          <Form.Item name="contractId" label="合同" rules={[{ required: true }]}>
            <Select
              showSearch
              optionFilterProp="label"
              placeholder="请选择合同"
              onChange={onContractChange}
              options={contracts.map((c) => ({ value: c.id, label: `${c.code || ''} ${c.name || ''}`.trim() }))}
            />
          </Form.Item>
          <Form.Item name="supplierId" label="供应商（选择合同后自动带出，可改）">
            <Select
              showSearch
              optionFilterProp="label"
              placeholder="请选择供应商"
              options={suppliers.map((s) => ({ value: s.id, label: s.name }))}
            />
          </Form.Item>
          <Form.Item name="materialCategory" label="供应物资类别" rules={[{ required: true }]}>
            <DictSelect typeCode="material_category" />
          </Form.Item>
          <Form.Item name="materialName" label="材料名称" rules={[{ required: true }]}><Input /></Form.Item>
          <Form.Item name="spec" label="规格型号"><Input /></Form.Item>
          <Form.Item name="unit" label="计量单位" rules={[{ required: true }]}>
            <DictSelect typeCode="measurement_unit" />
          </Form.Item>
          <Form.Item name="qty" label="数量"><InputNumber style={{ width: '100%' }} min={0} precision={3} /></Form.Item>
          <Form.Item name="costPrice" label="成本单价（元）"><InputNumber style={{ width: '100%' }} min={0} precision={2} /></Form.Item>
          <Form.Item name="taxRate" label="税率"><InputNumber style={{ width: '100%' }} min={0} max={1} step={0.01} precision={4} /></Form.Item>
          <Form.Item name="comprehensivePrice" label="综合单价（元）"><InputNumber style={{ width: '100%' }} min={0} precision={2} /></Form.Item>
          <Form.Item name="remark" label="备注"><Input.TextArea rows={2} /></Form.Item>
        </Form>
      </Modal>

      {/* 由合同生成 */}
      <Modal
        title="由合同生成清单"
        open={genOpen}
        onOk={doGenerate}
        onCancel={() => setGenOpen(false)}
        confirmLoading={genLoading}
        destroyOnClose
      >
        <p>选择合同后，系统将依据合同明细自动生成合同清单项。</p>
        <Form layout="vertical">
          <Form.Item label="选择合同" required>
            <Select
              showSearch
              optionFilterProp="label"
              placeholder="请选择合同"
              value={genContractId}
              onChange={setGenContractId}
              options={contracts.map((c) => ({ value: c.id, label: `${c.code || ''} ${c.name || ''}`.trim() }))}
            />
          </Form.Item>
        </Form>
      </Modal>
    </Card>
  );
}
