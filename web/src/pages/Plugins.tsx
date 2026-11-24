import { useEffect, useState } from 'react';
import { Alert, Card, Space, Table, Tag, Typography } from 'antd';
import { AppstoreOutlined } from '@ant-design/icons';
import http from '@/api/http';

const { Title, Text, Paragraph } = Typography;

interface PluginRow {
  key: string;
  displayName: string;
  description: string;
  version: string;
  author: string;
  enabled: boolean;
  enabledByDefault: boolean;
  disabledBy: 'manifest' | 'env' | 'dependency' | null;
  blockedBy: string | null;
  dependencies: string[];
  permissions: { code: string; name: string; group: string }[];
  menus: { key: string; label: string; path: string; parent?: string }[];
  mcpTools: { name: string; description: string }[];
  apiPrefix: string;
  nestModule: string;
  webEntry: string;
}

/** 禁用原因的展示口径：运维看到「为什么没生效」比看到「未启用」重要得多 */
function disabledReason(row: PluginRow): string {
  if (row.disabledBy === 'dependency') return row.blockedBy || '依赖不满足';
  if (row.disabledBy === 'env') return '由环境变量 CMS_PLUGINS_DISABLED 关闭';
  if (row.disabledBy === 'manifest') return 'plugin.json 的 enabledByDefault=false';
  return '';
}

/**
 * 系统管理 → 插件管理（构建期插件 / B 档，**只读**）。
 *
 * 页面只做两件事：证明「哪些插件被装配进来了」，以及「没生效的那个为什么没生效」。
 * 刻意不提供启停按钮——构建期插件的启停需要重启，给它一个看起来很能热切的开关只会制造误判。
 */
export default function PluginsPage() {
  const [data, setData] = useState<any>(null);
  const [error, setError] = useState<string>('');

  useEffect(() => {
    http
      .get<any, any>('system/plugins')
      .then((res: any) => setData(res))
      .catch((e: any) => setError(e?.message || '加载失败'));
  }, []);

  const rows: PluginRow[] = data?.plugins || [];

  const columns = [
    {
      title: '插件',
      dataIndex: 'displayName',
      key: 'displayName',
      render: (_: any, row: PluginRow) => (
        <Space direction="vertical" size={0}>
          <Text strong>{row.displayName}</Text>
          <Text type="secondary" style={{ fontSize: 12 }}>
            {row.key} · v{row.version} · {row.author}
          </Text>
        </Space>
      ),
    },
    {
      title: '状态',
      dataIndex: 'enabled',
      key: 'enabled',
      width: 220,
      render: (_: any, row: PluginRow) =>
        row.enabled ? (
          <Tag color="green">已启用</Tag>
        ) : (
          <Space direction="vertical" size={0}>
            <Tag color="red">未启用</Tag>
            <Text type="secondary" style={{ fontSize: 12 }}>
              {disabledReason(row)}
            </Text>
          </Space>
        ),
    },
    {
      title: '装配',
      key: 'assembly',
      render: (_: any, row: PluginRow) => (
        <Space direction="vertical" size={0}>
          <Text style={{ fontSize: 12 }}>模块 {row.nestModule}</Text>
          <Text style={{ fontSize: 12 }}>接口 /api/{row.apiPrefix}</Text>
          <Text style={{ fontSize: 12 }}>页面 {row.webEntry}</Text>
        </Space>
      ),
    },
    {
      title: '权限码 / 菜单',
      key: 'perm',
      render: (_: any, row: PluginRow) => (
        <Space direction="vertical" size={2}>
          <span>
            {row.permissions.map((p) => (
              <Tag key={p.code}>{p.code}</Tag>
            ))}
          </span>
          <span>
            {row.menus.map((m) => (
              <Tag key={m.key} color="blue">{m.path}</Tag>
            ))}
          </span>
        </Space>
      ),
    },
    {
      title: '依赖',
      dataIndex: 'dependencies',
      key: 'dependencies',
      width: 160,
      render: (deps: string[]) => (deps.length ? deps.map((d) => <Tag key={d}>{d}</Tag>) : <Text type="secondary">—</Text>),
    },
    {
      title: 'MCP 工具',
      dataIndex: 'mcpTools',
      key: 'mcpTools',
      width: 160,
      render: (tools: { name: string }[]) =>
        tools.length ? (
          <Space size={2} wrap>
            {tools.map((t) => (
              <Tag key={t.name}>{t.name}</Tag>
            ))}
          </Space>
        ) : (
          <Text type="secondary">—</Text>
        ),
    },
  ];

  return (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      <div>
        <Title level={4} style={{ marginBottom: 4 }}>
          <AppstoreOutlined /> 插件管理
        </Title>
        <Text type="secondary">
          构建期插件（B 档）：插件 = 清单（plugin.json）+ 后端模块 + 前端页面 + 菜单 + 权限码，
          全部在**构建期**装配，因此与手写代码一样受 5 个静态门禁与漂移锁保护。
        </Text>
      </div>

      <Alert
        type="info"
        showIcon
        message="启停方式"
        description={
          <span>
            本页只读。裁剪模块：在部署环境设置
            {' '}
            <Text code>CMS_PLUGINS_DISABLED=插件名1,插件名2</Text>
            {' '}
            后重启后端。构建期插件没有热切换语义，所以不提供「一键禁用」按钮——
            那会造成「点了但没生效」的误判（详见
            {' '}
            <Text code>server/src/plugins/README.md</Text>）。
          </span>
        }
      />

      {error ? <Alert type="error" showIcon message={error} /> : null}

      {data && data.unknownEnvKeys?.length ? (
        <Alert
          type="warning"
          showIcon
          message="环境变量里有未声明的插件名"
          description={`CMS_PLUGINS_DISABLED 中的 ${data.unknownEnvKeys.join('、')} 不存在，可能是拼写错误（不会报错，但也不会有任何效果）。`}
        />
      ) : null}

      <Card
        title={`已声明插件（核心版本 ${data?.coreVersion || '—'}）`}
        loading={!data && !error}
        styles={{ body: { padding: data ? 0 : 24 } }}
      >
        {data ? (
          <Table<PluginRow>
            rowKey="key"
            size="small"
            pagination={false}
            columns={columns as any}
            dataSource={rows}
          />
        ) : null}
      </Card>

      <Card title="目录约定" size="small">
        <Paragraph style={{ marginBottom: 0 }} type="secondary">
          新增插件：复制
          {' '}
          <Text code>server/src/plugins/dev-example/</Text>
          {' '}
          与
          {' '}
          <Text code>web/src/plugins/dev-example/</Text>
          {' '}
          改名 → 改 plugin.json → 运行
          {' '}
          <Text code>node scripts/gen-plugins.mjs</Text>
          {' '}
          → 两个 build + npm test 必过。漏跑生成器会被
          {' '}
          <Text code>pluginCatalog.spec.mts</Text>
          {' '}
          拦住。
        </Paragraph>
      </Card>
    </Space>
  );
}
