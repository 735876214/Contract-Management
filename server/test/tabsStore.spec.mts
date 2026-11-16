import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  EDITOR_PARAM,
  HOME_TAB_KEY,
  TAB_MAX,
  cacheKeyOf,
  closeAll,
  closeOthers,
  closeSide,
  closeTab,
  deserializeTabs,
  editorIdOf,
  editorTabKey,
  emptyTabs,
  isEditorKey,
  listPathOf,
  openTab,
  refreshTab,
  retitleTab,
  serializeTabs,
  tabKeyOf,
  type TabsState,
} from '../../web/src/utils/tabs.ts';

/**
 * 多页签导航的纯逻辑锁（被测文件 `web/src/utils/tabs.ts` **零 import**，
 * 故能被 Node 原生类型擦除直接加载，见 `.claude/rules/testing.md`）。
 *
 * 这里刻意覆盖的是"看着像小函数、错了却会静默毁掉整个多页签"的几处：
 * - `openTab` 对已存在标签**不得重置 version**（否则每次切页都重挂载，页面状态缓存全失效）；
 * - 关闭当前标签的落点顺序（右邻 → 左邻 → 首页）；
 * - 淘汰时**不丢编辑器标签**（编辑到一半的页面被淘汰 = 无声的数据丢失）；
 * - 持久化**跳过编辑器标签**（恢复一个空编辑器比不恢复更糟）。
 */

const tab = (key: string, title = key, closable = true) => ({
  key,
  path: listPathOf(key),
  href: key,
  title,
  closable,
});

/** 依次打开若干菜单页，返回状态（时间戳递增，保证 lastActive 有先后） */
function openAll(keys: string[], max = TAB_MAX): TabsState {
  let state = emptyTabs();
  keys.forEach((k, i) => {
    state = openTab(state, tab(k, `标签${k}`), 1000 + i, max);
  });
  return state;
}

const keysOf = (s: TabsState) => s.tabs.map((t) => t.key);

describe('多页签：标签键', () => {
  it('初始状态只有首页标签，且不可关闭', () => {
    const s = emptyTabs();
    assert.deepEqual(keysOf(s), [HOME_TAB_KEY]);
    assert.equal(s.tabs[0].closable, false);
  });

  it('编辑器标签键与列表键不同 —— 二者是互相独立的两份页面实例', () => {
    const list = '/settlement/order';
    const editor = editorTabKey(list, 'abc');
    assert.notEqual(editor, list);
    assert.equal(editor, `/settlement/order?${EDITOR_PARAM}=abc`);
    assert.equal(isEditorKey(list), false);
    assert.equal(isEditorKey(editor), true);
    assert.equal(listPathOf(editor), list);
    assert.equal(editorIdOf(editor), 'abc');
    assert.equal(editorIdOf(list), null);
  });

  it('tabKeyOf 只认 editor 参数，且把噪声参数归一掉', () => {
    assert.equal(tabKeyOf('/invoice', ''), '/invoice');
    assert.equal(tabKeyOf('/invoice', '?status=WAIT_VERIFY'), '/invoice');
    assert.equal(tabKeyOf('/invoice', '?editor=new'), '/invoice?editor=new');
    // 参数顺序不同 / 夹带其它参数，都必须归到同一个键，否则会开出重复标签
    assert.equal(tabKeyOf('/invoice', '?a=1&editor=9&b=2'), '/invoice?editor=9');
    assert.equal(tabKeyOf('/invoice', '?editor='), '/invoice');
  });

  it('缓存键随 version 变化（"刷新标签"就是靠它触发重挂载）', () => {
    const t = { ...tab('/x'), version: 0 };
    assert.equal(cacheKeyOf(t), '/x#0');
    assert.equal(cacheKeyOf({ ...t, version: 3 }), '/x#3');
  });
});

describe('多页签：打开与激活', () => {
  it('重复打开同一标签：不新增、不重置 version，只更新时间戳', () => {
    let s = openTab(emptyTabs(), tab('/a'), 1000);
    s = refreshTab(s, '/a');
    assert.equal(s.tabs.find((t) => t.key === '/a')?.version, 1);
    const before = keysOf(s);
    s = openTab(s, tab('/a'), 2000);
    assert.deepEqual(keysOf(s), before, '重复打开不应新增标签');
    assert.equal(s.tabs.find((t) => t.key === '/a')?.version, 1, 'version 被重置会让页面反复重挂载');
    assert.equal(s.lastActive['/a'], 2000);
  });

  it('传入的标题会覆盖（编辑器加载完记录后据此改名）', () => {
    let s = openTab(emptyTabs(), tab('/c', '合同 · 新增'), 1000);
    s = openTab(s, tab('/c', '合同 · HT-2026-001'), 2000);
    assert.equal(s.tabs.find((t) => t.key === '/c')?.title, '合同 · HT-2026-001');
  });

  it('超出上限时淘汰最久未激活的非编辑器标签，且不动当前标签', () => {
    // max=3：首页 + 2 个菜单页已满
    let s = openAll(['/a', '/b'], 3);
    // 激活 /a（时间戳最旧的是 /a，但它是"当前"）
    s = openTab(s, tab('/a'), 9000, 3);
    s = openTab(s, tab('/c'), 9500, 3);
    assert.deepEqual(keysOf(s), [HOME_TAB_KEY, '/a', '/c'], '应淘汰最久未激活的 /b');
  });

  it('淘汰优先让路给编辑器标签：宁可淘汰菜单页，也不丢正在编辑的页面', () => {
    const editor = editorTabKey('/a', '1');
    let s = openAll(['/a', '/b'], 4);
    s = openTab(s, tab(editor, '编辑'), 3000, 4);
    s = openTab(s, tab('/a'), 9000, 4); // /a 激活
    s = openTab(s, tab('/c'), 9500, 4); // 超限 → 应淘汰 /b 而不是编辑器标签
    assert.ok(keysOf(s).includes(editor), '编辑器标签不该被淘汰');
    assert.equal(keysOf(s).includes('/b'), false);
  });

  it('上限内全是编辑器标签时放弃淘汰（宁可超限也不丢编辑中的页面）', () => {
    const e1 = editorTabKey('/a', '1');
    const e2 = editorTabKey('/a', '2');
    let s = openTab(emptyTabs(), tab(e1, '编辑1'), 1000, 2);
    s = openTab(s, tab(e2, '编辑2'), 2000, 2);
    assert.deepEqual(keysOf(s), [HOME_TAB_KEY, e1, e2]);
  });
});

describe('多页签：关闭', () => {
  const base = () => openAll(['/a', '/b', '/c']);

  it('关当前标签：落到右邻；没有右邻落到左邻', () => {
    const s = base();
    assert.equal(closeTab(s, '/b', '/b').activate, '/c');
    assert.equal(closeTab(s, '/c', '/c').activate, '/b');
  });

  it('关非当前标签：不改落点', () => {
    const s = base();
    assert.equal(closeTab(s, '/a', '/c').activate, null);
    assert.deepEqual(keysOf(closeTab(s, '/a', '/c').state), [HOME_TAB_KEY, '/b', '/c']);
  });

  it('首页标签不可关闭；关不存在的键也不报错', () => {
    const s = base();
    assert.deepEqual(keysOf(closeTab(s, HOME_TAB_KEY, HOME_TAB_KEY).state), keysOf(s));
    assert.equal(closeTab(s, HOME_TAB_KEY, HOME_TAB_KEY).activate, null);
    assert.deepEqual(keysOf(closeTab(s, '/nope', '/a').state), keysOf(s));
  });

  it('关掉最后一个可关闭标签时回到首页（不会出现空内容区）', () => {
    const s = openAll(['/a']);
    const r = closeTab(s, '/a', '/a');
    assert.deepEqual(keysOf(r.state), [HOME_TAB_KEY]);
    assert.equal(r.activate, HOME_TAB_KEY);
  });

  it('关闭其他：留下被右键的标签（它若是当前标签则无需跳转）', () => {
    const s = base();
    const r1 = closeOthers(s, '/b', '/a');
    assert.deepEqual(keysOf(r1.state), [HOME_TAB_KEY, '/b']);
    assert.equal(r1.activate, '/b', '关掉当前标签后应跳到被右键的那个');
    assert.equal(closeOthers(s, '/b', '/b').activate, null);
  });

  it('关闭全部：只留首页，并把当前标签拉回首页', () => {
    const s = base();
    const r = closeAll(s, '/b');
    assert.deepEqual(keysOf(r.state), [HOME_TAB_KEY]);
    assert.equal(r.activate, HOME_TAB_KEY);
    // 当前已在首页时不必跳
    assert.equal(closeAll(s, HOME_TAB_KEY).activate, null);
  });

  it('关闭左侧 / 右侧：固定标签留在原位，当前标签被关掉时落到右键的那个', () => {
    const s = base();
    assert.deepEqual(keysOf(closeSide(s, '/c', '/a', 'left').state), [HOME_TAB_KEY, '/c']);
    assert.equal(closeSide(s, '/c', '/a', 'left').activate, '/c');
    assert.deepEqual(keysOf(closeSide(s, '/a', '/c', 'right').state), [HOME_TAB_KEY, '/a']);
    assert.equal(closeSide(s, '/a', '/c', 'right').activate, '/a');
    // 当前标签没事就不用跳
    assert.equal(closeSide(s, '/b', '/a', 'right').activate, null);
    // 当前标签落在被关的一侧 → 必须跳到右键的那个（否则内容区会停在已关掉的页面上）
    assert.equal(closeSide(s, '/a', '/b', 'right').activate, '/a');
    // 没有可关的返回原状态
    const only = openAll(['/a']);
    assert.equal(closeSide(only, '/a', '/a', 'left').state, only);
  });

  it('关闭会连带清掉 lastActive（否则淘汰顺序会被已关标签的历史污染）', () => {
    const s = base();
    const r = closeTab(s, '/a', '/c');
    assert.equal('/a' in r.state.lastActive, false);
  });
});

describe('多页签：刷新与改名', () => {
  it('刷新只动目标标签的 version', () => {
    let s = openAll(['/a', '/b']);
    s = refreshTab(s, '/a');
    assert.equal(s.tabs.find((t) => t.key === '/a')?.version, 1);
    assert.equal(s.tabs.find((t) => t.key === '/b')?.version, 0);
    assert.equal(refreshTab(s, '/nope'), s, '刷新不存在的标签应原样返回（引用不变）');
  });

  it('改名对空标题与相同标题直接返回原引用（避免多余渲染）', () => {
    const s = openAll(['/a']);
    assert.equal(retitleTab(s, '/a', ''), s);
    assert.equal(retitleTab(s, '/a', '标签/a'), s);
    assert.equal(retitleTab(s, '/a', '新名字').tabs.find((t) => t.key === '/a')?.title, '新名字');
  });
});

describe('多页签：持久化', () => {
  it('序列化跳过编辑器标签（未保存内容无法恢复，恢复一个空编辑器比不恢复更糟）', () => {
    const editor = editorTabKey('/a', '7');
    let s = openAll(['/a', '/b']);
    s = openTab(s, tab(editor, '编辑合同'), 3000);
    const persisted = serializeTabs(s);
    assert.deepEqual(
      persisted.tabs.map((t) => t.key),
      [HOME_TAB_KEY, '/a', '/b'],
    );
  });

  it('反序列化能容忍各种脏数据，且保证首页标签存在且在首位', () => {
    assert.deepEqual(keysOf(deserializeTabs(null)), [HOME_TAB_KEY]);
    assert.deepEqual(keysOf(deserializeTabs('nonsense')), [HOME_TAB_KEY]);
    assert.deepEqual(keysOf(deserializeTabs({ tabs: 'not-an-array' })), [HOME_TAB_KEY]);
    assert.deepEqual(keysOf(deserializeTabs({ tabs: [null, 1, {}, { key: '/x' }] })), [HOME_TAB_KEY]);
    // 脏数据里混进编辑器标签 / 首页标签 / 重复项：一概不恢复
    const dirty = deserializeTabs({
      tabs: [{ key: HOME_TAB_KEY, path: HOME_TAB_KEY, href: HOME_TAB_KEY, title: '篡改' }, { key: '/x', path: '/x', href: '/x' }, { key: '/x', path: '/x', href: '/x' }, { key: '/y?editor=1', path: '/y', href: '/y?editor=1' }],
    });
    assert.deepEqual(keysOf(dirty), [HOME_TAB_KEY, '/x']);
    assert.equal(dirty.tabs[0].title, '工作台');
  });

  it('往返一致：序列化 → 反序列化后标签键与标题保持，version 归零', () => {
    let s = openAll(['/a', '/b']);
    s = refreshTab(s, '/b');
    s = retitleTab(s, '/b', '改过的标题');
    const round = deserializeTabs(serializeTabs(s));
    assert.deepEqual(keysOf(round), [HOME_TAB_KEY, '/a', '/b']);
    assert.equal(round.tabs[2].title, '改过的标题');
    assert.deepEqual(round.tabs.map((t) => t.version), [0, 0, 0]);
    assert.deepEqual(round.lastActive, {});
  });

  it('icon 字段：打开时写入、往返保留、脏数据缺省不报错', () => {
    // 首页标签带工作台图标
    assert.equal(emptyTabs().tabs[0].icon, 'DashboardOutlined');
    let s = openTab(emptyTabs(), { ...tab('/a'), icon: 'BookOutlined' }, 1000);
    assert.equal(s.tabs.find((t) => t.key === '/a')?.icon, 'BookOutlined');
    // 重复打开不丢 icon（BasicLayout 每次路由变化都会 syncRoute 同一 icon）
    s = openTab(s, { ...tab('/a'), icon: 'BookOutlined' }, 2000);
    assert.equal(s.tabs.find((t) => t.key === '/a')?.icon, 'BookOutlined');
    // 往返保留
    const round = deserializeTabs(serializeTabs(s));
    assert.equal(round.tabs.find((t) => t.key === '/a')?.icon, 'BookOutlined');
    // 脏数据：无 icon 字段的旧缓存照常恢复
    const legacy = deserializeTabs({ tabs: [{ key: '/x', path: '/x', href: '/x', title: 'X' }] });
    assert.equal(legacy.tabs.find((t) => t.key === '/x')?.icon, undefined);
  });
});
