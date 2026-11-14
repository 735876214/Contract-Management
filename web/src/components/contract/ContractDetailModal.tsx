import { useEffect, useState } from 'react';
import {
  Button,
  DatePicker,
  Descriptions,
  Form,
  Input,
  Modal,
  Space,
  Spin,
  Table,
  Tabs,
  Tag,
  message,
} from 'antd';
import { contractApi } from '@/api/business';
import DictSelect, { DictTag } from '@/components/DictSelect';
import { usePermission } from '@/hooks/usePermission';
import { useContainerWidth } from '@/hooks/useContainerWidth';

/**
 * 合同详情弹窗（只读 + 变更记录 + 新增补充协议向导）。
 *
 * 由原 `pages/Contracts.tsx` 的列表弹窗迁入（业务 2026-11-14 合并「合同台账」与「合同台账维护」）。
 * 列表页只管"打开哪一份"，取数与弹窗状态都在这里，避免列表再持有 detail/changes。
 */

const money = (v: number) => (v == null ? '-' : `¥${Number(v).toLocaleString('zh-CN', { maximumFractionDigits: 2 })}`);

export interface ContractDetailModalProps {
  /** 要查看的合同 id；为空时不发请求 */
  contractId?: string | null;
  open: boolean;
  onClose: () => void;
  /** 新增补充协议成功后的回调（列表需要重新取数） */
  onChanged?: () => void;
}

export default function ContractDetailModal({ contractId, open, onClose, onChanged }: ContractDetailModalProps) {
  const [detail, setDetail] = useState<any>(null);
  const [changes, setChanges] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);
  const [supOpen, setSupOpen] = useState(false);
  const [supForm] = Form.useForm();
  /** 写入口门禁：只读用户与已归档合同不得发起「新增补充协议」（后端仍有 `contract:edit` 403 兜底） */
  const canEdit = usePermission('contract:edit');
  const canWrite = canEdit && !!detail && !detail.archivedAt;

  useEffect(() => {
    if (!open || !contractId) {
      setDetail(null);
      setChanges([]);
      return;
    }
    let alive = true;
    setLoading(true);
    Promise.all([contractApi.detail(contractId), contractApi.changes(contractId)])
      .then(([d, ch]: any[]) => {
        if (!alive) return;
        setDetail(d);
        setChanges(ch || []);
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [open, contractId]);

  const openSupplement = async () => {
    if (!detail || !canWrite) return;
    const res: any = await contractApi.nextSupplementCode(detail.id);
    supForm.setFieldsValue({
      code: res.code,
      name: `${res.parentName}补充协议`,
      supplementTypeCode: undefined,
    });
    setSupOpen(true);
  };

  const createSupplement = async () => {
    if (!detail || !canWrite) return;
    const v = await supForm.validateFields();
    await contractApi.create({
      ...v,
      signDate: v.signDate ? v.signDate.format('YYYY-MM-DD') : null,
      isSupplement: 'Y',
      parentContractId: detail.id,
      typeCode: detail.typeCode,
      supplierId: detail.supplierId,
    });
    message.success('补充协议已创建');
    setSupOpen(false);
    supForm.resetFields();
    const res: any = await contractApi.detail(detail.id);
    setDetail(res);
    onChanged?.();
  };

  return (
    <>
      <Modal
        title="合同详情"
        width={720}
        centered
        open={open}
        onCancel={onClose}
        footer={null}
        styles={{ body: { maxHeight: 'calc(100vh - 220px)', overflowY: 'auto' } }}
      >
        {loading || !detail ? (
          <Spin />
        ) : (
          <>
            <Tabs
              items={[
                {
                  key: 'info',
                  label: '合同信息',
                  children: <ContractDetailInfo detail={detail} />,
                },
                {
                  key: 'changes',
                  label: `变更记录（${changes.length}）`,
                  children: (
                    <Table
                      scroll={{ x: 'max-content' }}
                      rowKey="id"
                      size="small"
                      dataSource={changes}
                      pagination={false}
                      columns={[
                        { title: '字段', dataIndex: 'fieldLabel' },
                        { title: '变更前', dataIndex: 'beforeValue' },
                        { title: '变更后', dataIndex: 'afterValue' },
                        // 窄容器收起次要列（见 styles/containers.css §2）
                        { title: '操作人', dataIndex: 'operator', className: 'col-secondary' },
                        { title: '时间', dataIndex: 'createdAt', className: 'col-secondary', render: (v) => v?.slice(0, 19).replace('T', ' ') },
                      ]}
                    />
                  ),
                },
              ]}
            />
            {detail.isSupplement !== 'Y' && (
              <div style={{ marginTop: 16 }}>
                <Space wrap>
                  {detail.supplements?.map((s: any) => (
                    <Tag key={s.id} color="blue">{s.code}</Tag>
                  ))}
                </Space>
                {canEdit && (
                  <Button
                    type="primary"
                    size="small"
                    style={{ marginLeft: 8 }}
                    disabled={!!detail.archivedAt}
                    title={detail.archivedAt ? '合同已归档，不能新增补充协议' : undefined}
                    onClick={openSupplement}
                  >
                    新增补充协议
                  </Button>
                )}
              </div>
            )}
          </>
        )}
      </Modal>

      {/* 新增补充协议：详情弹窗内发起的向导型动作（创建草稿），保留弹窗形态（业务 2026-10-17） */}
      <Modal
        title="新增补充协议"
        open={supOpen}
        onOk={createSupplement}
        onCancel={() => setSupOpen(false)}
        destroyOnHidden
      >
        <Form form={supForm} layout="vertical">
          <Form.Item name="code" label="补充协议编号（自动生成，可微调）" rules={[{ required: true }]}>
            <Input />
          </Form.Item>
          <Form.Item name="name" label="协议名称" rules={[{ required: true }]}><Input /></Form.Item>
          <Form.Item name="supplementTypeCode" label="补充协议类型" rules={[{ required: true, message: '请选择补充协议类型' }]}>
            <DictSelect typeCode="supplement_agreement_type" />
          </Form.Item>
          <Form.Item name="signDate" label="签订日期"><DatePicker format="YYYY-MM-DD" style={{ width: '100%' }} /></Form.Item>
          <Form.Item name="remark" label="备注"><Input.TextArea rows={2} /></Form.Item>
        </Form>
      </Modal>
    </>
  );
}

/** 合同详情弹窗正文：列数按弹窗容器宽度降级（DESIGN.md §10.2） */
function ContractDetailInfo({ detail }: { detail: any }) {
  const { ref, size } = useContainerWidth<HTMLDivElement>();
  return (
    <div ref={ref} className="cq">
      <Descriptions column={size.isNarrow ? 1 : 2} size="small" bordered>
        <Descriptions.Item label="合同编号">{detail.code}</Descriptions.Item>
        <Descriptions.Item label="合同名称">{detail.name}</Descriptions.Item>
        <Descriptions.Item label="合同类型"><DictTag typeCode="contract_type" value={detail.typeCode} /></Descriptions.Item>
        <Descriptions.Item label="合同子类型"><DictTag typeCode="contract_sub_type" value={detail.subTypeCode} /></Descriptions.Item>
        {detail.codeAbbrUsed && <Descriptions.Item label="编号项目简称">{detail.codeAbbrUsed}</Descriptions.Item>}
        {detail.parentContractId && (
          <Descriptions.Item label="父合同" span={size.isNarrow ? 1 : 2}>
            {detail.parentContract ? `${detail.parentContract.code} ${detail.parentContract.name}` : '-'}
          </Descriptions.Item>
        )}
        <Descriptions.Item label="供应商">{detail.supplier?.name || '-'}</Descriptions.Item>
        <Descriptions.Item label="法人">{detail.supplier?.legalPerson || '-'}</Descriptions.Item>
        <Descriptions.Item label="授权人">{detail.supplier?.contractAuthPerson || '-'}</Descriptions.Item>
        <Descriptions.Item label="联系人">{detail.supplier?.contactName || '-'}</Descriptions.Item>
        <Descriptions.Item label="联系人电话">{detail.supplier?.contactPhone || '-'}</Descriptions.Item>
        <Descriptions.Item label="合同额">{money(detail.amount)}</Descriptions.Item>
        <Descriptions.Item label="税率">{detail.taxRate != null ? `${(Number(detail.taxRate) * 100).toFixed(2)}%` : '-'}</Descriptions.Item>
        <Descriptions.Item label="签订日期">{detail.signDate?.slice(0, 10)}</Descriptions.Item>
        <Descriptions.Item label="执行情况"><DictTag typeCode="contract_execution_status" value={detail.execStatus} /></Descriptions.Item>
        <Descriptions.Item label="备注" span={size.isNarrow ? 1 : 2}>{detail.remark || '-'}</Descriptions.Item>
        {detail.attachments?.length ? (
          <Descriptions.Item label="附件" span={size.isNarrow ? 1 : 2}>
            {detail.attachments.map((a: any) => (
              <Tag key={a.id}><a href={a.url} target="_blank" rel="noreferrer">{a.fileName}</a></Tag>
            ))}
          </Descriptions.Item>
        ) : null}
      </Descriptions>
    </div>
  );
}
