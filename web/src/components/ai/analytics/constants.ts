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

/**
 * 期间预设与报告类型的下拉文案。
 * 取值集合必须与后端 `AI_PERIOD_PRESETS` / `AI_REPORT_KINDS` 完全一致，
 * 由 `server/test/aiAnalyticsOptionsParity.spec.mts` 锁定（本文件不依赖 `@/` 别名，spec 可直接加载）。
 */
export const PRESET_OPTIONS: Array<{ value: string; label: string }> = [
  { value: 'this_month', label: '本月' },
  { value: 'last_month', label: '上月' },
  { value: 'this_quarter', label: '本季度' },
  { value: 'this_year', label: '今年' },
  { value: 'ytd', label: '年初至今' },
  { value: 'last_30_days', label: '近 30 天' },
  { value: 'last_90_days', label: '近 90 天' },
  { value: 'all', label: '累计至今' },
  { value: 'custom', label: '自定义' },
];

export const KIND_OPTIONS: Array<{ value: string; label: string }> = [
  { value: 'monthly', label: '月度经营简报' },
  { value: 'brief', label: '领导简报' },
  { value: 'project', label: '项目履约简报' },
  { value: 'comparison', label: '对比简报' },
  { value: 'custom', label: '经营数据报告' },
];
