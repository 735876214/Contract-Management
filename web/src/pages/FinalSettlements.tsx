import { useEffect, useState } from 'react';
import { withToken } from '../utils/download';
import { Button, Form, Input, Select, Space, Modal, message, Table, Popconfirm, Tag, Upload } from 'antd';
import { PlusOutlined, UploadOutlined, ExportOutlined, DeleteOutlined } from '@ant-design/icons';
import { finalSettlementApi } from '@/api/modules';
import { fileApi } from '@/api/auth';
import { contractApi } from '@/api/business';
import { DictTag } from '@/components/DictSelect';

const money = (v: any) => (v == null ? '-' : `¥${Number(v).toLocaleString('zh-CN', { maximumFractionDigits: 2 })}`);

/**
 * 总结算单（结算及付款管理，业务口径 2026-10-16）。
 *
 * 三步：**生成**（抓取该合同全部月度结算 → 明细快照 + 合计）→ **上传附件**（附件到位即「已结算」，
 * 合同执行情况随之置「已完已结」、付款比例切 100%）→ 可导出 Excel（模板在「单据模板」里维护）。
 *
 * ⚠️ 明细与合计都是**生成时的快照**：月度结算事后被改，不回头改已出的总结算单
 * （所以页面上不提供"重新抓取"，要更新就删掉重生成）。
 */
export default function FinalSettlements() {
  const [form] = Form.useForm();
  const [list, setList] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);
  const [modal, setModal] = useState(false);
  const [editing, setEditing] = useState<any>(null);
  const [contracts, setContracts] = useState<any[]>([]);
  const [filterContract, setFilterContract] = useState<string | undefined>(undefined);
  const [uploadingId, setUploadingId] = useState<string | null>(null);

  const load = async (contractId = filterContract) => {
    setLoading(true);
    try {
      const res: any = await finalSettlementApi.list({ contractId, pageSize: 200 });
      setList(res?.list || []);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    // 用轻量 options 接口：列表接口的 pageSize 上限是 500，合同超过 500 份时后续合同在下拉里会静默消失
    contractApi.options().then((res: any) => setContracts(res || [])).catch(() => undefined);
    load(undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const contractOptions = contracts.map((c) => ({ value: c.id, label: `${c.code} ${c.name}` }));

  const doGenerate = async () => {
    // 只校验本弹窗的字段：两个弹窗共用一个 form 实例，不限定字段会把另一个弹窗的必填项也带上
    const v = await form.validateFields(['contractId']);
    const created: any = await finalSettlementApi.generate(v.contractId);
    message.success(`已生成总结算单 ${created?.code || ''}（${created?.items?.length || 0} 期月度结算）`);
    setModal(false);
    form.resetFields();
    load();
  };

  /** 上传附件 → 已结算（后端会把合同置「已完已结」并重算付款比例） */
  const uploadAttachment = async (row: any, file: File) => {
    setUploadingId(row.id);
    try {
      const [uploaded] = (await fileApi.upload([file])) || [];
      if (!uploaded?.url) throw new Error('上传失败');
      await finalSettlementApi.attach(row.id, { url: uploaded.url, fileName: uploaded.fileName });
      message.success('附件已上传：总结算单已结算，合同执行情况置「已完已结」、付款比例切 100%');
      load();
    } finally {
      setUploadingId(null);
    }
    // 阻止 antd 默认上传行为（走我们自己的 fileApi）
    return false;
  };

  const saveRemark = async () => {
    const v = await form.validateFields(['remark']);
    await finalSettlementApi.update(editing.id, { remark: v.remark, version: editing.version });
    message.success('已保存');
    setEditing(null);
    form.resetFields();
    load();
  };

  const remove = async (row: any) => {
    await finalSettlementApi.remove(row.id);
    message.success(row.statusCode === 'SETTLED' ? '已删除，合同执行情况已回退' : '已删除');
    load();
  };

  return (
    <>
      <Space wrap size={8} style={{ marginBottom: 12 }}>
        <Select
          allowClear
          style={{ width: 280 }}
          placeholder="全部合同"
          value={filterContract}
          options={contractOptions}
          showSearch
          optionFilterProp="label"
          onChange={(v) => {
            setFilterContract(v);
            load(v);
          }}
        />
        <Button
          type="primary"
          icon={<PlusOutlined />}
          onClick={() => {
            form.resetFields();
            setModal(true);
          }}
        >
          生成总结算单
        </Button>
      </Space>

      <Table
        rowKey="id"
        loading={loading}
        dataSource={list}
        scroll={{ x: 1100 }}
        expandable={{
          expandedRowRender: (row: any) => (
            <Table
              rowKey="id"
              size="small"
              pagination={false}
              dataSource={row.items || []}
              columns={[
                { title: '结算月份', dataIndex: 'settleMonth', width: 140 },
                { title: '结算金额', dataIndex: 'amount', width: 180, align: 'right', render: money },
              ]}
            />
          ),
        }}
        columns={[
          { title: '单据编号', dataIndex: 'code', width: 220, fixed: 'left' },
          {
            title: '合同',
            width: 260,
            render: (_v: any, r: any) => `${r.contract?.code || ''} ${r.contract?.name || ''}`.trim() || '-',
          },
          { title: '总结算金额', dataIndex: 'totalAmount', width: 160, align: 'right', render: money },
          { title: '结算月数', width: 100, render: (_v: any, r: any) => (r.items || []).length },
          {
            title: '状态',
            dataIndex: 'statusCode',
            width: 110,
            render: (v: any) => <DictTag typeCode="final_settlement_status" value={v} />,
          },
          {
            title: '合同执行情况',
            width: 120,
            render: (_v: any, r: any) => <DictTag typeCode="contract_execution_status" value={r.contract?.execStatus} />,
          },
          {
            title: '附件',
            width: 180,
            render: (_v: any, r: any) =>
              r.attachmentUrl ? (
                <a href={withToken(r.attachmentUrl)} target="_blank" rel="noreferrer">
                  {r.attachmentName || '查看附件'}
                </a>
              ) : (
                <Tag>未上传</Tag>
              ),
          },
          {
            title: '操作',
            width: 280,
            fixed: 'right',
            render: (_v: any, row: any) => (
              <Space size={4} wrap>
                <Upload
                  showUploadList={false}
                  accept=".pdf,.doc,.docx,.jpg,.jpeg,.png"
                  beforeUpload={(file) => uploadAttachment(row, file as File)}
                >
                  <Button type="link" size="small" icon={<UploadOutlined />} loading={uploadingId === row.id}>
                    {row.attachmentUrl ? '重传附件' : '上传附件'}
                  </Button>
                </Upload>
                <Button
                  type="link"
                  size="small"
                  icon={<ExportOutlined />}
                  onClick={() => window.open(withToken(finalSettlementApi.exportUrl(row.id)))}
                >
                  导出
                </Button>
                <Button
                  type="link"
                  size="small"
                  onClick={() => {
                    setEditing(row);
                    form.setFieldsValue({ remark: row.remark });
                  }}
                >
                  备注
                </Button>
                <Popconfirm
                  title="确认删除该总结算单？已结算的单据删除后，合同的「已完已结」会一并回退。"
                  onConfirm={() => remove(row)}
                >
                  <Button type="link" size="small" danger icon={<DeleteOutlined />}>
                    删除
                  </Button>
                </Popconfirm>
              </Space>
            ),
          },
        ]}
      />

      {/* 生成弹窗 */}
      <Modal
        title="生成总结算单"
        open={modal}
        onOk={doGenerate}
        onCancel={() => setModal(false)}
        width={560}
        destroyOnHidden
      >
        <Form form={form} layout="vertical">
          <Form.Item
            name="contractId"
            label="合同"
            rules={[{ required: true, message: '请选择合同' }]}
            extra="将抓取该合同全部（非草稿）月度结算的月份与金额，落成总结算明细（快照）；一个合同只允许一张总结算单"
          >
            <Select showSearch allowClear optionFilterProp="label" placeholder="请选择合同" options={contractOptions} />
          </Form.Item>
        </Form>
      </Modal>

      {/* 备注弹窗 */}
      <Modal title="备注" open={!!editing} onOk={saveRemark} onCancel={() => setEditing(null)} width={520} destroyOnHidden>
        <Form form={form} layout="vertical">
          <Form.Item name="remark" label="备注">
            <Input.TextArea rows={3} />
          </Form.Item>
        </Form>
      </Modal>
    </>
  );
}
