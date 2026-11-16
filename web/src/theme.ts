import type { CSSProperties } from 'react';
import type { ThemeConfig } from 'antd';

/**
 * 视觉 token 的**唯一事实源**（DESIGN.md §1–§5）。
 *
 * 设计语言来源：项目外部设计文档「Claude.com 设计系统分析」——
 * 我方**只取 token 层**（暖奶油底 + 珊瑚主色 + 暖中性文字阶梯 + 深墨面 + hairline 分层 +
 * 圆角/间距阶梯 + "color-block first, shadow rare"），**不搬**营销页专属件
 * （hero band / pricing tier / connector tile / footer / 96px 段间距 / 64px 标题 / 摄影插画规范），
 * 也**不搬 Anthropic 的商标**（spike 标记与 "Claude" 字样属他人品牌资产，不进本产品）。
 *
 * 三条硬约定（改色前先读）：
 * 1. **色值只许出现在本文件与 [index.css](index.css) 的 `--cms-*` 变量里**——
 *    由 `server/test/themeTokens.spec.mts` 锁定，别在页面/组件里写死 `#xxxxxx`。
 * 2. 珊瑚 `primary`(#cc785c) 与白字对比度约 3.1:1：**够用于按钮大色块**，
 *    **不够做正文级小字** → 小字链接/强调文字用 `primaryActive`(#a9583e，≈5.2:1)，正文走灰阶阶梯。
 * 3. `TASK_STATUS_COLORS` 等常量里的 `blue/green/orange…` 是**字典语义名，不重命名**；
 *    换色在渲染层完成（本文件的 `TONES` + index.css 的 `.ant-tag-*` 覆盖），
 *    这样前后端镜像常量与既有漂移锁都不受影响。
 */

/* ---------------- 色板（文档 token → 本项目常量） ---------------- */

export const palette = {
  /** 主色：珊瑚（Anthropic 的招牌暖色；营销站用于 CTA 与 callout） */
  primary: '#cc785c',
  /** 主色按下/深一档：小字链接与强调文字用（对比度更稳） */
  primaryActive: '#a9583e',
  /** 主色禁用态（奶油化的灰） */
  primaryDisabled: '#e6dfd8',

  /** 页面底：暖奶油（**不是纯白**，这是整套视觉的根基） */
  canvas: '#faf9f5',
  /** 浅带底（分区块、次级容器） */
  surfaceSoft: '#f5f0e8',
  /** 内容卡底（比 canvas 深一档） */
  surfaceCard: '#efe9de',
  /** 最强奶油（选中态、强调带） */
  surfaceCreamStrong: '#e8e0d2',
  /** 深墨面（侧栏 + 顶栏；营销站里用于产品截图卡与页脚） */
  surfaceDark: '#181715',
  surfaceDarkElevated: '#252320',
  surfaceDarkSoft: '#1f1e1b',

  /** 分隔线：与奶油底同族的暖灰，靠"一级高度差"分层而不是画墨线 */
  hairline: '#e6dfd8',
  hairlineSoft: '#ebe6df',

  /** 文字阶梯 */
  ink: '#141413',
  bodyStrong: '#252523',
  body: '#3d3d3a',
  muted: '#6c6a64',
  mutedSoft: '#8e8b82',
  /** 深色面上的文字 */
  onPrimary: '#ffffff',
  onDark: '#faf9f5',
  onDarkSoft: '#a09d96',

  /** 语义色 */
  success: '#5db872',
  warning: '#d4a017',
  error: '#c64545',
  /** 信息 / 进行中（**取代原来"蓝 = 进行中"**） */
  accentTeal: '#5db8a6',
  /** 待处理 / 编辑中（暖琥珀，取代 gold/orange） */
  accentAmber: '#e8a55a',

  /**
   * **文档纸张**（合同正文/条款/委托书等「所见即所得」预览区的底色）。
   * 刻意**不随主题变**：预览的是要打印/导出的纸质文档，屏幕主题是奶油还是纯白都不该改变它。
   */
  paper: '#ffffff',
  /** 纸张内的表头底色（与 Word 导出模板保持一致，见 utils/docExport.ts） */
  paperHead: '#f2f2f2',
} as const;

/* ---------------- 字体 ---------------- */

/**
 * 字体声音分裂（文档的核心特征）：**衬线标题 400 字重 + 负字距** / humanist sans 正文。
 * - 衬线用 **Noto Serif SC 400**（自托管，中文全覆盖，按 unicode-range 分片）；
 * - 正文用 **Inter**（自托管，latin/latin-ext），中文回退到系统 humanist 黑体。
 * ⚠️ 衬线**只用于 UI 标题/区块标题/KPI 数字**，不用于表格数据与用户输入内容
 * （避免生僻字与数字对齐问题；字体文件位置与再生成方式见 DESIGN.md §4）。
 */
export const font = {
  serif: `'Noto Serif SC', 'Songti SC', 'SimSun', Georgia, serif`,
  sans: `Inter, -apple-system, BlinkMacSystemFont, 'Segoe UI', 'PingFang SC', 'Hiragino Sans GB', 'Microsoft YaHei', sans-serif`,
  mono: `'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, Consolas, monospace`,
} as const;

/** 衬线标题：字重恒为 400（文档明确「不用粗衬线」），字距按层级收 */
export type HeadingLevel = 'page' | 'section' | 'card' | 'kpi';

export const headingStyle = (level: HeadingLevel): CSSProperties => {
  const map: Record<HeadingLevel, CSSProperties> = {
    page: { fontFamily: font.serif, fontWeight: 400, fontSize: 24, lineHeight: 1.25, letterSpacing: '-0.4px' },
    section: { fontFamily: font.serif, fontWeight: 400, fontSize: 18, lineHeight: 1.3, letterSpacing: '-0.3px' },
    card: { fontFamily: font.serif, fontWeight: 400, fontSize: 16, lineHeight: 1.35, letterSpacing: '-0.2px' },
    kpi: { fontFamily: font.serif, fontWeight: 400, fontSize: 30, lineHeight: 1.15, letterSpacing: '-0.6px' },
  };
  return map[level];
};

/* ---------------- 尺度 ---------------- */

/** 圆角阶梯（文档 xs4 / sm6 / md8 / lg12 / xl16 / pill） */
export const radius = { xs: 4, sm: 6, md: 8, lg: 12, xl: 16, pill: 9999 } as const;

/** 间距阶梯（4px 基数）。后台取**紧凑端**，不搬营销页的 96px 段间距 / 32px 卡片内边距 */
export const space = { xxs: 4, xs: 8, sm: 12, md: 16, lg: 24, xl: 32, xxl: 48 } as const;

/** 内容卡内边距（后台密度：桌面 20 / 窄屏 12 / 手机 8，落点在 index.css） */
export const pageCardPadding = { desktop: 20, tablet: 12, mobile: 8 } as const;

/* ---------------- 语义标签色（渲染层换色的唯一入口） ---------------- */

/**
 * AntD 的 `color` 预置名（字典 `dict_item.color` 里存的就是这些）→ 本项目语义色。
 * `fg`/`bg`/`border` 三件套都按"暖色系 + 小字可读"挑选（fg 对 bg 对比度 ≥ 4.5:1）。
 */
export const TONES = {
  neutral: { bg: '#f5f0e8', fg: '#3d3d3a', border: '#e6dfd8' },
  teal: { bg: '#e7f4f1', fg: '#2c6f61', border: '#cbe7e0' },
  amber: { bg: '#fbf1e0', fg: '#7d5a0e', border: '#f0dfc2' },
  success: { bg: '#e8f4ea', fg: '#2c6b41', border: '#cde6d4' },
  error: { bg: '#fbeae9', fg: '#9c3232', border: '#f0cfcc' },
  coral: { bg: '#f9ece7', fg: '#a9583e', border: '#efd8cf' },
  dark: { bg: '#252320', fg: '#faf9f5', border: '#252320' },
} as const;

export type ToneKey = keyof typeof TONES;
export type Tone = (typeof TONES)[ToneKey];

/** AntD 预置色名 → 语义色 key。字典与 `TASK_STATUS_COLORS` 里的名字**保持不变**，只在这里映射 */
export const PRESET_TONE_MAP: Record<string, ToneKey> = {
  default: 'neutral',
  blue: 'teal',
  cyan: 'teal',
  geekblue: 'coral',
  green: 'success',
  lime: 'success',
  orange: 'amber',
  gold: 'amber',
  volcano: 'amber',
  red: 'error',
  magenta: 'error',
  purple: 'coral',
  // AntD 的状态色（Badge / Tag 的 status 形参）
  processing: 'coral',
  success: 'success',
  warning: 'amber',
  error: 'error',
};

/** 取某个预置名对应的语义色（未知名字回落到中性，不抛错——字典是业务可维护的） */
export const toneOf = (preset?: string | null): Tone => TONES[PRESET_TONE_MAP[String(preset ?? '')] ?? 'neutral'];

/** 非 Tag 场景（状态点、色块、图表、卡片强调条）用的内联样式 */
export const toneStyle = (preset?: string | null): CSSProperties => {
  const t = toneOf(preset);
  return { background: t.bg, color: t.fg, border: `1px solid ${t.border}` };
};

/* ---------------- 图表 ---------------- */

/** ECharts 系列配色：珊瑚打头，青/琥珀/绿跟上（取代原来的蓝/绿/紫/橙） */
export const chartPalette = [
  palette.primary,
  palette.accentTeal,
  palette.accentAmber,
  palette.success,
  palette.surfaceDark,
  palette.error,
] as const;

/* ---------------- AntD 主题 ---------------- */

export const antdTheme: ThemeConfig = {
  token: {
    colorPrimary: palette.primary,
    colorLink: palette.primaryActive,
    colorInfo: palette.accentTeal,
    colorSuccess: palette.success,
    colorWarning: palette.warning,
    colorError: palette.error,

    colorTextBase: palette.body,
    colorText: palette.body,
    colorTextHeading: palette.ink,
    colorTextSecondary: palette.muted,
    colorTextTertiary: palette.mutedSoft,
    colorTextQuaternary: palette.mutedSoft,

    colorBorder: palette.hairline,
    colorBorderSecondary: palette.hairlineSoft,
    colorSplit: palette.hairlineSoft,

    colorBgLayout: palette.canvas,
    colorBgContainer: palette.canvas,
    colorBgElevated: palette.canvas,
    colorBgSpotlight: palette.surfaceDark,

    borderRadius: radius.md,
    borderRadiusLG: radius.lg,
    borderRadiusSM: radius.sm,

    fontFamily: font.sans,
    fontSize: 14,
    controlHeight: 40,

    // "color-block first, shadow rare"：默认去阴影，只在浮层留一层极浅的
    boxShadow: 'none',
    boxShadowSecondary: '0 1px 3px rgba(20, 20, 19, 0.08)',
    boxShadowTertiary: 'none',
  },
  components: {
    Layout: {
      headerBg: palette.surfaceDark,
      headerHeight: 64,
      headerPadding: '0 16px',
      bodyBg: palette.canvas,
      siderBg: palette.surfaceDark,
    },
    Menu: {
      darkItemBg: palette.surfaceDark,
      darkSubMenuItemBg: palette.surfaceDarkSoft,
      darkItemSelectedBg: palette.surfaceDarkElevated,
      darkItemColor: palette.onDarkSoft,
      darkItemSelectedColor: palette.onDark,
      darkItemHoverColor: palette.onDark,
      darkItemHoverBg: palette.surfaceDarkSoft,
      itemBorderRadius: radius.sm,
      itemMarginInline: 8,
    },
    Table: {
      headerBg: palette.surfaceCard,
      headerColor: palette.ink,
      headerSplitColor: 'transparent',
      rowHoverBg: palette.surfaceSoft,
      borderColor: palette.hairline,
      cellPaddingBlock: 8,
      cellPaddingInline: 12,
    },
    Card: {
      colorBgContainer: palette.canvas,
      borderRadiusLG: radius.lg,
      paddingLG: pageCardPadding.desktop,
      headerFontSize: 16,
      boxShadowTertiary: 'none',
    },
    Modal: {
      contentBg: palette.canvas,
      headerBg: palette.canvas,
      titleFontSize: 18,
      borderRadiusLG: radius.lg,
    },
    Button: {
      borderRadius: radius.md,
      fontWeight: 500,
      primaryShadow: 'none',
      defaultShadow: 'none',
      dangerShadow: 'none',
    },
    Input: {
      colorBgContainer: palette.canvas,
      borderRadius: radius.md,
      activeShadow: `0 0 0 3px rgba(204, 120, 92, 0.15)`,
    },
    Select: {
      colorBgContainer: palette.canvas,
      optionSelectedBg: palette.surfaceCard,
    },
    Tag: { borderRadiusSM: radius.pill },
    Tabs: {
      itemColor: palette.muted,
      itemSelectedColor: palette.ink,
      itemHoverColor: palette.ink,
      inkBarColor: palette.primary,
    },
    Pagination: { itemActiveBg: palette.surfaceCard },
    Descriptions: { labelBg: palette.surfaceSoft },
    Statistic: { titleFontSize: 13 },
    Segmented: { itemSelectedBg: palette.surfaceCard, itemColor: palette.muted },
  },
};
