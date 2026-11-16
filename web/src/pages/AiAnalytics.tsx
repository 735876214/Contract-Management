import { useEffect, useState } from 'react';
import { Card, Space, Tabs, Typography } from 'antd';
import { RobotOutlined } from '@ant-design/icons';
import { aiApi, type AiAnalyticsDatasetMeta } from '@/api/modules';
import { projectApi } from '@/api/business';
import GeneratePanel from '@/components/ai/analytics/GeneratePanel';
import HistoryPanel from '@/components/ai/analytics/HistoryPanel';

const { Title, Text } = Typography;

/**
 * AI 经营数据助手（`/ai/analytics`）：范围/期间/数据集 → 意图 → 确定性报告；历史可按需重新导出。
 *
 * 数据面覆盖按业务模块登记的数据集（注册表由后端下发，未实现与无权限的不会出现）。
 * 本页只读：生成报告仅写 AI 留痕表，不改任何业务单据。
 */
export default function AiAnalyticsPage() {
  const [datasets, setDatasets] = useState<AiAnalyticsDatasetMeta[]>([]);
  const [defaultKeys, setDefaultKeys] = useState<string[]>([]);
  const [crossProjectAllowed, setCrossProjectAllowed] = useState(false);
  const [maxDatasets, setMaxDatasets] = useState(8);
  const [projects, setProjects] = useState<Array<{ id: string; code: string; name: string }>>([]);
  const [loading, setLoading] = useState(true);
  const [refreshKey, setRefreshKey] = useState(0);

  useEffect(() => {
    Promise.all([
      aiApi.analyticsDatasets(),
      projectApi.list({ page: 1, pageSize: 200 }).catch(() => ({ list: [] })),
    ])
      .then(([ds, projectRes]: any[]) => {
        setDatasets(ds?.datasets || []);
        setDefaultKeys(ds?.defaultKeys || []);
        setCrossProjectAllowed(!!ds?.crossProjectAllowed);
        if (Number(ds?.maxDatasets) > 0) setMaxDatasets(Number(ds.maxDatasets));
        const list = projectRes?.list || projectRes?.items || projectRes || [];
        setProjects(
          (Array.isArray(list) ? list : []).map((p: any) => ({
            id: p.id,
            code: p.code || '',
            name: p.name || '',
          })),
        );
      })
      .catch(() => {
        setDatasets([]);
      })
      .finally(() => setLoading(false));
  }, []);

  return (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      <div>
        <Title level={4} style={{ marginBottom: 4 }}>
          <RobotOutlined /> 经营数据助手
        </Title>
        <Text type="secondary">
          按需选择范围、期间与数据集，生成可导出的经营分析报告；数字由程序计算，报告落库保留历史（仅本人可见，超管可看全部）。
        </Text>
      </div>

      <Card loading={loading} styles={{ body: { padding: loading ? 24 : 0 } }}>
        {!loading && (
          <Tabs
            defaultActiveKey="generate"
            items={[
              {
                key: 'generate',
                label: '生成',
                children: (
                  <div style={{ paddingTop: 8 }}>
                    <GeneratePanel
                      datasets={datasets}
                      defaultKeys={defaultKeys}
                      projects={projects}
                      crossProjectAllowed={crossProjectAllowed}
                      maxDatasets={maxDatasets}
                      onSaved={() => setRefreshKey((k) => k + 1)}
                    />
                  </div>
                ),
              },
              {
                key: 'history',
                label: '历史',
                children: (
                  <div style={{ paddingTop: 8 }}>
                    <HistoryPanel projects={projects} refreshKey={refreshKey} />
                  </div>
                ),
              },
            ]}
          />
        )}
      </Card>
    </Space>
  );
}
