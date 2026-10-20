import { useMemo, useState } from 'react';
import {
  Alert,
  Button,
  Card,
  Checkbox,
  Collapse,
  Empty,
  Input,
  Space,
  Spin,
  Table,
  Tag,
  Tooltip,
  Typography,
  Upload,
  message,
} from 'antd';
import { FileAddOutlined, InboxOutlined, SaveOutlined } from '@ant-design/icons';
import { aiApi, type AiRegisterField, type AiRegisterParseResult } from '@/api/modules';

const { Dragger } = Upload;
const { Text, Paragraph } = Typography;

/**
 * AI 助手 · 文件登记（二期）。
 *
 * 交互刻意做成「解析 → 逐项复核 → 确认才写库」三段：
 * 1. `register/parse` **只解析不落库**，返回每个字段的值、原文核对结果、交叉校验告警与明细；
 * 2. 所有值在页面上都可改，且**状态一眼可见**（已核对 / 待核对 / 缺失 / 格式不合法）；
 * 3. 点「确认登记」才调 `register/confirm` 写库，走既有的合同/供应商 create（编号唯一、重名复用）。
 *
 * 之所以不做「上传即入库」：抽取准确率再高也是概率事件，错一个账号或金额就是台账脏数据，
 * 而且这类错误事后极难发现——宁可让人多点两下。
 */
export default function AiRegisterPanel() {
  const [parsing, setParsing] = useState(false);
  const [result, setResult] = useState<AiRegisterParseResult | null>(null);
  const [values, setValues] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [done, setDone] = useState<{
    contractId: string;
    code: string;
    name: string;
    materialCount?: number;
    materialBaseCreated?: number;
    materialSkipped?: number;
    materialMerged?: number;
  } | null>(null);
  /** 明细是否随登记一起写库（默认写：用户要的就是「登记完明细也在」） */
  const [writeMaterials, setWriteMaterials] = useState(true);

  const parse = async (file: File) => {
    setParsing(true);
    setResult(null);
    setDone(null);
    try {
      const res = await aiApi.registerParse(file);
      setResult(res);
      const next: Record<string, string> = {};
      for (const f of res.draft.fields) if (f.value) next[f.key] = f.value;
      setValues(next);
      if (!res.aiEnabled) message.warning(res.aiMessage || 'AI 未配置，无法自动识别');
      else message.success(`已识别 ${Object.keys(next).length} 个字段，请逐项核对后确认登记`);
    } catch {
      // http 拦截器已弹错
    } finally {
      setParsing(false);
    }
  };

  const onPick = (f: File) => {
    if (!/\.(docx|xlsx)$/i.test(f.name)) {
      message.error('只支持 .docx / .xlsx（.doc 与 PDF 请先另存为 docx）');
      return false;
    }
    void parse(f);
    return false;
  };

  const missing = useMemo(() => {
    const base = result?.draft.fields.filter((f) => f.required) || [];
    return base.filter((f) => !String(values[f.key] ?? '').trim()).map((f) => f.label);
  }, [result, values]);

  const columns = [
    {
      title: '分组',
      dataIndex: 'group',
      width: 90,
      render: (g: string) => <Text type="secondary">{g === 'supplier' ? '供货方' : '合同'}</Text>,
    },
    {
      title: '字段',
      dataIndex: 'label',
      width: 150,
      render: (label: string, row: AiRegisterField) => (
        <Space size={4}>
          <span>{label}</span>
          {row.required ? <Text type="danger">*</Text> : null}
        </Space>
      ),
    },
    {
      title: '识别值（可修改）',
      dataIndex: 'value',
      render: (_: unknown, row: AiRegisterField) => (
        <Input
          value={values[row.key] ?? ''}
          placeholder={row.required ? '必填' : '未识别'}
          status={row.required && !String(values[row.key] ?? '').trim() ? 'error' : undefined}
          onChange={(e) => setValues((prev) => ({ ...prev, [row.key]: e.target.value }))}
        />
      ),
    },
    {
      title: '核对',
      dataIndex: 'verified',
      width: 150,
      render: (_: unknown, row: AiRegisterField) => {
        const v = String(values[row.key] ?? '').trim();
        if (!v) return row.required ? <Tag color="red">必填缺失</Tag> : <Text type="secondary">-</Text>;
        if (row.warn === 'invalid') return <Tag color="orange">格式需确认</Tag>;
        if (row.warn === 'cross-check') return <Tag color="orange">对账不平</Tag>;
        if (!row.verified) return <Tag color="gold">原文未匹配</Tag>;
        return <Tag color="green">原文已核对</Tag>;
      },
    },
    {
      title: '说明',
      dataIndex: 'note',
      render: (note?: string) => (note ? <Text type="secondary">{note}</Text> : <Text type="secondary">-</Text>),
    },
  ];

  const confirm = async () => {
    if (!result) return;
    if (missing.length) {
      message.error(`还有必填项没填：${missing.join('、')}`);
      return;
    }
    const supplier: Record<string, string> = {};
    const contract: Record<string, string> = {};
    for (const f of result.draft.fields) {
      const v = String(values[f.key] ?? '').trim();
      if (!v) continue;
      const [, key] = f.key.split('.');
      (f.group === 'supplier' ? supplier : contract)[key] = v;
    }
    setSaving(true);
    try {
      const res = await aiApi.registerConfirm({
        supplier,
        contract,
        skipSupplier: !supplier.name,
        items: writeMaterials ? (result.draft.items as unknown as Record<string, unknown>[]) : undefined,
        writeMaterials,
      });
      setDone(res);
      message.success(
        `已登记：${res.code}${res.supplierId ? '（含供应商）' : ''}${res.materialCount ? `，明细 ${res.materialCount} 行` : ''}`,
      );
    } catch {
      // 拦截器已弹错
    } finally {
      setSaving(false);
    }
  };

  const items = result?.draft.items || [];

  return (
    <Card
      title={
        <Space>
          <FileAddOutlined />
          <span>AI 助手 · 文件登记</span>
          {result?.model ? <Tag color="green">已启用 {result.model}</Tag> : null}
        </Space>
      }
      extra={
        <Button
          type="primary"
          icon={<SaveOutlined />}
          loading={saving}
          disabled={!result || !result.aiEnabled || !!done}
          onClick={confirm}
        >
          确认登记
        </Button>
      }
    >
      <Alert
        type="info"
        showIcon
        style={{ marginBottom: 12 }}
        message="上传合同文件 → 自动识别供货方与合同要素 → 逐项核对后写入系统"
        description="识别结果只做建议：提交前每一项都可改，缺失的必填项会被拦下。系统按「合同编号唯一、供应商同名复用」登记。"
      />

      {!result && (
        <Dragger accept=".docx,.xlsx" maxCount={1} beforeUpload={onPick} showUploadList={false} disabled={parsing}>
          <p className="ant-upload-drag-icon">
            <InboxOutlined />
          </p>
          <p className="ant-upload-text">点击或拖拽合同文件到此区域</p>
          <p className="ant-upload-hint">支持 .docx / .xlsx；解析需要 10~30 秒（走模型）</p>
        </Dragger>
      )}

      {parsing && (
        <div style={{ padding: 40, textAlign: 'center' }}>
          <Spin tip="正在解析合同并核对字段…" size="large">
            <div style={{ height: 60 }} />
          </Spin>
        </div>
      )}

      {!parsing && result && (
        <>
          <Paragraph type="secondary" style={{ marginTop: 12 }}>
            文件：{result.fileName}
            {`　正文 ${result.chars} 字`}
            {result.truncated ? '（已截断）' : ''}
            {`　明细 ${result.items} 项`}
            {result.draft.itemsTotal !== null ? `，合计 ${result.draft.itemsTotal}` : ''}
            <Button type="link" size="small" onClick={() => setResult(null)}>
              换一个文件
            </Button>
          </Paragraph>

          {!result.aiEnabled && (
            <Alert type="warning" showIcon style={{ marginBottom: 12 }} message="AI 未启用" description={result.aiMessage} />
          )}

          {result.draft.warnings.length > 0 && (
            <Alert
              type="warning"
              showIcon
              style={{ marginBottom: 12 }}
              message="以下情况需要人工确认"
              description={
                <ul style={{ margin: 0, paddingLeft: 18 }}>
                  {result.draft.warnings.map((w) => (
                    <li key={w}>{w}</li>
                  ))}
                </ul>
              }
            />
          )}

          {done && (
            <Alert
              type="success"
              showIcon
              style={{ marginBottom: 12 }}
              message={`已登记合同 ${done.code}（${done.name}）`}
              description={
                done.materialCount
                  ? `已写入物资明细 ${done.materialCount} 行${done.materialBaseCreated ? `（其中 ${done.materialBaseCreated} 条物资主数据为本次新建）` : ''}${done.materialMerged ? `，${done.materialMerged} 行因名称与规格重复已合并（数量与金额相加）` : ''}${done.materialSkipped ? `，${done.materialSkipped} 行因缺名称被跳过` : ''}。可以到「合同管理」里继续补付款安排、条款与附件。`
                  : '可以到「合同管理」里继续补付款安排、条款与附件。'
              }
            />
          )}

          <Table
            rowKey="key"
            dataSource={result.draft.fields}
            columns={columns as any}
            pagination={false}
            size="small"
            scroll={{ x: 900 }}
            locale={{ emptyText: <Empty description="没有识别到字段" /> }}
          />

          {items.length > 0 && (
            <Collapse
              style={{ marginTop: 16 }}
              items={[
                {
                  key: 'items',
                  label: `识别到 ${items.length} 行明细（合计 ${result.draft.itemsTotal ?? '-'}）`,
                  children: (
                    <>
                      <Alert
                        type={writeMaterials ? 'success' : 'info'}
                        showIcon
                        style={{ marginBottom: 8 }}
                        message={
                          <Checkbox checked={writeMaterials} onChange={(e) => setWriteMaterials(e.target.checked)}>
                            登记时把明细写入「合同物资明细」
                          </Checkbox>
                        }
                        description="勾选后按「名称 + 规格」匹配物资基础库，匹配不到会自动新建一条物资主数据（备注标注来源），再把每行挂到合同物资明细上；不勾选则明细只用于核对金额。"
                      />
                      <Table
                        rowKey={(_, i) => String(i)}
                        dataSource={items}
                        size="small"
                        pagination={false}
                        columns={[
                          { title: '名称', dataIndex: 'name' },
                          { title: '规格', dataIndex: 'spec' },
                          { title: '单位', dataIndex: 'unit', width: 70 },
                          { title: '数量', dataIndex: 'qty', width: 80 },
                          { title: '含税单价', dataIndex: 'unitPriceWithTax', width: 110 },
                          { title: '含税合价', dataIndex: 'amountWithTax', width: 110 },
                          { title: '备注', dataIndex: 'remark' },
                        ]}
                      />
                    </>
                  ),
                },
              ]}
            />
          )}

          <Paragraph type="secondary" style={{ marginTop: 12 }}>
            <Tooltip title="核对口径：金额去千分位后在原文里查、日期按中文写法反查、文本去空白后子串匹配">
              <Text type="secondary">「原文已核对」= 该值确实出现在文件正文里；「原文未匹配」= 可能由模型推断，请重点看。</Text>
            </Tooltip>
          </Paragraph>
        </>
      )}
    </Card>
  );
}
