import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import {
  Button,
  Col,
  DatePicker,
  Dropdown,
  Empty,
  Form,
  Input,
  Modal,
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
  UpOutlined,
} from '@ant-design/icons';
import dayjs from 'dayjs';
import { procurementTaskApi } from '@/api/modules';
import { taskTypeLabel } from '@/constants/procurementWorkflow';

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
}

const PER_ROW = 4; // 每行筛选字段数

export default function ModuleListPage({
  moduleKey,
  mode = 'module',
  fetcher,
  baseParams,
  extraFilters = [],
  extraColumns = [],
  toolbarLeft,
  refreshKey = 0,
  onView,
  onEdit,
  rowEditable,
  onDelete,
  rowDeletable,
  rowMenuItems,
  showOpColumn = true,
  emptyText,
}: ModuleListPageProps) {
  const isModuleMode = mode === 'module';
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
    () => (expanded ? filters : filters.slice(0, PER_ROW)),
    [filters, expanded],
  );
  const collapsible = filters.length > PER_ROW;

  const buildParams = useCallback(
    (values: Record<string, any>) => {
      const params: Record<string, any> = {
        ...(isModuleMode ? { module: moduleKey } : {}),
        page,
        pageSize,
        ...(baseParams ?? {}),
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
    [isModuleMode, moduleKey, page, pageSize, baseParams],
  );

  const fetchRows = useCallback(
    (values: Record<string, any>) => {
      setLoading(true);
      const req = fetcher
        ? Promise.resolve(fetcher(buildParams(values)))
        : procurementTaskApi.list(buildParams(values));
      req
        .then((res: any) => {
          setRows(res?.list ?? res?.data?.list ?? []);
          setTotal(res?.total ?? res?.data?.total ?? 0);
        })
        .catch(() => {
          setRows([]);
          setTotal(0);
        })
        .finally(() => setLoading(false));
    },
    [buildParams, fetcher],
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
    setCommitted({});
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
            render: (v: string) => <Tag color="cyan">{taskTypeLabel(v)}</Tag>,
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
      style={{
        background: '#fff',
        borderRadius: 8,
        padding: '16px 16px 8px',
        border: '1px solid #f0f0f0',
      }}
    >
      {/* 1. 顶部筛选区（可折叠） */}
      <Form form={form} layout="vertical" style={{ marginBottom: 4 }}>
        <Row key={expanded ? 'expanded' : 'collapsed'} gutter={[16, 0]} align="middle">
          {visibleFilters.map((f) => (
            <Col key={f.key} span={6} style={{ marginBottom: 12 }}>
              <Form.Item name={f.key} label={f.label} style={{ marginBottom: 0 }}>
                {renderControl(f)}
              </Form.Item>
            </Col>
          ))}
          <Col flex="auto" style={{ textAlign: 'right', marginBottom: 12 }}>
            <Space size={8} wrap>
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
          <span style={{ color: '#8c8c8c', fontSize: 13 }}>
            本页: {rows.length}条 总计: {total}条
          </span>
          <Tooltip title="刷新">
            <Button size="small" icon={<ReloadOutlined />} onClick={() => fetchRows(committed)} />
          </Tooltip>
        </Space>
      </div>

      {/* 3. 数据表格 + 分页 */}
      <Table<ModuleListRow>
        size="middle"
        rowKey="id"
        columns={columns}
        dataSource={rows}
        loading={loading}
        scroll={{ x: 'max-content' }}
        locale={{ emptyText: <Empty description={emptyText ?? '暂无数据'} /> }}
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
