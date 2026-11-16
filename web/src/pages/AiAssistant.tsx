import { Tabs } from 'antd';
import AiFormFillPanel from '@/components/ai/AiFormFillPanel';
import AiRegisterPanel from './AiRegisterPanel';
import AiReportPanel from './AiReportPanel';

export default function AiAssistant() {
  return (
    <Tabs
      defaultActiveKey="fill"
      items={[
        { key: 'fill', label: '模板智能填报', children: <AiFormFillPanel /> },
        { key: 'register', label: '文件登记', children: <AiRegisterPanel /> },
        { key: 'report', label: '汇报材料', children: <AiReportPanel /> },
      ]}
    />
  );
}
