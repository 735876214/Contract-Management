import { Card, Result } from 'antd';
import { ToolOutlined } from '@ant-design/icons';

/** 采购管理子模块占位页（批次二起逐个实现） */
export default function ProcurementPlaceholder({ title }: { title: string }) {
  return (
    <Card title={title}>
      <Result
        icon={<ToolOutlined style={{ color: '#bfbfbf' }} />}
        title="待开发"
        subTitle={`${title}模块正在建设中，敬请期待`}
      />
    </Card>
  );
}
