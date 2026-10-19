import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Alert,
  Button,
  Card,
  Empty,
  Select,
  Space,
  Spin,
  Table,
  Tag,
  Tooltip,
  Typography,
  Upload,
  message,
} from 'antd';
import { DownloadOutlined, InboxOutlined, ReloadOutlined, ThunderboltOutlined } from '@ant-design/icons';
import { aiApi, type AiInspectCandidate, type AiInspectResult } from '@/api/modules';
import { contractApi, supplierApi } from '@/api/business';

const { Dragger } = Upload;
const { Text, Paragraph } = Typography;

interface Option {
  id: string;
  name?: string;
  code?: string;
}

/** 单元格唯一键：同一份表里可能有多张工作表，必须带 sheet 才不会串行 */
const keyOf = (c: { sheet: string; cellRef: string }) => `${c.sheet}!${c.cellRef}`;

/**
 * AI 助手（一期：模板智能填报）。
 *
 * 交互刻意做成「先看建议、再手动改、最后才生成文件」三步：
 * 1. 上传 xlsx → 后端扫描出所有「标签: 空格子」候选位置，并让模型给出字段建议；
 * 2. 用户逐行确认/修改字段（模型只做建议，不做决定）；
 * 3. 生成回填文件下载 —— **系统里的数据一个字段都不会写回本页**，
 *    页面上只显示「有值/无值」，避免把合同金额、银行账号等敏感信息直接摊在浏览器与操作日志里。
 */
export default function AiAssistant() {
  const [status, setStatus] = useState<{ enabled: boolean; model: string } | null>(null);
  const [contracts, setContracts] = useState<Option[]>([]);
  const [suppliers, setSuppliers] = useState<Option[]>([]);
  const [contractId, setContractId] = useState<string>();
  const [supplierId, setSupplierId] = useState<string>();

  const [file, setFile] = useState<File | null>(null);
  const [inspecting, setInspecting] = useState(false);
  const [result, setResult] = useState<AiInspectResult | null>(null);
  const [picked, setPicked] = useState<Record<string, string | undefined>>({});
  const [filling, setFilling] = useState(false);

  useEffect(() => {
    aiApi
      .status()
      .then(setStatus)
      .catch(() => setStatus({ enabled: false, model: '' }));
    contractApi.options().then((list: Option[]) => setContracts(list || [])).catch(() => undefined);
    supplierApi.options().then((list: Option[]) => setSuppliers(list || [])).catch(() => undefined);
  }, []);

  const fieldOptions = useMemo(
    () =>
      (result?.availableFields || []).map((f) => ({
        value: f.key,
        label: `${f.label}（${f.key}）`,
        sensitive: f.sensitive,
      })),
    [result],
  );

  /** 上传即扫描：省掉「上传 + 点扫描」两步，失败时保留文件方便重试 */
  const inspect = useCallback(
    async (f: File) => {
      setInspecting(true);
      setResult(null);
      setPicked({});
      try {
        const res = await aiApi.inspect(f, { contractId, supplierId });
        setResult(res);
        // 初始映射 = 模型建议（只采纳高置信度，低置信度留给用户判断）
        const initial: Record<string, string | undefined> = {};
        for (const c of res.candidates) {
          if (c.fieldKey && (c.confidence ?? 0) >= 0.6) initial[keyOf(c)] = c.fieldKey;
        }
        setPicked(initial);
        if (!res.candidates.length) message.warning('没找到可填的空白单元格，确认模板里是「标签 + 空值格」的布局');
        else message.success(`找到 ${res.candidates.length} 个候选位置`);
      } catch {
        // http 拦截器已弹错，这里只负责收尾
      } finally {
        setInspecting(false);
      }
    },
    [contractId, supplierId],
  );

  const onPick = (f: File) => {
    if (!/\.xlsx$/i.test(f.name)) {
      message.error('只支持 .xlsx（.xls / .xlsm 会丢格式或宏，请先另存为 xlsx）');
      return false;
    }
    setFile(f);
    void inspect(f);
    return false;
  };

  const mapped = useMemo(
    () =>
      Object.entries(picked)
        .filter(([, fieldKey]) => !!fieldKey)
        .map(([k, fieldKey]) => {
          const [sheet, cellRef] = k.split('!');
          return { sheet, cellRef, fieldKey: fieldKey as string };
        }),
    [picked],
  );

  const fill = async () => {
    if (!file) return;
    if (!mapped.length) {
      message.warning('还没有选择任何字段');
      return;
    }
    setFilling(true);
    try {
      const res = await aiApi.fill(file, mapped, { contractId, supplierId });
      const blob = res.data as Blob;
      const filled = Number(res.headers?.['x-ai-filled'] ?? 0);
      const skipped = Number(res.headers?.['x-ai-skipped'] ?? 0);
      const fileName = decodeURIComponent(
        String(res.headers?.['content-disposition'] || '').replace(/^.*filename\*=UTF-8''/, '') ||
          'ai-filled.xlsx',
      );
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = fileName;
      a.click();
      URL.revokeObjectURL(url);
      message.success(`已回填 ${filled} 处${skipped ? `，跳过 ${skipped} 处（公式/合并格）` : ''}`);
    } catch {
      // 拦截器已提示
    } finally {
      setFilling(false);
    }
  };

  const columns = [
    { title: '工作表', dataIndex: 'sheet', width: 140, ellipsis: true },
    { title: '单元格', dataIndex: 'cellRef', width: 90 },
    {
      title: '表单标签',
      dataIndex: 'label',
      width: 220,
      ellipsis: true,
      render: (v: string) => (
        <Tooltip title={v}>
          <Text>{v || '-'}</Text>
        </Tooltip>
      ),
    },
    {
      title: '当前',
      dataIndex: 'hasValue',
      width: 80,
      render: (v: boolean) => (v ? <Tag color="orange">已有值</Tag> : <Tag>空白</Tag>),
    },
    {
      title: '取系统字段',
      width: 280,
      render: (_: unknown, row: AiInspectCandidate) => (
        <Select
          allowClear
          showSearch
          style={{ width: '100%' }}
          placeholder="选择要填入的字段"
          value={picked[keyOf(row)]}
          onChange={(v?: string) => setPicked((prev) => ({ ...prev, [keyOf(row)]: v }))}
          optionFilterProp="label"
          options={fieldOptions}
        />
      ),
    },
    {
      title: '置信度',
      width: 100,
      render: (_: unknown, row: AiInspectCandidate) => {
        const c = row.confidence;
        if (c === null || c === undefined) return <Text type="secondary">-</Text>;
        const color = c >= 0.8 ? 'green' : c >= 0.6 ? 'blue' : 'default';
        return <Tag color={color}>{Math.round(c * 100)}%</Tag>;
      },
    },
  ];

  const disabled = status ? !status.enabled : false;

  return (
    <Card
      title={
        <Space>
          <ThunderboltOutlined />
          <span>AI 助手 · 模板智能填报</span>
          {status?.enabled ? <Tag color="green">已启用 {status.model}</Tag> : <Tag>未启用</Tag>}
        </Space>
      }
      extra={
        <Space>
          <Button icon={<ReloadOutlined />} disabled={!file || disabled} onClick={() => file && inspect(file)}>
            重新扫描
          </Button>
          <Button
            type="primary"
            icon={<DownloadOutlined />}
            loading={filling}
            disabled={!file || !mapped.length || disabled}
            onClick={fill}
          >
            生成回填文件（{mapped.length}）
          </Button>
        </Space>
      }
    >
      <Alert
        type="info"
        showIcon
        style={{ marginBottom: 12 }}
        message="一期能力：上传 Excel 表单 → 识别空白字段 → 自动取系统里的项目/合同/供应商/统计数据填入 → 下载回填后的文件"
        description="系统里的数据只会写进你下载的文件，不会在页面上展示金额、账号等敏感值；请下载后自行核对再提交。"
      />
      {disabled && (
        <Alert
          type="warning"
          showIcon
          style={{ marginBottom: 12 }}
          message="AI 未启用"
          description="服务端缺少 AI 配置（AI_BASE_URL / AI_API_KEY / AI_MODEL）。配置后重启后端即可使用；未启用时仍可手动按模板填写。"
        />
      )}

      <Space wrap style={{ marginBottom: 12 }}>
        <Select
          allowClear
          showSearch
          optionFilterProp="label"
          style={{ width: 320 }}
          placeholder="关联合同（可选，决定能用哪些合同字段）"
          value={contractId}
          onChange={setContractId}
          options={contracts.map((c) => ({ value: c.id, label: `${c.code} ${c.name}` }))}
        />
        <Select
          allowClear
          showSearch
          optionFilterProp="label"
          style={{ width: 260 }}
          placeholder="关联供应商（可选）"
          value={supplierId}
          onChange={setSupplierId}
          options={suppliers.map((s) => ({ value: s.id, label: s.name || s.id }))}
        />
        <Text type="secondary">选好关联对象再上传，字段列表会随之变化</Text>
      </Space>

      {!file && (
        <Dragger accept=".xlsx" maxCount={1} beforeUpload={onPick} showUploadList={false} disabled={disabled}>
          <p className="ant-upload-drag-icon">
            <InboxOutlined />
          </p>
          <p className="ant-upload-text">点击或拖拽 Excel 表单到此区域</p>
          <p className="ant-upload-hint">仅支持 .xlsx；表单需是「标签在左、值在右」或「标签在上、值在下」的常规布局</p>
        </Dragger>
      )}

      {inspecting && (
        <div style={{ padding: 40, textAlign: 'center' }}>
          <Spin tip="正在识别表单结构并匹配字段…" size="large">
            <div style={{ height: 60 }} />
          </Spin>
        </div>
      )}

      {!inspecting && file && (
        <>
          <Paragraph type="secondary" style={{ marginTop: 12 }}>
            文件：{file.name}
            {result ? `　工作表：${result.sheetNames.join('、') || '-'}` : ''}
            {result && result.truncated > 0 ? `　（候选过多，已丢弃 ${result.truncated} 个，请精简表单后重试）` : ''}
          </Paragraph>
          {result && !result.aiEnabled && (
            <Alert
              type="info"
              showIcon
              style={{ marginBottom: 12 }}
              message="未启用 AI 建议，下面只按关键词规则匹配"
              description={result.aiMessage}
            />
          )}
          <Table
            rowKey={(r) => keyOf(r)}
            dataSource={result?.candidates || []}
            columns={columns as any}
            pagination={{ pageSize: 20, showSizeChanger: false }}
            locale={{ emptyText: <Empty description="没有找到可填的空白单元格" /> }}
            scroll={{ x: 980 }}
          />
        </>
      )}
    </Card>
  );
}
