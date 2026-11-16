import { useCallback, useEffect, useState } from 'react';
import { Alert, Button, Descriptions, Form, InputNumber, Modal, Select, Space, Tag, message } from 'antd';
import { SettingOutlined } from '@ant-design/icons';
import { financeApi } from '@/api/modules';
import { PAYMENT_MODE_OPTIONS, CUSTOM_PAYMENT_MODE } from '@/constants/paymentModes';

/**
 * 合同资金参数条（保理费用台账 / 逾期利息台账**共用**）。
 *
 * 为什么抽出来：拆分前这两张表在同一个页面的两个 Tab 里，合同资金参数是页面级的；
 * 拆成两个独立模块后两边都要有，复制一份必然漂移（改一处忘另一处）。
 *
 * 自己按 `contractId` 取数（`GET /finance/contract-params/:id`），不依赖调用方传参。
 */
export default function ContractFundParams({ contractId }: { contractId: string }) {
  const [params, setParams] = useState<any>(null);
  const [modalOpen, setModalOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [form] = Form.useForm();

  const load = useCallback(() => {
    if (!contractId) {
      setParams(null);
      return;
    }
    financeApi
      .contractParams(contractId)
      .then((res: any) => setParams(res))
      .catch(() => setParams(null));
  }, [contractId]);

  useEffect(() => {
    load();
  }, [load]);

  if (!params) return null;

  const openModal = () => {
    form.setFieldsValue({
      paymentMode: params.overrides?.paymentMode || params.paymentMode,
      monthlyRate: params.overrides?.monthlyRate ?? params.monthlyRate,
      graceDays: params.overrides?.graceDays ?? params.graceDays,
      interestCapRatio: params.overrides?.interestCapRatio ?? params.interestCapRatio,
    });
    setModalOpen(true);
  };

  const submit = async () => {
    const values = await form.validateFields();
    setSaving(true);
    try {
      await financeApi.saveContractParams(contractId, {
        paymentMode: values.paymentMode,
        monthlyRate: values.monthlyRate ?? null,
        graceDays: values.graceDays ?? null,
        interestCapRatio: values.interestCapRatio ?? null,
      });
      message.success('合同资金参数已保存');
      setModalOpen(false);
      load();
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="page-card" style={{ marginBottom: 16 }}>
      <Descriptions size="small" column={4} bordered>
        <Descriptions.Item label="供应商">{params.supplierName || '-'}</Descriptions.Item>
        <Descriptions.Item label="付款模式">
          <Space>
            <Tag color="blue">
              {PAYMENT_MODE_OPTIONS.find((o) => o.value === params.paymentMode)?.label ?? '自定义'}
            </Tag>
            <Button size="small" type="link" icon={<SettingOutlined />} onClick={openModal}>
              参数设置
            </Button>
          </Space>
        </Descriptions.Item>
        <Descriptions.Item label="延期月利率">{`${(params.monthlyRate * 100).toFixed(2)}%`}</Descriptions.Item>
        <Descriptions.Item label="宽限期">{`${params.graceDays} 天`}</Descriptions.Item>
      </Descriptions>

      <Modal
        title="合同资金参数（覆盖系统默认值）"
        open={modalOpen}
        onOk={submit}
        onCancel={() => setModalOpen(false)}
        confirmLoading={saving}
        destroyOnHidden
      >
        <Form form={form} layout="vertical">
          <Form.Item name="paymentMode" label="付款模式" rules={[{ required: true }]}>
            <Select
              options={PAYMENT_MODE_OPTIONS.map((o) => ({
                value: o.value,
                // 100 / 3382 沿用后端返回的描述（可被系统参数改写），其余用镜像常量里的说明
                label:
                  o.value === '100'
                    ? `100% 模式：${params?.mode100Description || o.label}`
                    : o.value === '3382'
                      ? `3382 模式：${params?.mode3382Description || o.label}`
                      : o.value === CUSTOM_PAYMENT_MODE
                        ? '自定义（手动录入应付款行）'
                        : o.label,
              }))}
            />
          </Form.Item>
          <Space size={16} style={{ display: 'flex' }}>
            <Form.Item name="monthlyRate" label="延期月利率" tooltip="如 0.006 表示 0.6%，以合同条款为准">
              <InputNumber style={{ width: 160 }} min={0} max={1} step={0.0001} />
            </Form.Item>
            <Form.Item name="graceDays" label="逾期宽限天数">
              <InputNumber style={{ width: 160 }} min={0} precision={0} />
            </Form.Item>
            <Form.Item name="interestCapRatio" label="逾期利息上限比例" tooltip="如 0.05 表示材料款合计的 5%">
              <InputNumber style={{ width: 160 }} min={0} max={1} step={0.01} />
            </Form.Item>
          </Space>
          <Alert type="warning" showIcon message="留空的字段将回落到系统参数默认值（系统管理 → 系统参数中的 finance.overdue 组）。" />
        </Form>
      </Modal>
    </div>
  );
}
