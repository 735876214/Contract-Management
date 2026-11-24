import { Tabs } from 'antd';
import AiFormFillPanel from '@/components/ai/AiFormFillPanel';
import AiRegisterPanel from './AiRegisterPanel';
import AiReportPanel from './AiReportPanel';
import ChatPanel from '@/components/ai/chat/ChatPanel';

/**
 * AI 助手（`/ai/assistant`）。
 *
 * 四个 Tab 是**四种产出形态**，共用同一套地基（程序算数 + 模型组织语言 + 数字回查）：
 * - 模板智能填报：产物是填好的 Excel（不落库）；
 * - 文件登记：解析 → 人确认 → 写库（两阶段）；
 * - 汇报材料：公文式报告（多节 + 表格）；
 * - **问数**：一段回答（P3-A），同一套数字对账，对不上就整段作废退回事实汇总。
 */
export default function AiAssistant() {
  return (
    <Tabs
      defaultActiveKey="fill"
      items={[
        { key: 'fill', label: '模板智能填报', children: <AiFormFillPanel /> },
        { key: 'register', label: '文件登记', children: <AiRegisterPanel /> },
        { key: 'report', label: '汇报材料', children: <AiReportPanel /> },
        { key: 'chat', label: '问数', children: <ChatPanel /> },
      ]}
    />
  );
}
