import { useEffect, useState } from 'react';
import { Alert, Card, Descriptions, Space, Spin, Tag, Typography } from 'antd';
import http from '@/api/http';

const { Title, Text, Paragraph } = Typography;

/**
 * 插件页面（示例）。
 *
 * 约定：插件自己放在 `web/src/plugins/<key>/index.tsx` 并 **default export**，
 * 由 `scripts/gen-plugins.mjs` 注入到 `web/src/router.tsx` 的 `<plugin-lazy>` / `<plugin-routes>`
 * 标记块里。路由守卫使用 `plugin.json` 声明的权限码（生成进 `ROUTE_PERMISSIONS`）。
 *
 * 本页数据全部来自后端 `GET /api/plugin/dev-example/summary`——即插件模块自己算出来的
 * 运行期事实。页面里不再抄一份版本号/菜单路径，否则清单与实现立刻会各说一套。
 */
export default function DevExamplePluginPage() {
  const [data, setData] = useState<any>(null);
  const [error, setError] = useState<string>('');

  useEffect(() => {
    http
      .get<any, any>('plugin/dev-example/summary')
      .then((res: any) => setData(res))
      .catch((e: any) => setError(e?.message || '加载失败'));
  }, []);

  const runtime = data?.runtime;

  return (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      <div>
        <Title level={4} style={{ marginBottom: 4 }}>
          插件开发示例
        </Title>
        <Text type="secondary">
          这是构建期插件（B 档）的最小可跑示例：后端模块 + 前端页面 + 菜单 + 权限码，全部由
          {' '}
          <Text code>server/src/plugins/dev-example/plugin.json</Text>
          {' '}
          声明后生成装配。照这个目录抄一份改名即可起步（见
          {' '}
          <Text code>server/src/plugins/README.md</Text>）。
        </Text>
      </div>

      <Card title="插件实际装配情况" loading={!data && !error}>
        {error ? (
          <Alert type="error" showIcon message={error} />
        ) : runtime ? (
          <Descriptions column={1} size="small" bordered>
            <Descriptions.Item label="标识">{runtime.key}</Descriptions.Item>
            <Descriptions.Item label="版本">{runtime.version}</Descriptions.Item>
            <Descriptions.Item label="作者">{runtime.author}</Descriptions.Item>
            <Descriptions.Item label="启用状态">
              {runtime.enabled ? <Tag color="green">已启用</Tag> : <Tag color="red">已禁用</Tag>}
            </Descriptions.Item>
            <Descriptions.Item label="后端模块">{runtime.nestModule}</Descriptions.Item>
            <Descriptions.Item label="接口前缀">{runtime.apiPrefix}</Descriptions.Item>
            <Descriptions.Item label="权限码">
              {runtime.permissions.map((p: any) => (
                <Tag key={p.code}>{p.code}</Tag>
              ))}
            </Descriptions.Item>
            <Descriptions.Item label="菜单">
              {runtime.menus.map((m: any) => (
                <div key={m.key}>
                  <Tag>{m.parent || '顶层'}</Tag>
                  {m.label} → {m.path}
                </div>
              ))}
            </Descriptions.Item>
            <Descriptions.Item label="服务端响应时间">{data?.servedAt}</Descriptions.Item>
          </Descriptions>
        ) : (
          <Spin />
        )}
      </Card>

      <Card title="为什么是构建期装配，而不是上传 zip 热插拔">
        <Paragraph>
          本仓的数据库是 Prisma 单 schema 单 Client，插件加表必须改 schema + 生成 + 迁移，
          运行时不可能完成；加上 5 个静态门禁检查器与 4 个漂移锁 spec，运行时加载的代码拿不到任何一项保护。
          所以这里只保留插件**语义**（清单、版本、依赖、权限前缀、菜单所有权、启停、审计），
          去掉**形态**（运行时 importlib / 独立 MetaData / zip 热装）。
        </Paragraph>
        <Paragraph type="secondary" style={{ marginBottom: 0 }}>
          禁用方式：环境变量 CMS_PLUGINS_DISABLED=dev-example 后重启后端（构建期插件没有热切换的回滚语义）。
        </Paragraph>
      </Card>
    </Space>
  );
}
