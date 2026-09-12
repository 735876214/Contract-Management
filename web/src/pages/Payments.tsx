import { useEffect, useState } from 'react';
import { withToken } from '../utils/download';
import {
  Button,
  Form,
  Input,
  Select,
  Space,
  Modal,
  message,
  Row,
  Col,
  InputNumber,
} from 'antd';
import { PlusOutlined, ExportOutlined } from '@ant-design/icons';
import { paymentApi } from '@/api/modules';
import { contractApi } from '@/api/business';
import ModuleListPage, { type ModuleListFilterField, type ModuleListRow } from '@/components/procurement/ModuleListPage';
import ImportButton from '@/components/ImportButton';

const money = (v: number) =>
  v == null ? '-' : `¥${Number(v).toLocaleString('zh-CN', { maximumFractionDigits: 2 })}`;

/** 付款管理（问题四：统一标准列表页规约） */
export default function Payments() {
  const [contracts, setContracts] = useState<any[]>([]);
  useEffect(() => {
    contractApi.list({ pageSize: 1000 }).then((res: any) => setContracts(res?.list || []));
  }, []);
  const contractOptions = contracts.map((c) => ({ value: c.id, label: `${c.code} ${c.name}` }));

  return <RecordTab contractOptions={contractOptions} />;
}

function RecordTab({ contractOptions }: { contractOptions: any[] }) {
  const [form] = Form.useForm();
  const [modal, setModal] = useState(false);
  const [editing, setEditing] = useState<any>(null);
  const [listRefresh, setListRefresh] = useState(0);
  const refreshList = () => setListRefresh((k) => k + 1);

  const submit = async () => {
    const v = await form.validateFields();
    const payload = { ...v };
    if (editing) await paymentApi.updateRecord(editing.id, payload);
    else await paymentApi.createRecord(payload);
    message.success('保存成功');
    setModal(false);
    form.resetFields();
    setEditing(null);
    refreshList();
  };

  const openEdit = (row: any) => {
    setEditing(row);
    form.setFieldsValue(row);
    setModal(true);
  };

  const handleRemove = (row: ModuleListRow) => {
    Modal.confirm({
      title: '确认删除该台账记录？',
      okText: '确认删除',
      okType: 'danger',
      onOk: async () => {
        await paymentApi.removeRecord(row.id);
        message.success('已删除');
        refreshList();
      },
    });
  };

  /** 筛选项（问题四：标准筛选区） */
  const extraFilters: ModuleListFilterField[] = [
    { key: 'contractId', label: '合同', control: 'select', options: contractOptions },
    { key: 'payMonth', label: '付款月份', control: 'input', placeholder: 'YYYY-MM' },
  ];

  /** 表格列（问题四：generic 模式完整列定义） */
  const extraColumns: any[] = [
    { title: '供应商名称', width: 220, fixed: 'left', render: (_v: any, r: any) => r.contract?.supplier?.name || '-' },
    { title: '合同名称', width: 260, render: (_v: any, r: any) => r.contract?.name || '-' },
    { title: '合同编号', width: 160, render: (_v: any, r: any) => r.contract?.code || '-' },
    { title: '付款月份', dataIndex: 'payMonth', width: 110 },
    { title: '本月付款额', dataIndex: 'amount', width: 140, align: 'right', render: money },
  ];

  return (
    <>
      <ModuleListPage
        mode="generic"
        fetcher={(params) => paymentApi.records(params)}
        extraFilters={extraFilters}
        extraColumns={extraColumns}
        refreshKey={listRefresh}
        onEdit={(row) => openEdit(row)}
        onDelete={handleRemove}
        toolbarLeft={
          <Space wrap size={8}>
            <ImportButton
              moduleName="付款台账"
              templateUrl={paymentApi.recordsTemplateUrl()}
              uploadUrl={paymentApi.recordsImportUrl()}
              onDone={refreshList}
            />
            <Button icon={<ExportOutlined />} onClick={() => window.open(withToken(paymentApi.exportRecordsUrl()))}>
              导出台账
            </Button>
            <Button
              type="primary"
              icon={<PlusOutlined />}
              onClick={() => {
                setEditing(null);
                form.resetFields();
                setModal(true);
              }}
            >
              新增台账
            </Button>
          </Space>
        }
      />

      <Modal
        title={editing ? '编辑付款台账' : '新增付款台账'}
        open={modal}
        onOk={submit}
        onCancel={() => setModal(false)}
        width={720}
        destroyOnClose
      >
        <Form form={form} layout="vertical">
          <Row gutter={16}>
            <Col xs={24} md={12}>
              <Form.Item name="contractId" label="合同" rules={[{ required: true }]}>
                <Select
                  showSearch
                  optionFilterProp="label"
                  allowClear
                  placeholder="请选择合同"
                  options={contractOptions}
                />
              </Form.Item>
            </Col>
            <Col xs={24} md={12}>
              <Form.Item name="payMonth" label="付款月份(YYYY-MM)" rules={[{ required: true }]}>
                <Input placeholder="如 2026-09" />
              </Form.Item>
            </Col>
            <Col xs={24} md={12}>
              <Form.Item name="amount" label="本月付款额" rules={[{ required: true }]}>
                <InputNumber style={{ width: '100%' }} min={0} precision={2} />
              </Form.Item>
            </Col>
          </Row>
        </Form>
      </Modal>
    </>
  );
}
