import { useCallback, useEffect, useState } from 'react';
import { Alert, Button, Descriptions, Form, InputNumber, Modal, Select, Space, Tag } from 'antd';
import { message } from '@/utils/antdStatic';
import { SettingOutlined } from '@ant-design/icons';
import { financeApi } from '@/api/modules';
import { PAYMENT_MODE_OPTIONS, CUSTOM_PAYMENT_MODE } from '@/constants/paymentModes';

/**
 * 合同资金参数条（保理费用台账 / 逾期利息台账**共用**）。
 *
 * 为什么抽出来：拆分前这两张表在同一个页面的两个 Tab 里，合同资金参数是页面级的；
 * 拆成两个独立模块后两边都要有，复制一份必然漂移（改一处忘另一处）。
 *
 * 放在哪里：**编辑器里**（新增/编辑记录的表单上方），不再放列表页表头 ——
 * 参数是录入时的上下文，选完合同即可核对或当场调整（2026-11-20 调整）。
 *
 * 自己按 `contractId` 取数（`GET /finance/contract-params/:id`），不依赖调用方传参。
 */
export default function ContractFundParams({
  contractId,
  variant = 'card',
  hidePaymentMode = false,
}: {
  contractId: string;
  /**
   * `card`：带边框的独立参数条（列表页表头用过的款式）。
   * `inline`：编辑器里的单行浅色说明（供应商 · 付款模式 · 利率 · 宽限期 + 参数设置），
   * 不再单独占一块卡片，避免录入表单里出现「第二个表头」。
   */
  variant?: 'card' | 'inline';
  /** 页面里已经有「付款模式」选择框时（逾期台账）不再重复显示合同默认付款模式 */
  hidePaymentMode?: boolean;
}) {
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

  const modeLabel = PAYMENT_MODE_OPTIONS.find((o) => o.value === params.paymentMode)?.label ?? '自定义';
  const modal = (
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
  );

  if (variant === 'inline') {
    // 编辑器用：一行浅色说明，不占卡片、不另起标题，跟录入表单连成一片
    return (
      <>
        <div
          style={{
            display: 'flex',
            flexWrap: 'wrap',
            alignItems: 'center',
            gap: 16,
            marginBottom: 16,
            padding: '6px 12px',
            borderRadius: 6,
            background: 'var(--cms-surface-soft)',
            color: 'var(--cms-muted)',
            fontSize: 13,
          }}
        >
          <span style={{ whiteSpace: 'nowrap' }}>供应商：{params.supplierName || '-'}</span>
          {!hidePaymentMode && <span style={{ whiteSpace: 'nowrap' }}>付款模式：{modeLabel}</span>}
          <span style={{ whiteSpace: 'nowrap' }}>{`延期月利率：${(params.monthlyRate * 100).toFixed(2)}%`}</span>
          <span style={{ whiteSpace: 'nowrap' }}>{`宽限期：${params.graceDays} 天`}</span>
          <Button size="small" type="link" icon={<SettingOutlined />} onClick={openModal} style={{ padding: 0 }}>
            参数设置
          </Button>
        </div>
        {modal}
      </>
    );
  }

  return (
    <div className="page-card" style={{ marginBottom: 16 }}>
      {/* 窄容器（手机/窄窗口）按 1 列堆叠：固定 4 列会把「供应商」等标签挤成竖排文字 */}
      <Descriptions
        size="small"
        column={{ xs: 1, sm: 1, md: 2, lg: 4, xl: 4, xxl: 4 }}
        bordered
        labelStyle={{ whiteSpace: 'nowrap' }}
      >
        <Descriptions.Item label="供应商">{params.supplierName || '-'}</Descriptions.Item>
        <Descriptions.Item label="付款模式">
          {/* 付款模式描述较长：窄容器下要能换行，否则会把标签/卡片挤破 */}
          <Space wrap size={4}>
            <Tag color="blue" style={{ whiteSpace: 'normal', height: 'auto', lineHeight: 1.4 }}>
              {modeLabel}
            </Tag>
            <Button size="small" type="link" icon={<SettingOutlined />} onClick={openModal}>
              参数设置
            </Button>
          </Space>
        </Descriptions.Item>
        {/* 数值项不许折行：编辑器里（容器比原列表页窄）会把「0.60%」「7 天」断成两行 */}
        <Descriptions.Item label="延期月利率">
          <span style={{ whiteSpace: 'nowrap' }}>{`${(params.monthlyRate * 100).toFixed(2)}%`}</span>
        </Descriptions.Item>
        <Descriptions.Item label="宽限期">
          <span style={{ whiteSpace: 'nowrap' }}>{`${params.graceDays} 天`}</span>
        </Descriptions.Item>
      </Descriptions>
      {modal}
    </div>
  );
}
