import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  Badge,
  Button,
  Checkbox,
  Col,
  DatePicker,
  Dropdown,
  Form,
  Input,
  Modal,
  Popover,
  Row,
  Select,
  Space,
  Table,
  Tag,
  Tooltip,
  message,
} from 'antd';
import type { FormInstance } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import {
  DownOutlined,
  MoreOutlined,
  ReloadOutlined,
  SearchOutlined,
  SettingOutlined,
  UpOutlined,
} from '@ant-design/icons';
import dayjs from 'dayjs';
import { procurementTaskApi } from '@/api/modules';
import { taskTypeLabel, taskTypeTone } from '@/constants/procurementWorkflow';
import { useContainerWidth } from '@/hooks/useContainerWidth';
import { useListColumns } from '@/hooks/useListColumns';
import { columnKeyOf, filterVisibleColumns } from '@/utils/listColumns';
import EmptyState from '@/components/EmptyState';

/**
 * 采购六模块通用「标准列表页」（筛选区 + 工具栏 + 数据表格 + 分页）：
 * 数据来自采购任务列表接口（module 参数联表返回模块记录字段），
 * 公共列：状态 / 采购编号 / 采购内容 / 采购类型 / [模块特有列] / 发布时间 / 操作；
 * 行操作「查看」进入只读详情，「更多 → 编辑」直接打开编辑弹窗（业务规则仍以详情接口 editable 为准）。
 */

/** 模块状态：无记录=未填写、有记录未发布=编辑中、已发布=已完成 */
export type ModuleStatusValue = 'UNFILLED' | 'EDITING' | 'PUBLISHED';

export interface ModuleListRow {
  id: string;
  taskNo: string;
  type: string;
  content: string;
  status: string;
  stage: number;
  preMeetingRequired?: boolean;
  estimatedAmountWan?: number | null;
  createdAt?: string;
  /** 采购品类：物资 | 租赁（采购发起第一步填写，决定合同模板映射） */
  procurementCategory?: string | null;
  /** 模块记录字段（module 参数联表返回；无记录为 null） */
  module?: Record<string, any> | null;
}

export const moduleStatusOf = (row: ModuleListRow): { value: ModuleStatusValue; label: string; color: string } => {
  if (!row.module) return { value: 'UNFILLED', label: '未填写', color: 'default' };
  return row.module.publishedAt
    ? { value: 'PUBLISHED', label: '已完成', color: 'blue' }
    : { value: 'EDITING', label: '编辑中', color: 'orange' };
};

/** 筛选字段定义（dateRange 类型提交时拆为 `${key}From` / `${key}To`） */
export interface ModuleListFilterField {
  key: string;
  label: string;
  control: 'input' | 'select' | 'dateRange';
  options?: { label: string; value: string }[];
  placeholder?: string;
  /** 自定义控件（问题四：如 DictSelect；优先于 control，仍由 Form.Item 包裹参与查询/重置） */
  render?: () => ReactNode;
}

/** 公共「模块状态」筛选项（六页相同） */
export const MODULE_STATUS_FILTER: ModuleListFilterField = {
  key: 'moduleStatus',
  label: '状态',
  control: 'select',
  options: [
    { label: '全部', value: '' },
    { label: '未填写', value: 'UNFILLED' },
    { label: '编辑中', value: 'EDITING' },
    { label: '已完成', value: 'PUBLISHED' },
  ],
};

/** 公共「发布时间」筛选项 */
export const PUBLISHED_AT_FILTER: ModuleListFilterField = {
  key: 'published',
  label: '发布时间',
  control: 'dateRange',
};

export interface ModuleListPageProps {
  /** 后端 module 参数（PRE_MEETING / NOTICE / DOCUMENT / RESULT_REPORT / PRICE_COMPARE / FRAMEWORK_EXPLANATION）；generic 模式下可省略 */
  moduleKey?: string;
  /** 列表模式：module=采购任务联表（默认，含采购公共列/公共筛选）；generic=通用标准列表（列/筛选全由页面定义） */
  mode?: 'module' | 'generic';
  /** generic 模式自定义数据源：入参为分页+筛选参数，返回 { list, total } 形态 */
  fetcher?: (params: Record<string, any>) => Promise<any>;
  /** 基础查询参数（如 type=SINGLE&preMeetingRequired=true） */
  baseParams?: Record<string, unknown>;
  /** 特有筛选项（排在公共筛选之后） */
  extraFilters?: ModuleListFilterField[];
  /** 特有表格列（module 模式插在「采购类型」之后、「发布时间」之前；generic 模式为完整列定义） */
  extraColumns?: ColumnsType<ModuleListRow>;
  /** 工具栏左侧内容（如范围说明/新建按钮） */
  toolbarLeft?: ReactNode;
  /** 筛选行内、「查询」按钮之前的内容（如采购发起的「任务发起」按钮） */
  actionBeforeSearch?: ReactNode;
  /** 列表刷新键（外部保存/发布后 +1 触发重查） */
  refreshKey?: number;
  /** 行操作：查看（进入只读详情；仅 showOpColumn 时使用） */
  onView?: (row: ModuleListRow) => void;
  /** 是否显示「操作」列（问题四：无行操作的页面如合同台账可关闭；默认 true） */
  showOpColumn?: boolean;
  /** 行操作：编辑（可选；不传则「更多」中不显示编辑项） */
  onEdit?: (row: ModuleListRow) => void;
  /** 行是否可编辑的判定（控制「更多 → 编辑」是否禁用；默认按模块状态=编辑中可编辑） */
  rowEditable?: (row: ModuleListRow) => boolean;
  /** 行操作：删除模块并回退流程（问题二；不传则「更多」中不显示删除项） */
  onDelete?: (row: ModuleListRow) => void;
  /** 行是否可删除的判定（控制「更多 → 删除」是否禁用；默认已进入合同阶段不可删） */
  rowDeletable?: (row: ModuleListRow) => boolean;
  /** 「更多」菜单追加项（问题四：各页面自定义行操作，如总采购清单/下载等）；children 渲染为子菜单 */
  rowMenuItems?: (row: ModuleListRow) => {
    key: string;
    label: ReactNode;
    disabled?: boolean;
    danger?: boolean;
    onClick?: () => void;
    children?: { key: string; label: ReactNode; disabled?: boolean; danger?: boolean; onClick?: () => void }[];
  }[];
  /** 空列表提示文案 */
  emptyText?: string;
  /**
   * 启用「列设置」的存储键（**每浏览器**偏好，存 localStorage，不落库）。
   * 不传时：module 模式自动取 `procurement.<moduleKey>`；generic 模式不启用（该页可显式传 key 开启）。
   * ⚠️ 台账页（Ledger）**不要**传——它用的是服务端共享列配置 `ledger.columns.config`，语义不同。
   */
  columnConfigKey?: string;
  /** 额外不可隐藏的列标识（「操作」列与无标识列总是保留） */
  columnConfigLockedKeys?: string[];
  /**
   * 命中这些字段名时，筛选值变化**立即查询**（等价于点一次「查询」）。
   *
   * 用途：像「资金费用台账」这种"先选合同才加载"的页面 —— 选了合同还要用户再点一次查询
   * 会很别扭。其余筛选条件仍保持"点查询才生效"的手感。
   */
  autoSearchOnChange?: string[];
  /**
   * 任一筛选值变化时的回调（收到全部值与本次变更的字段）。
   * 用途：让页面把筛选值同步到自己的 state（如上例中要拿 `contractId` 去拉合同资金参数）。
   */
  onFilterChange?: (values: Record<string, any>, changed: Record<string, any>) => void;
  /** 取数完成后的回调（拿到接口原始响应）——供页面取出 `totals`/`stats` 这类汇总数据 */
  onFetched?: (res: any) => void;
  /** 表格合计行（`Table.Summary` 的内容）。需要页面自己先经 `onFetched` 拿到汇总数据再拼 */
  tableSummary?: ReactNode;
}

/**
 * 筛选字段的最小可用宽度（px）→ **每行几列**由容器宽度除出来，而不是套断点：
 * 容器比视口窄掉整个外壳（侧栏 + 边距，1280 桌面只剩 ~996），直接套 480/720/1024 会把
 * 每一档都往下挪一格（1280 桌面从 4 列掉成 3 列）。按"一个筛选项至少 240px 才不挤"推，
 * 三档视口下的结果与 DESIGN.md §10 完全对齐：375 → 2 列 · 768 → 3 列 · 1280 → 4 列。
 * （这不是"又一个断点"，是布局约束；断点仍只有 `containerSize.ts` 那一处。）
 */
const MIN_FILTER_FIELD_W = 240;
const PER_ROW_MIN = 2; // 再窄也不单列：筛选区两列比一列更省纵向空间（DESIGN.md §10.1）
const PER_ROW_MAX = 4;

/** 由每行字段数推出 `Col flex`（用 CSS 值而不是 AntD 断点 prop：断点 prop 是视口驱动的） */
const filterColFlexOf = (perRow: number) => `0 0 ${(100 / perRow).toFixed(4)}%`;

export default function ModuleListPage({
  moduleKey,
  mode = 'module',
  fetcher,
  baseParams,
  extraFilters = [],
  extraColumns = [],
  toolbarLeft,
  actionBeforeSearch,
  refreshKey = 0,
  onView,
  onEdit,
  rowEditable,
  onDelete,
  rowDeletable,
  rowMenuItems,
  showOpColumn = true,
  emptyText,
  columnConfigKey,
  columnConfigLockedKeys,
  autoSearchOnChange,
  onFilterChange,
  onFetched,
  tableSummary,
}: ModuleListPageProps) {
  const isModuleMode = mode === 'module';
  /**
   * **容器**驱动（DESIGN.md §10.2）：冻结列、紧凑行高、筛选区列数由**列表页自身宽度**决定，
   * 不再看视口——列表页可能被放进弹窗/抽屉/分栏里，"窗口宽不宽"推不出"表格挤不挤"。
   * 列宽用 `Col flex`（CSS 值）而不是 `xs/md/lg` 断点 prop：断点 prop 是视口驱动的，改不动。
   */
  const { ref: cqRef, size: containerSize } = useContainerWidth<HTMLDivElement>();
  // 容器宽度未知（首帧）时按 4 列渲染，避免先窄后宽闪一下
  const perRow = Math.min(
    PER_ROW_MAX,
    Math.max(PER_ROW_MIN, Math.floor((containerSize.width || Infinity) / MIN_FILTER_FIELD_W)),
  );
  const filterColFlex = filterColFlexOf(perRow);
  const [form] = Form.useForm();
  const [rows, setRows] = useState<ModuleListRow[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);
  const [loading, setLoading] = useState(false);
  const [expanded, setExpanded] = useState(false);
  /** 已提交的筛选值（查询/重置时更新） */
  const [committed, setCommitted] = useState<Record<string, any>>({});

  const filters = useMemo(
    () => (isModuleMode ? [MODULE_STATUS_FILTER, PUBLISHED_AT_FILTER, ...extraFilters] : extraFilters),
    [extraFilters, isModuleMode],
  );
  const visibleFilters = useMemo(
    () => (expanded ? filters : filters.slice(0, perRow)),
    [filters, expanded, perRow],
  );
  const collapsible = filters.length > perRow;

  /**
   * ⚠️ **引用稳定性**：取数 effect 的依赖里有 `fetchRows` → `buildParams`，
   * 而 `buildParams` 要用 `baseParams` / `fetcher` 两个 **prop**。
   * 调用方几乎都写成内联字面量（`baseParams={{ type: 'SINGLE' }}`、
   * `fetcher={(p) => api.list(p)}`），引用**每轮渲染都会变** ——
   * 若把它们直接放进依赖数组，effect 会在每次渲染后重跑：
   * 取数 → `setRows(新数组)` → 重渲染 → 依赖又变 → 再取数，**形成请求风暴**
   * （更糟的是多页签会把多个列表页同时挂在 DOM 上，风暴会成倍）。
   *
   * 因此这里做两件事：
   * - `baseParams` 用**值的签名**（字符串）参与依赖：值变了才重新取数，引用变了不算；
   * - `fetcher` 走 ref（函数无法序列化签名）：始终调用最新的那一个，但不因引用变化触发取数。
   * 两者合起来使 `fetchRows` 只在 **page / pageSize / 筛选值 / baseParams 的值** 变化时才变。
   */
  const baseParamsKey = useMemo(() => {
    try {
      return JSON.stringify(baseParams ?? {});
    } catch {
      // 循环引用等异常：退化为"没有基础参数"，也绝不因此反复取数
      return '{}';
    }
  }, [baseParams]);
  const stableBaseParams = useMemo<Record<string, unknown>>(() => JSON.parse(baseParamsKey), [baseParamsKey]);
  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;
  /** 取数完成回调同样走 ref：调用方一般传行内箭头函数，不应影响取数 effect 的依赖 */
  const onFetchedRef = useRef(onFetched);
  onFetchedRef.current = onFetched;

  const buildParams = useCallback(
    (values: Record<string, any>) => {
      const params: Record<string, any> = {
        ...(isModuleMode ? { module: moduleKey } : {}),
        page,
        pageSize,
        ...stableBaseParams,
      };
      Object.entries(values ?? {}).forEach(([k, v]) => {
        if (v == null || v === '' || (Array.isArray(v) && v.length === 0)) return;
        if (Array.isArray(v)) {
          // 日期区间：拆为 ${key}From（当日 00:00:00）/ ${key}To（当日 23:59:59）
          const [from, to] = v;
          if (from) params[`${k}From`] = dayjs(from).startOf('day').toISOString();
          if (to) params[`${k}To`] = dayjs(to).endOf('day').toISOString();
        } else {
          params[k] = v;
        }
      });
      return params;
    },
    [isModuleMode, moduleKey, page, pageSize, stableBaseParams],
  );

  /** 请求序号：丢弃过期响应（快速改筛选连续查询时，慢的旧响应不得覆盖新结果） */
  const fetchSeqRef = useRef(0);
  const fetchRows = useCallback(
    (values: Record<string, any>) => {
      const seq = ++fetchSeqRef.current;
      setLoading(true);
      const req = fetcherRef.current
        ? Promise.resolve(fetcherRef.current(buildParams(values)))
        : procurementTaskApi.list(buildParams(values));
      req
        .then((res: any) => {
          if (seq !== fetchSeqRef.current) return; // 过期响应丢弃
          const list = res?.list ?? res?.data?.list ?? [];
          const nextTotal = Number(res?.total ?? res?.data?.total ?? 0) || 0;
          setRows(list);
          setTotal(nextTotal);
          // 末页被删空后自动回落到最后一页（第 17~20 轮审计 P3-10：
          // 原来停在空页，看起来像「数据全没了」，得手动点回上一页）
          const maxPage = Math.max(1, Math.ceil(nextTotal / pageSize));
          if (list.length === 0 && nextTotal > 0 && page > maxPage) setPage(maxPage);
          onFetchedRef.current?.(res);
        })
        .catch(() => {
          if (seq !== fetchSeqRef.current) return;
          setRows([]);
          setTotal(0);
        })
        .finally(() => {
          if (seq === fetchSeqRef.current) setLoading(false);
        });
    },
    // page/pageSize 用于「末页被删空后自动回落」，必须进 deps
    [buildParams, page, pageSize],
  );

  useEffect(() => {
    fetchRows(committed);
  }, [committed, page, pageSize, refreshKey, fetchRows]);

  const handleSearch = () => {
    setPage(1);
    setCommitted(form.getFieldsValue());
  };
  const handleReset = () => {
    form.resetFields();
    setPage(1);
    // 重置同样要让页面知道（被清空的字段可能就是页面依赖的那个，如合同）
    const values = form.getFieldsValue();
    onFilterChange?.(values, values);
    setCommitted(values);
  };

  /**
   * 表单值变化：先把变更透出给页面（如"选合同 → 去拉合同资金参数"），
   * 命中 `autoSearchOnChange` 的字段则**立即查询**（等价于点一次「查询」）。
   */
  const handleValuesChange = (changed: Record<string, any>, all: Record<string, any>) => {
    onFilterChange?.(all, changed);
    if (!autoSearchOnChange?.length) return;
    if (!Object.keys(changed).some((k) => autoSearchOnChange.includes(k))) return;
    setPage(1);
    setCommitted({ ...all });
  };

  /* ---------------- 表格列 ---------------- */

  const columns: ColumnsType<ModuleListRow> = [
    // 采购模块公共列（generic 模式下由页面通过 extraColumns 自行定义完整列）
    ...(isModuleMode
      ? ([
          {
            title: '状态',
            key: 'moduleStatus',
            width: 90,
            render: (_v, row) => {
              const s = moduleStatusOf(row);
              return <Tag color={s.color}>{s.label}</Tag>;
            },
          },
          {
            title: '采购编号',
            dataIndex: 'taskNo',
            width: 170,
            // 窄容器下横向滚动时冻结关键列（DESIGN.md §10.2）
            ...(containerSize.isNarrow ? { fixed: 'left' as const } : {}),
            render: (v: string, row) => (
              <Button type="link" size="small" style={{ padding: 0 }} onClick={() => onView(row)}>
                {v}
              </Button>
            ),
          },
          {
            title: '采购内容',
            dataIndex: 'content',
            ellipsis: { showTitle: true },
            render: (v: string) => v || '-',
          },
          {
            title: '采购类型',
            dataIndex: 'type',
            width: 110,
            // 窄容器下收起（styles/containers.css 的 [@container] 规则按容器宽度隐藏）
            className: 'col-secondary',
            render: (v: string) => <Tag color={taskTypeTone(v)}>{taskTypeLabel(v)}</Tag>,
          },
        ] as ColumnsType<ModuleListRow>)
      : []),
    ...extraColumns,
    ...(isModuleMode
      ? ([
          {
            title: '发布时间',
            key: 'publishedAt',
            width: 140,
            className: 'col-secondary',
            render: (_v, row) =>
              row.module?.publishedAt ? dayjs(row.module.publishedAt).format('YYYY-MM-DD HH:mm') : '-',
          },
        ] as ColumnsType<ModuleListRow>)
      : []),
    ...(showOpColumn
      ? ([
          {
            title: '操作',
            key: 'op',
            width: 120,
            fixed: 'right' as const,
            render: (_v, row) => {
        // module 模式默认按模块状态判定可编辑；generic 模式默认可编辑（由页面通过 rowEditable 覆盖）
        const editable = rowEditable
          ? rowEditable(row)
          : isModuleMode
            ? moduleStatusOf(row).value !== 'PUBLISHED'
            : true;
        const deletable = rowDeletable
          ? rowDeletable(row)
          : !['CONTRACT_EDITING', 'CONTRACT_APPROVING', 'COMPLETED'].includes(row.status);
        const moreItems: {
          key: string;
          label: ReactNode;
          danger?: boolean;
          disabled?: boolean;
          onClick?: () => void;
          children?: { key: string; label: ReactNode; disabled?: boolean; danger?: boolean; onClick?: () => void }[];
        }[] = [];
        if (onEdit) {
          moreItems.push({
            key: 'edit',
            label: '编辑',
            disabled: !editable,
            onClick: () => onEdit(row),
          });
        }
        if (onDelete) {
          moreItems.push({
            key: 'delete',
            label: '删除',
            danger: true,
            disabled: !deletable,
            onClick: () => onDelete(row),
          });
        }
        moreItems.push(...(rowMenuItems?.(row) ?? []));
        // 问题一：module 模式首按钮按模块状态切换——未填写/编辑中显示「编辑」（直接进编辑界面），
        // 已完成显示「查看」（进入任务查看弹窗）；generic 模式保持「查看」
        const published = isModuleMode && moduleStatusOf(row).value === 'PUBLISHED';
        const primary =
          published || !onEdit
            ? onView
              ? { label: '查看', onClick: () => onView(row) }
              : null
            : { label: '编辑', onClick: () => onEdit(row) };
        return (
          <Space size={4}>
            {primary && (
              <Button type="link" size="small" style={{ padding: 0 }} onClick={primary.onClick}>
                {primary.label}
              </Button>
            )}
            {moreItems.length > 0 && (
              <Dropdown menu={{ items: moreItems }}>
                <Button type="link" size="small" style={{ padding: 0 }}>
                  更多 <MoreOutlined />
                </Button>
              </Dropdown>
            )}
          </Space>
        );
      },
    },
  ] as ColumnsType<ModuleListRow>)
      : []),
  ];

  /* ---------------- 列设置（每浏览器偏好，存 localStorage） ---------------- */

  /** module 模式按模块自动取键；generic 模式须显式传 columnConfigKey 才启用 */
  const effectiveColumnConfigKey =
    columnConfigKey ?? (isModuleMode && moduleKey ? `procurement.${moduleKey}` : undefined);
  // 用签名串做 useMemo 依赖：columns 每次渲染都是新数组，直接当依赖会让 memo 失效
  const columnKeySignature = columns.map(columnKeyOf).filter(Boolean).join('|');
  const columnKeys = useMemo(() => (columnKeySignature ? columnKeySignature.split('|') : []), [columnKeySignature]);
  /** 「操作」列与关键标识列（module 模式的采购编号）不可隐藏 */
  const lockedColumnKeys = useMemo(
    () => ['op', ...(isModuleMode ? ['taskNo'] : []), ...(columnConfigLockedKeys ?? [])],
    [isModuleMode, columnConfigLockedKeys],
  );
  const { hiddenKeys, isHidden, toggle, reset, hiddenCount } = useListColumns({
    configKey: effectiveColumnConfigKey,
    allKeys: columnKeys,
    lockedKeys: lockedColumnKeys,
  });
  // 直接过滤（不做 useMemo）：`columns` 每轮渲染都是新数组，若把 memo 依赖设为键签名，
  // 列内的 render/事件闭包会在依赖未变时滞留旧值（点「查看」调用旧 handler 这类隐性 bug）。
  const visibleColumns = filterVisibleColumns(columns, hiddenKeys, lockedColumnKeys);
  const columnConfigItems = columns
    .map((c) => ({ key: columnKeyOf(c), title: c.title as ReactNode }))
    .filter((c) => c.key !== '');
  const columnConfigContent = (
    <div style={{ maxWidth: 240 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
        <span style={{ fontSize: 12, color: 'var(--cms-muted-soft)' }}>勾选要显示的列</span>
        <Button type="link" size="small" style={{ padding: 0 }} disabled={!hiddenCount} onClick={reset}>
          重置
        </Button>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6, maxHeight: 320, overflowY: 'auto' }}>
        {columnConfigItems.map((c) => {
          const locked = lockedColumnKeys.includes(c.key);
          return (
            <Checkbox
              key={c.key}
              checked={locked || !isHidden(c.key)}
              disabled={locked}
              // 勾选框 checked = 「可见」，toggle 的第二参是「是否隐藏」→ 必须取反
              onChange={(e) => toggle(c.key, !e.target.checked)}
            >
              {c.title || c.key}
            </Checkbox>
          );
        })}
      </div>
    </div>
  );

  /* ---------------- 筛选控件 ---------------- */

  const renderControl = (f: ModuleListFilterField) => {
    if (f.render) return f.render();
    if (f.control === 'dateRange') {
      return <DatePicker.RangePicker style={{ width: '100%' }} allowEmpty={[false, false]} />;
    }
    if (f.control === 'select') {
      return (
        <Select
          style={{ width: '100%' }}
          options={(f.options ?? []).map((o) => ({ value: o.value, label: o.label }))}
          placeholder={f.placeholder ?? '全部'}
          allowClear
        />
      );
    }
    return <Input placeholder={f.placeholder ?? `请输入${f.label}`} allowClear />;
  };

  return (
    <div
      ref={cqRef}
      className="cq"
      style={{
        background: 'var(--cms-paper)',
        borderRadius: 8,
        padding: '16px 16px 8px',
        border: '1px solid var(--cms-hairline-soft)',
      }}
    >
      {/* 1. 顶部筛选区（可折叠） */}
      <Form form={form} layout="vertical" style={{ marginBottom: 4 }} onValuesChange={handleValuesChange}>
        <Row key={expanded ? 'expanded' : 'collapsed'} gutter={[16, 0]} align="middle">
          {visibleFilters.map((f) => (
            <Col key={f.key} flex={filterColFlex} style={{ marginBottom: 12 }}>
              <Form.Item name={f.key} label={f.label} style={{ marginBottom: 0 }}>
                {renderControl(f)}
              </Form.Item>
            </Col>
          ))}
          <Col flex="auto" style={{ textAlign: 'right', marginBottom: 12 }}>
            <Space size={8} wrap>
              {actionBeforeSearch}
              <Button type="primary" icon={<SearchOutlined />} onClick={handleSearch}>
                查 询
              </Button>
              <Button onClick={handleReset}>重 置</Button>
              {collapsible && (
                <Button type="link" onClick={() => setExpanded((v) => !v)}>
                  {expanded ? '收起' : '筛选条件'} {expanded ? <UpOutlined /> : <DownOutlined />}
                </Button>
              )}
            </Space>
          </Col>
        </Row>
      </Form>

      {/* 2. 中部工具栏 */}
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          margin: '4px 0 12px',
          flexWrap: 'wrap',
          gap: 8,
        }}
      >
        <Space wrap size={8}>
          {toolbarLeft}
        </Space>
        <Space size={12}>
          <span style={{ color: 'var(--cms-muted-soft)', fontSize: 13 }}>
            本页: {rows.length}条 总计: {total}条
          </span>
          {effectiveColumnConfigKey && (
            <Popover content={columnConfigContent} trigger="click" placement="bottomRight">
              <Tooltip title={hiddenCount ? `列设置（已隐藏 ${hiddenCount} 列）` : '列设置'}>
                <Badge dot={hiddenCount > 0}>
                  <Button size="small" icon={<SettingOutlined />} />
                </Badge>
              </Tooltip>
            </Popover>
          )}
          <Tooltip title="刷新">
            <Button size="small" icon={<ReloadOutlined />} onClick={() => fetchRows(committed)} />
          </Tooltip>
        </Space>
      </div>

      {/* 3. 数据表格 + 分页 */}
      <Table<ModuleListRow>
        size={containerSize.isNarrow ? 'small' : 'middle'}
        rowKey="id"
        columns={visibleColumns}
        dataSource={rows}
        loading={loading}
        scroll={{ x: 'max-content' }}
        {...(tableSummary ? { summary: () => tableSummary } : {})}
        locale={{ emptyText: <EmptyState compact description={emptyText ?? '暂无数据'} /> }}
        pagination={{
          current: page,
          pageSize,
          total,
          showSizeChanger: true,
          showQuickJumper: true,
          pageSizeOptions: [10, 20, 50, 100],
          onChange: (p, ps) => {
            setPage(ps !== pageSize ? 1 : p);
            setPageSize(ps);
          },
          showTotal: () => `共 ${total} 条`,
        }}
      />
    </div>
  );
}

/** 导出 Form 类型供页面复用（如需受控取值） */
export type { FormInstance };

/**
 * 问题二：删除子模块记录并回退流程（六模块列表共用确认逻辑）。
 * 已发布记录 → 删除后任务回退到本阶段、恢复「编制中」（上一阶段状态同步回退）；
 * 未发布草稿 → 仅清除草稿内容。
 */
export function useModuleDelete(moduleKey: string, onChanged?: () => void) {
  return (row: ModuleListRow) => {
    const published = !!row.module?.publishedAt;
    Modal.confirm({
      title: published ? '删除该模块并回退流程？' : '清除该模块草稿？',
      content: published
        ? '删除后该模块记录将被移除，任务回退到本阶段并恢复「编制中」；该阶段之后已编制/发布的内容须先删除，否则无法删除本模块。'
        : '将清除本模块已填写的草稿内容，任务状态不变。',
      okText: '确认删除',
      okType: 'danger',
      onOk: async () => {
        await procurementTaskApi.deleteModule(row.id, moduleKey);
        message.success(published ? '已删除并回退流程，上一阶段恢复可编辑' : '已清除模块草稿');
        onChanged?.();
      },
    });
  };
}
