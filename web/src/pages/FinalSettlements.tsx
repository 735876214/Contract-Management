import { useEffect, useMemo, useState } from 'react';
import { withToken } from '../utils/download';
import {
  Button,
  Form,
  Input,
  InputNumber,
  DatePicker,
  Select,
  Space,
  Modal,
  message,
  Table,
  Popconfirm,
  Tag,
  Upload,
  Divider,
  Typography,
} from 'antd';
import { PlusOutlined, UploadOutlined, ExportOutlined, DeleteOutlined, EditOutlined } from '@ant-design/icons';
import dayjs from 'dayjs';
import { finalSettlementApi } from '@/api/modules';
import { fileApi } from '@/api/auth';
import { contractApi } from '@/api/business';
import { DictTag } from '@/components/DictSelect';
import Can from '@/components/Can';

const money = (v: any) => (v == null ? '-' : `¥${Number(v).toLocaleString('zh-CN', { maximumFractionDigits: 2 })}`);
const num = (v: any) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

/** 明细编辑器的暂存行：settleMonth 存 'YYYY-MM'（DatePicker 用 dayjs） */
interface EditItem {
  key: string;
  id?: string;
  settleMonth: string;
  amount: number;
}

/**
 * 总结算单（结算及付款管理，业务口径 2026-10-16 / 2026-11 编辑化）。
 *
 * 流程：**生成**（抓取该合同全部月度结算 → 明细快照 + 合计）→ **编辑器核对/调整**（逐期月份/金额、审减金额，
 * 保存即重算合计）→ **上传附件**（附件到位即「已结算」，合同执行情况随之置「已完已结」、付款比例切 100%）
 * → 导出结算书（《物资结算书》CSCEC-SW-B40806，5 sheets，内置模板渲染，无需手工维护单据模板）。
 *
 * ⚠️ 只有「待上传附件」状态可编辑明细（上传附件后即为已确认快照）。月度结算事后被改不会自动回写总结算单。
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

  // —— 明细编辑器状态 ——
  const [editDoc, setEditDoc] = useState<any>(null);
  const [editItems, setEditItems] = useState<EditItem[]>([]);
  const [editReduce, setEditReduce] = useState<number>(0);
  const [saving, setSaving] = useState(false);

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

  const openEditor = (doc: any) => {
    const items: EditItem[] = (doc.items || []).map((it: any, i: number) => ({
      key: it.id || `new-${i}`,
      id: it.id,
      settleMonth: it.settleMonth || '',
      amount: num(it.amount),
    }));
    setEditDoc(doc);
    setEditItems(items);
    setEditReduce(num(doc.reduceAmount));
  };

  const doGenerate = async () => {
    // 只校验本弹窗的字段：两个弹窗共用一个 form 实例，不限定字段会把另一个弹窗的必填项也带上
    const v = await form.validateFields(['contractId']);
    const created: any = await finalSettlementApi.generate(v.contractId);
    message.success(`已生成总结算单 ${created?.code || ''}（${created?.items?.length || 0} 期月度结算），请核对/调整明细后保存`);
    setModal(false);
    form.resetFields();
    load();
    // 生成后直接进入编辑器：可逐期调整月份/金额、填写审减金额，保存即生效
    openEditor(created);
  };

  const updateItem = (key: string, patch: Partial<EditItem>) => {
    setEditItems((prev) => prev.map((it) => (it.key === key ? { ...it, ...patch } : it)));
  };
  const addRow = () => {
    setEditItems((prev) => [...prev, { key: `new-${Date.now()}-${prev.length}`, settleMonth: '', amount: 0 }]);
  };
  const removeRow = (key: string) => {
    setEditItems((prev) => prev.filter((it) => it.key !== key));
  };

  const editorTotal = useMemo(() => editItems.reduce((t, it) => t + num(it.amount), 0), [editItems]);
  const editorApproved = useMemo(() => editorTotal - num(editReduce), [editorTotal, editReduce]);

  const saveEditor = async () => {
    if (!editItems.length) {
      message.warning('至少保留一条结算明细');
      return;
    }
    for (let i = 0; i < editItems.length; i += 1) {
      if (!/^\d{4}-\d{2}$/.test(editItems[i].settleMonth)) {
        message.warning(`第 ${i + 1} 行请选择结算月份`);
        return;
      }
    }
    setSaving(true);
    try {
      await finalSettlementApi.updateItems(editDoc.id, {
        items: editItems.map((it) => ({ id: it.id, settleMonth: it.settleMonth, amount: num(it.amount) })),
        reduceAmount: num(editReduce),
        version: editDoc.version,
      });
      message.success('已保存：合计与审定金额已按明细重算');
      setEditDoc(null);
      load();
    } finally {
      setSaving(false);
    }
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

  const canEditItems = (row: any) => row.statusCode === 'PENDING_ATTACHMENT';

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
        <Can code="settlement:edit">
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
        </Can>
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
              // 表格必须声明 scroll（DESIGN.md §10.1 第 2 条）
              scroll={{ x: 480 }}
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
          { title: '审减金额', dataIndex: 'reduceAmount', width: 140, align: 'right', render: money },
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
            width: 340,
            fixed: 'right',
            render: (_v: any, row: any) => (
              <Space size={4} wrap>
                <Can code="settlement:edit">
                  <Button
                    type="link"
                    size="small"
                    icon={<EditOutlined />}
                    disabled={!canEditItems(row)}
                    onClick={() => openEditor(row)}
                  >
                    编辑明细
                  </Button>
                </Can>
                <Can code="settlement:edit">
                  <Upload
                    showUploadList={false}
                    accept=".pdf,.doc,.docx,.jpg,.jpeg,.png"
                    beforeUpload={(file) => uploadAttachment(row, file as File)}
                  >
                    <Button type="link" size="small" icon={<UploadOutlined />} loading={uploadingId === row.id}>
                      {row.attachmentUrl ? '重传附件' : '上传附件'}
                    </Button>
                  </Upload>
                </Can>
                <Button
                  type="link"
                  size="small"
                  icon={<ExportOutlined />}
                  onClick={() => window.open(withToken(finalSettlementApi.exportUrl(row.id)))}
                >
                  导出
                </Button>
                <Can code="settlement:edit">
                  <>
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
                  </>
                </Can>
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
            extra="将抓取该合同全部（非草稿）月度结算的月份与金额，落成总结算明细（快照）；一个合同只允许一张总结算单。生成后可在编辑器中调整明细与审减金额"
          >
            <Select showSearch allowClear optionFilterProp="label" placeholder="请选择合同" options={contractOptions} />
          </Form.Item>
        </Form>
      </Modal>

      {/* 明细编辑器：调整每期月份/金额 + 审减金额，保存即重算合计 */}
      <Modal
        title={`编辑总结算明细${editDoc?.code ? ` · ${editDoc.code}` : ''}`}
        open={!!editDoc}
        onOk={saveEditor}
        confirmLoading={saving}
        onCancel={() => setEditDoc(null)}
        width={720}
        destroyOnHidden
        okText="保存"
      >
        <Table
          rowKey="key"
          size="small"
          pagination={false}
          scroll={{ x: 560 }}
          dataSource={editItems}
          columns={[
            {
              title: '序号',
              width: 60,
              align: 'center',
              render: (_v: any, _r: any, index: number) => index + 1,
            },
            {
              title: '结算月份',
              width: 200,
              render: (_v: any, r: EditItem) => (
                <DatePicker
                  picker="month"
                  style={{ width: '100%' }}
                  placeholder="选择月份"
                  value={r.settleMonth && /^\d{4}-\d{2}$/.test(r.settleMonth) ? dayjs(`${r.settleMonth}-01`) : null}
                  onChange={(d) => updateItem(r.key, { settleMonth: d ? d.format('YYYY-MM') : '' })}
                />
              ),
            },
            {
              title: '结算金额(元)',
              width: 220,
              render: (_v: any, r: EditItem) => (
                <InputNumber
                  style={{ width: '100%' }}
                  precision={2}
                  value={r.amount}
                  onChange={(v) => updateItem(r.key, { amount: num(v) })}
                />
              ),
            },
            {
              title: '操作',
              width: 70,
              align: 'center',
              render: (_v: any, r: EditItem) => (
                <Button type="link" danger size="small" onClick={() => removeRow(r.key)}>
                  删除
                </Button>
              ),
            },
          ]}
          footer={() => (
            <Button type="dashed" block icon={<PlusOutlined />} onClick={addRow}>
              添加结算期
            </Button>
          )}
        />

        <Divider style={{ margin: '12px 0' }} />

        <Space direction="vertical" style={{ width: '100%' }} size={8}>
          <Space align="center" style={{ width: '100%', justifyContent: 'space-between' }}>
            <span>
              合计金额：<Typography.Text strong>{money(editorTotal)}</Typography.Text>
            </span>
            <Space align="center">
              <span>审减金额：</span>
              <InputNumber
                style={{ width: 180 }}
                precision={2}
                value={editReduce}
                onChange={(v) => setEditReduce(num(v))}
              />
            </Space>
          </Space>
          <span>
            审定金额（合计 − 审减）：<Typography.Text strong type="success">{money(editorApproved)}</Typography.Text>
          </span>
        </Space>
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
