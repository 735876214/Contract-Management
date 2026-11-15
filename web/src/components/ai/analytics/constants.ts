/** 经营数据助手前端共享文案/常量（GeneratePanel 与 HistoryPanel 共用，避免两份漂移） */
export const SCOPE_LABEL: Record<string, string> = {
  current: '当前项目',
  selected: '多选项目',
  all: '全部项目',
};

export const COMPARE_LABEL: Record<string, string> = {
  none: '不对比',
  mom: '环比',
  yoy: '同比',
};

/** 后端未返回上限时的兜底（真实值以 GET /ai/analytics/datasets 的 maxDatasets 为准） */
export const DEFAULT_MAX_DATASETS = 8;
