import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Badge, Button, Card, List, Modal, Space, Tabs, Tag, Tooltip } from 'antd';
import { DeleteOutlined, EyeOutlined, RightOutlined } from '@ant-design/icons';
import dayjs from 'dayjs';
import { dashboardApi } from '@/api/modules';
import { useAuthStore } from '@/store/auth';
import { useTabActivate } from '@/hooks/useTabs';
import { DASHBOARD_TODO_TABS } from '@/constants/dashboardTodoTabs';
import EmptyState from '@/components/EmptyState';

/* ==================== 我的待办（业务口径 2026-10-16） ==================== */

/**
 * 「消除提醒 / 当天首次浮窗」的本地状态：`localStorage` 按 **用户 + 日期** 记录已处理的待办 key。
 *
 * 取舍（有意为之）：**不落库** —— 换来零后端改动；代价是跨设备/跨浏览器不同步。
 * key 里带日期，隔天自动失效（新的一天待办重新出现，正好符合"今天的待办"语义）。
 *
 * ⚠️ **两份存储，刻意分开**：
 * - `scm_dashboard_seen_<u>`：浮窗的"已看过"——浮窗弹出即写入（否则每次进工作台都弹）；
 * - `scm_dashboard_dismissed_<u>`：列表里的「消除提醒」——只隐藏用户**显式**赶走的那几条。
 * 共用一份是错的：浮窗一弹就把全部待办标为"已消除"，列表里会一条都不剩（实测踩到）。
 */
const seenStoreKey = (userId: string) => `scm_dashboard_seen_${userId}`;
const dismissedStoreKey = (userId: string) => `scm_dashboard_dismissed_${userId}`;

interface NoticeState {
  date: string;
  seenKeys: string[];
}

function readKeys(storeKey: (u: string) => string, userId: string): NoticeState | null {
  try {
    const raw = localStorage.getItem(storeKey(userId));
    return raw ? (JSON.parse(raw) as NoticeState) : null;
  } catch {
    return null;
  }
}

function writeKeys(storeKey: (u: string) => string, userId: string, state: NoticeState): void {
  try {
    localStorage.setItem(storeKey(userId), JSON.stringify(state));
  } catch {
    /* 存储不可用时静默降级（刷新后提醒会再出现，不算错） */
  }
}

const noticeToday = () => dayjs().format('YYYY-MM-DD');

/** 级别 → Tag 色 */
const LEVEL_TONE: Record<string, string> = { RED: 'error', AMBER: 'warning', INFO: 'default' };

/**
 * 我的待办卡片（需求 2 / 3）：
 * - 分类 Tab **常驻**（0 条的分类也在，= "为每个模块都预留一个待办卡片的位置"）；
 * - 点待办按 `target` 跳转：能定位编辑器页签的跳 `<path>?editor=<id>`，否则落到模块列表；
 * - 「消除提醒」当天生效、隔天恢复。
 */
export function TodoCard() {
  const navigate = useNavigate();
  const userId = useAuthStore((s) => s.user?.id || '');
  const [data, setData] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState<string>(DASHBOARD_TODO_TABS[0]?.key ?? '');
  /** 已消除的待办 key（当天有效） */
  const [dismissed, setDismissed] = useState<string[]>([]);

  const load = useCallback(() => {
    dashboardApi
      .todos()
      .then((res: any) => setData(res))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    load();
    const timer = window.setInterval(load, 5 * 60 * 1000);
    return () => window.clearInterval(timer);
  }, [load]);

  useEffect(() => {
    if (userId) setDismissed(readKeys(dismissedStoreKey, userId)?.seenKeys ?? []);
  }, [userId]);

  /** 标签被缓存后不会重新挂载 —— 数据复检必须挂在"重新激活"上（见 useTabActivate 注释） */
  useTabActivate('/dashboard', () => {
    load();
    if (userId) setDismissed(readKeys(dismissedStoreKey, userId)?.seenKeys ?? []);
  });

  const groups: any[] = (data?.groups ?? []).map((g: any) => ({
    ...g,
    visibleItems: (g.items ?? []).filter((i: any) => !dismissed.includes(i.key)),
  }));

  const dismiss = (key: string) => {
    if (!userId) return;
    const next = Array.from(new Set([...dismissed, key]));
    setDismissed(next);
    writeKeys(dismissedStoreKey, userId, { date: noticeToday(), seenKeys: next });
  };

  const goTarget = (item: any) => {
    const t = item.target ?? {};
    const qs = new URLSearchParams();
    if (t.editor) qs.set('editor', t.editor);
    else if (t.query) Object.entries(t.query).forEach(([k, v]) => qs.set(k, String(v)));
    navigate(qs.toString() ? `${t.path}?${qs.toString()}` : t.path);
  };

  const tabItems = groups.map((g) => ({
    key: g.key,
    label: (
      <Badge count={g.visibleItems.length} size="small" offset={[8, 0]}>
        {DASHBOARD_TODO_TABS.find((t) => t.key === g.key)?.label ?? g.label}
      </Badge>
    ),
    children: (
      <List
        loading={loading}
        dataSource={g.visibleItems}
        locale={{
          emptyText: <EmptyState compact description="暂无待办——这个模块当前没有需要处理的事项" />,
        }}
        renderItem={(item: any) => (
          <List.Item
            actions={[
              <Tooltip
                key="go"
                title={item.target?.editor ? '前往处理（打开编辑页签）' : '前往处理'}
              >
                <Button type="link" size="small" icon={<EyeOutlined />} onClick={() => goTarget(item)}>
                  前往处理
                </Button>
              </Tooltip>,
              <Tooltip key="dismiss" title="今天不再提醒（隔天恢复）">
                <Button
                  type="link"
                  size="small"
                  icon={<DeleteOutlined />}
                  onClick={() => dismiss(item.key)}
                />
              </Tooltip>,
            ]}
          >
            <List.Item.Meta
              title={
                <Space size={8} wrap>
                  <Tag color={LEVEL_TONE[item.level] ?? 'default'}>{item.level}</Tag>
                  {item.code && <span style={{ color: 'var(--cms-muted)' }}>{item.code}</span>}
                  <span>{item.title}</span>
                </Space>
              }
              description={item.hint}
            />
          </List.Item>
        )}
      />
    ),
  }));

  return (
    <Card title="我的待办" extra={<span className="cms-hint">共 {data?.total ?? 0} 条</span>}>
      <Tabs activeKey={activeTab} onChange={setActiveTab} items={tabItems} />
      {groups.map((g) => {
        const shown = g.items?.length ?? 0;
        return g.count > shown ? (
          <div key={g.key} className="cms-hint">
            {DASHBOARD_TODO_TABS.find((t) => t.key === g.key)?.label}：仅显示前 {shown} 条，共 {g.count} 条
          </div>
        ) : null;
      })}
    </Card>
  );
}

/**
 * 当天首次进入工作台的待办汇总浮窗（需求 4）。
 *
 * 判定（按 用户 + 日期 存 localStorage）：
 * ① 记录的 date ≠ 今天 → 弹，并把 date 置为今天、seenKeys 置为当前全部 key；
 * ② date 是今天，但存在新 key ∉ seenKeys（= 关闭后又来了新待办）→ 弹，并把新 key 并入；
 * ③ 否则不弹。
 * 关闭即写回 —— "除非再次发生新待办且我再次进入工作台，当天不再显示"。
 */
export function DashboardNoticeModal({ data, loading }: { data: any; loading: boolean }) {
  const userId = useAuthStore((s) => s.user?.id || '');
  const [open, setOpen] = useState(false);
  const navigate = useNavigate();

  const groups: any[] = data?.groups ?? [];
  const total: number = data?.total ?? 0;

  const check = useCallback(() => {
    if (loading || !userId || !groups.length) return;
    const allKeys = groups.flatMap((g) => (g.items ?? []).map((i: any) => i.key));
    const prev = readKeys(seenStoreKey, userId);
    const isNewDay = !prev || prev.date !== noticeToday();
    const hasNew = allKeys.some((k) => !prev?.seenKeys.includes(k));
    if (isNewDay || hasNew) {
      // 弹出即视为"已看过"：当天不再弹，除非又出现新 key
      const base = prev?.date === noticeToday() ? prev!.seenKeys : [];
      writeKeys(seenStoreKey, userId, { date: noticeToday(), seenKeys: Array.from(new Set([...base, ...allKeys])) });
      setOpen(true);
    }
  }, [groups, loading, userId]);

  // 挂载后首检 + 标签重新激活时复检（缓存页不会重新挂载）
  useEffect(() => {
    const id = window.setTimeout(check, 0);
    return () => window.clearTimeout(id);
  }, [check]);
  useTabActivate('/dashboard', check);

  const goTarget = (item: any) => {
    setOpen(false);
    const t = item.target ?? {};
    navigate(t.editor ? `${t.path}?editor=${t.editor}` : t.path);
  };

  return (
    <Modal
      title={`今日待办（${total} 条）`}
      open={open}
      onCancel={() => setOpen(false)}
      footer={<Button onClick={() => setOpen(false)}>知道了</Button>}
      width={520}
    >
      {groups.map((g) =>
        (g.items ?? []).length ? (
          <div key={g.key} style={{ marginBottom: 12 }}>
            <div style={{ fontWeight: 600, marginBottom: 4 }}>
              {DASHBOARD_TODO_TABS.find((t) => t.key === g.key)?.label ?? g.label}
              <Tag style={{ marginLeft: 8 }}>{g.count}</Tag>
            </div>
            {(g.items ?? []).slice(0, 3).map((item: any) => (
              <div key={item.key} style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
                <span>
                  {item.code && <span className="cms-hint">{item.code} </span>}
                  {item.title}
                </span>
                <Button type="link" size="small" icon={<RightOutlined />} onClick={() => goTarget(item)}>
                  处理
                </Button>
              </div>
            ))}
          </div>
        ) : null,
      )}
    </Modal>
  );
}
