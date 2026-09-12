/**
 * 采购任务工作流常量（批次二 · 任务 2.1）
 * 与后端 procurement-task.service.ts 的阶段链 / 状态定义保持一致。
 */

export type ProcurementTaskType = 'FRAMEWORK' | 'SINGLE';

export const PROCUREMENT_TASK_TYPES: { value: ProcurementTaskType; label: string }[] = [
  { value: 'FRAMEWORK', label: '引用框架协议' },
  { value: 'SINGLE', label: '单项采购' },
];

export const taskTypeLabel = (t: string): string =>
  PROCUREMENT_TASK_TYPES.find((x) => x.value === t)?.label ?? t;

/** 工作流状态 → 展示名 */
export const TASK_STATUS_LABELS: Record<string, string> = {
  NOT_STARTED: '未发起',
  LIST_EDITING: '总清单编制中',
  PRE_MEETING_EDITING: '采前会纪要编制中',
  NOTICE_EDITING: '采购公告编制中',
  DOCUMENT_EDITING: '采购文件编制中',
  RESULT_EDITING: '成交报告编制中',
  PRICE_COMPARE_EDITING: '价格对比表编制中',
  FRAMEWORK_EDITING: '事前报告编制中',
  CONTRACT_EDITING: '合同编制中',
  CONTRACT_APPROVING: '合同审批中',
  COMPLETED: '已完成',
};

export const taskStatusLabel = (s: string): string => TASK_STATUS_LABELS[s] ?? s;

/** 状态 → 标签颜色 */
export const TASK_STATUS_COLORS: Record<string, string> = {
  NOT_STARTED: 'default',
  LIST_EDITING: 'orange',
  PRE_MEETING_EDITING: 'blue',
  NOTICE_EDITING: 'blue',
  DOCUMENT_EDITING: 'blue',
  RESULT_EDITING: 'blue',
  PRICE_COMPARE_EDITING: 'blue',
  FRAMEWORK_EDITING: 'blue',
  CONTRACT_EDITING: 'purple',
  CONTRACT_APPROVING: 'gold',
  COMPLETED: 'green',
};

/** 合同阶段状态（发布全部阶段后进入） */
export const CONTRACT_STAGE_STATUSES = ['CONTRACT_EDITING', 'CONTRACT_APPROVING', 'COMPLETED'];

/** 可编辑基本信息的状态（未发起 / 总清单编制中） */
export const BASIC_EDITABLE_STATUSES = ['NOT_STARTED', 'LIST_EDITING'];

/** 可执行「发布」的状态 = 处于某阶段编制中（未进入合同阶段） */
export const canPublish = (status: string): boolean =>
  !!TASK_STATUS_LABELS[status] && !CONTRACT_STAGE_STATUSES.includes(status) && status !== 'NOT_STARTED';

/** 当前阶段是否允许编辑/发布子任务（前置约束：前一任务未发布时后续禁用，由后端 flow stages 给出权威状态） */
export interface FlowStage {
  key: string;
  label: string;
  state: 'done' | 'editing' | 'locked';
}

/** 与后端一致的阶段链（列表页本地展示兜底；详情以接口 stages 为准） */
export function buildStageChain(type: string, preMeetingRequired: boolean): FlowStage[] {
  const mk = (key: string, label: string): FlowStage => ({ key, label, state: 'locked' });
  const chain: FlowStage[] = [mk('TOTAL_LIST', '编制总采购清单')];
  if (type === 'SINGLE' && preMeetingRequired) chain.push(mk('PRE_MEETING', '采前会会议纪要'));
  if (type === 'FRAMEWORK') {
    chain.push(mk('FRAMEWORK_EXPLAIN', '框架协议事前说明'));
  } else {
    chain.push(
      mk('NOTICE', '采购公告'),
      // 任务 3.4：采购文件紧随采购公告
      mk('DOCUMENT', '采购文件'),
      // 任务 3.5：成交报告紧随采购文件（入口条件即「采购文件已完成」）
      mk('RESULT_REPORT', '成交报告'),
      // 任务 3.6：采购价格对比表紧随成交报告（入口条件即「成交报告已完成」）
      mk('PRICE_COMPARE', '采购价格对比表'),
    );
  }
  chain.push(mk('CONTRACT', '生成合同'));
  return chain;
}
