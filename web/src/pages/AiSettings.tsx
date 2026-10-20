import { useEffect, useState } from 'react';
import { Alert, Button, Card, Divider, Form, Input, Space, Switch, Tag, Typography, message } from 'antd';
import { ApiOutlined, ExperimentOutlined, SaveOutlined, ThunderboltOutlined } from '@ant-design/icons';
import { aiApi, type AiSettingInput, type AiSettingTestResult, type AiSettingView } from '../api/modules';

const { Paragraph, Text } = Typography;

/**
 * 来源标签：让管理员一眼看出「现在生效的是页面填的，还是 docker 里的环境变量」。
 * 只在**确实来自某处**（页面/环境变量）时才显示——default/
one 没有信息量，
 * 挤在 label 后面会读成「接口地址默认值」，误导人以为有个默认地址可用。
 */
const SOURCE_LABEL: Record<string, string> = {
  db: '页面登记',
  env: '环境变量',
};
const SOURCE_COLOR: Record<string, string> = {
  db: 'green',
  env: 'blue',
  default: 'default',
  none: 'red',
};

/**
 * AI 信息登记（系统管理 → AI 信息登记，2026-10-20）。
 *
 * 这是**全站共用的上游配置**：这里保存一次，AI 助手（扫描 / 文件登记 / 汇报材料）立刻可用，
 * 不需要改 docker-compose 的环境变量、也不需要重启服务。
 *
 * 两条安全口径：
 * 1. **密钥只写不读**：接口永不回显明文，页面只能说「已保存」，要换就整把替换；
 * 2. 留空 = 不修改：密钥框是密码框且不回填，所以「空着保存」不能把已存的密钥清掉，
 *    清除要显式点「清除密钥」。
 */
export default function AiSettings() {
  const [view, setView] = useState<AiSettingView | null>(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<AiSettingTestResult | null>(null);
  const [form] = Form.useForm();

  const load = async () => {
    setLoading(true);
    try {
      const v = await aiApi.getSetting();
      setView(v);
      form.setFieldsValue({ enabled: v.enabled, baseUrl: v.baseUrl, model: v.model, apiKey: '' });
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
    // 只在首次进入时拉一次；保存后手动 reload
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** 保存/测试前的字段校验：地址写成 `api.deepseek.com`（缺协议）是最常见的错法，先拦住 */
  const validate = async () => {
    try {
      await form.validateFields();
      return true;
    } catch {
      return false; // antd 已在字段下方标红，不用再弹一次
    }
  };

  /** 表单 → 接口入参：密钥留空就不带这个字段（= 不修改） */
  const collect = (): AiSettingInput => {
    const v = form.getFieldsValue();
    const body: AiSettingInput = {
      enabled: Boolean(v.enabled),
      baseUrl: String(v.baseUrl ?? '').trim(),
      model: String(v.model ?? '').trim(),
    };
    const key = String(v.apiKey ?? '').trim();
    if (key) body.apiKey = key;
    return body;
  };

  const save = async () => {
    if (!(await validate())) return;
    setSaving(true);
    try {
      const next = await aiApi.saveSetting(collect());
      setView(next);
      form.setFieldValue('apiKey', '');
      setTestResult(null);
      message.success('已保存，AI 功能立即生效');
    } finally {
      setSaving(false);
    }
  };

  const test = async () => {
    if (!(await validate())) return;
    setTesting(true);
    setTestResult(null);
    try {
      // 用**页面上当前的值**测（还没保存也能先验证），省得存错一次再改
      const r = await aiApi.testSetting(collect());
      setTestResult(r);
    } finally {
      setTesting(false);
    }
  };

  const clearKey = async () => {
    setSaving(true);
    try {
      const next = await aiApi.saveSetting({ apiKey: '' });
      setView(next);
      setTestResult(null);
      message.success('已清除页面登记的密钥（若环境变量里配过，会回落到环境变量）');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      {view && (
        <Alert
          type={view.enabled ? 'success' : 'warning'}
          showIcon
          message={
            <Space size={8} wrap>
              <span>{view.enabled ? 'AI 已启用' : 'AI 未启用'}</span>
              {view.model ? <Tag color="blue">{view.model}</Tag> : null}
              {view.envConfigured && view.source.apiKey === 'env' ? (
                <Tag color="blue">当前有部分项取自环境变量</Tag>
              ) : null}
            </Space>
          }
          description={view.hint}
        />
      )}

      <Card
        title={
          <Space>
            <ThunderboltOutlined />
            AI 服务登记
          </Space>
        }
        loading={loading}
        extra={
          <Space>
            <Button icon={<ExperimentOutlined />} loading={testing} onClick={test}>
              测试连接
            </Button>
            <Button type="primary" icon={<SaveOutlined />} loading={saving} onClick={save}>
              保存
            </Button>
          </Space>
        }
      >
        <Form form={form} layout="vertical" initialValues={{ enabled: false }}>
          <Form.Item
            name="enabled"
            label="启用 AI 功能"
            valuePropName="checked"
            extra="关闭后全站 AI 入口保留但调用会被拦下，不会产生费用"
          >
            <Switch checkedChildren="启用" unCheckedChildren="停用" />
          </Form.Item>

          <Form.Item
            name="baseUrl"
            rules={[
              {
                validator: (_, v) =>
                  !String(v ?? '').trim() || /^https?:\/\/\S+$/i.test(String(v).trim())
                    ? Promise.resolve()
                    : Promise.reject(new Error('要填 http:// 或 https:// 开头的完整地址')),
              },
            ]}
            label={
              <Space size={6}>
                接口地址
                {view && SOURCE_LABEL[view.source.baseUrl] ? <Tag color={SOURCE_COLOR[view.source.baseUrl]}>{SOURCE_LABEL[view.source.baseUrl]}</Tag> : null}
              </Space>
            }
            extra="OpenAI 兼容协议的站点地址，带不带 /v1 都行。例：https://api.deepseek.com"
          >
            <Input placeholder="https://api.deepseek.com" allowClear prefix={<ApiOutlined />} />
          </Form.Item>

          <Form.Item
            name="model"
            label={
              <Space size={6}>
                模型名
                {view && SOURCE_LABEL[view.source.model] ? <Tag color={SOURCE_COLOR[view.source.model]}>{SOURCE_LABEL[view.source.model]}</Tag> : null}
              </Space>
            }
            extra="例：deepseek-chat / qwen-plus / llama3.1（写上游文档里的模型标识，不是显示名）"
          >
            <Input placeholder="deepseek-chat" allowClear />
          </Form.Item>

          <Form.Item
            name="apiKey"
            label={
              <Space size={6}>
                API Key
                {view && SOURCE_LABEL[view.source.apiKey] ? <Tag color={SOURCE_COLOR[view.source.apiKey]}>{SOURCE_LABEL[view.source.apiKey]}</Tag> : null}
              </Space>
            }
            extra={
              <Space size={8} wrap>
                <Text type="secondary">
                  {view?.apiKeySaved ? '已保存过密钥（不回显，留空表示不修改）' : '还没有保存过密钥'}
                </Text>
                {view?.source.apiKey === 'db' ? (
                  <Button size="small" danger type="link" onClick={clearKey} disabled={saving}>
                    清除密钥
                  </Button>
                ) : null}
              </Space>
            }
          >
            <Input.Password placeholder={view?.apiKeySaved ? '留空 = 不修改' : '粘贴上游的 API Key'} autoComplete="new-password" />
          </Form.Item>
        </Form>

        <Divider style={{ margin: '8px 0 16px' }} />

        {testResult ? (
          <Alert
            type={testResult.ok ? 'success' : 'error'}
            showIcon
            message={
              testResult.ok
                ? `连接成功${testResult.ms ? `（${testResult.ms} ms）` : ''}${testResult.model ? ` · ${testResult.model}` : ''}`
                : '连接失败'
            }
            description={
              testResult.ok
                ? '上游已按这份配置返回内容，可以放心保存。'
                : `${testResult.message}${testResult.ms ? `（耗时 ${testResult.ms} ms）` : ''}`
            }
          />
        ) : (
          <Paragraph type="secondary" style={{ margin: 0 }}>
            保存后可用「测试连接」真打一次上游：能立刻查出密钥是否有效、模型名是否写错、服务器能不能访问外网。
            页面上的值**没保存也能先测**。
          </Paragraph>
        )}
      </Card>

      {view?.envConfigured ? (
        <Alert
          type="info"
          showIcon
          message="环境变量里也有一份配置"
          description="页面登记的值优先于环境变量；把某一项清空并保存，就会回落到环境变量里的旧值。"
        />
      ) : null}
    </Space>
  );
}


