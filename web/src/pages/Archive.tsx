import { useEffect, useState } from 'react';
import { Card, Table, Button, Space, Spin, Tree } from 'antd';
import { DownloadOutlined } from '@ant-design/icons';
import { withToken } from '../utils/download';
import { archiveApi } from '@/api/modules';

/**
 * 项目资料归档（附件需求 2026-10-17）：按需求目录树一键打包 ZIP 或按目录下载。
 *
 * 目录结构 = 业务确认的 13 类（`server/src/constants/archiveCategories.ts` 的镜像）；
 * 文件数来自 `GET /archive/entries`；空目录在 ZIP 里有 `_说明.txt` 占位（目录看得见）。
 * 命名口径：真实附件按业务字段重命名、图片转单页 PDF、台账 Excel 实时导出（见 archive-naming.ts）。
 */
export default function Archive() {
  const [data, setData] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [detailKey, setDetailKey] = useState<string | null>(null);
  const [detail, setDetail] = useState<any[] | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);

  const load = () => {
    setLoading(true);
    archiveApi
      .entries()
      .then((res: any) => setData(res))
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    load();
  }, []);

  const groups: any[] = data?.groups ?? [];

  const treeData = groups.map((g) => ({
    key: g.key,
    title: (
      <Space size={8}>
        <span>{g.dir}</span>
        <span className="cms-hint">{g.count} 个文件</span>
      </Space>
    ),
    children: [
      {
        key: `${g.key}::items`,
        title: (
          <Space size={8} wrap>
            <Button
              size="small"
              type="link"
              icon={<DownloadOutlined />}
              style={{ padding: 0 }}
              onClick={(e: any) => {
                e?.stopPropagation?.();
                window.open(withToken(archiveApi.downloadUrl(g.key)));
              }}
            >
              下载本目录（ZIP）
            </Button>
            <Button
              size="small"
              type="link"
              style={{ padding: 0 }}
              onClick={(e: any) => {
                e?.stopPropagation?.();
                setDetailKey(g.key);
                setDetailLoading(true);
                // entries 已带明细（items）；直接取
                const hit = groups.find((x) => x.key === g.key);
                setDetail(hit?.items ?? []);
                setDetailLoading(false);
              }}
            >
              查看文件清单
            </Button>
            {g.count === 0 && (
              <span className="cms-hint">该目录由「{g.sourceModule}」提供数据，当前暂无文件</span>
            )}
          </Space>
        ),
        selectable: false,
      },
    ],
  }));

  const detailItems = detailKey ? (groups.find((g) => g.key === detailKey)?.items ?? []) : null;

  return (
    <Card
      title="项目资料归档"
      extra={
        <Button
          type="primary"
          icon={<DownloadOutlined />}
          loading={loading}
          onClick={() => window.open(withToken(archiveApi.downloadUrl('all')))}
        >
          一键下载全部（ZIP）
        </Button>
      }
    >
      {loading ? (
        <Spin style={{ display: 'block', margin: '60px auto' }} />
      ) : (
        <>
          <div className="cms-hint" style={{ marginBottom: 12 }}>
            共 {data?.total ?? 0} 个文件 · 目录结构与需求归档格式一致（项目简称/业务类型/附件名称.扩展名）；
            台账 Excel 为导出时的最新数据，扫描件图片自动转为 PDF。
          </div>
          <Tree
            treeData={treeData}
            defaultExpandParent
            blockNode
            style={{ background: 'transparent' }}
          />
          {detailKey && (
            <Table
              style={{ marginTop: 16 }}
              size="small"
              rowKey="zipPath"
              loading={detailLoading}
              dataSource={detailItems ?? []}
              pagination={{ pageSize: 10, showTotal: (t) => `共 ${t} 个文件` }}
              columns={[
                { title: '目录', dataIndex: 'zipPath', width: 420, ellipsis: true },
                { title: '文件名', dataIndex: 'fileName', ellipsis: true },
              ]}
              locale={{ emptyText: '该目录暂无文件' }}
            />
          )}
        </>
      )}
    </Card>
  );
}
