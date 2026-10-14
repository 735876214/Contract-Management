import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  LIST_COLUMNS_STORAGE_VERSION,
  browserColumnStorage,
  clearHiddenColumns,
  columnKeyOf,
  filterVisibleColumns,
  listColumnsStorageKey,
  nextHiddenColumns,
  readHiddenColumns,
  writeHiddenColumns,
} from '../../web/src/utils/listColumns.ts';

/**
 * 列表页「列显隐」偏好单测（批次 B：把台账的列设置范式推广到更多列表页）。
 *
 * 为什么值得测：这是**每浏览器**持久化的显示偏好（localStorage），写入失败/值损坏/键名漂移都会
 * 让用户「勾了没反应」或「列莫名消失」，而这类问题在页面上很难复现。
 * 纯逻辑放在 `web/src/utils/listColumns.ts`（无 React/DOM），此处直接吃它。
 */

/** 内存版 localStorage（无需 DOM） */
const fakeStorage = (init: Record<string, string> = {}) => {
  const map = new Map(Object.entries(init));
  return {
    map,
    getItem: (k: string) => (map.has(k) ? (map.get(k) as string) : null),
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
  };
};

describe('columnKeyOf：列标识', () => {
  it('优先 key，其次 dataIndex，都没有则空串（= 不可配置、始终显示）', () => {
    assert.equal(columnKeyOf({ key: 'a', dataIndex: 'b' }), 'a');
    assert.equal(columnKeyOf({ dataIndex: 'b' }), 'b');
    assert.equal(columnKeyOf({ key: 0 }), '0');
    assert.equal(columnKeyOf({}), '');
    assert.equal(columnKeyOf(null), '');
  });
});

describe('列配置的存储（localStorage）', () => {
  it('键名带前缀与版本号（改结构时递增版本即可让旧值失效）', () => {
    assert.equal(listColumnsStorageKey('invoice.list'), `cms.list-cols.invoice.list${LIST_COLUMNS_STORAGE_VERSION}`);
  });

  it('写入 → 读取 → 清除 往返一致；空集合直接删键（不残留 `{"hidden":[]}`）', () => {
    const s = fakeStorage();
    writeHiddenColumns(s, 'invoice.list', ['a', 'b']);
    assert.deepEqual(readHiddenColumns(s, 'invoice.list'), ['a', 'b']);
    writeHiddenColumns(s, 'invoice.list', []);
    assert.equal(s.getItem(listColumnsStorageKey('invoice.list')), null);
    assert.deepEqual(readHiddenColumns(s, 'invoice.list'), []);

    writeHiddenColumns(s, 'invoice.list', ['a']);
    clearHiddenColumns(s, 'invoice.list');
    assert.deepEqual(readHiddenColumns(s, 'invoice.list'), []);
  });

  it('兼容裸数组写法（早期/手写值），非字符串项被剔除', () => {
    const s = fakeStorage({ [listColumnsStorageKey('x')]: '["a",1,"",null,"b"]' });
    assert.deepEqual(readHiddenColumns(s, 'x'), ['a', 'b']);
  });

  it('值损坏 / 存储不可用 一律降级为「全部可见」且不抛错', () => {
    const broken = fakeStorage({ [listColumnsStorageKey('x')]: '{不是 JSON' });
    assert.deepEqual(readHiddenColumns(broken, 'x'), []);
    assert.deepEqual(readHiddenColumns(null, 'x'), []);
    assert.deepEqual(readHiddenColumns(fakeStorage(), ''), []);
    assert.doesNotThrow(() => writeHiddenColumns(null, 'x', ['a']));
    assert.doesNotThrow(() => clearHiddenColumns(undefined, 'x'));
  });

  it('存储写入抛错（隐私模式/配额满）被吞掉，不影响调用方', () => {
    const throwing = {
      getItem: () => null,
      setItem: () => {
        throw new Error('QuotaExceededError');
      },
      removeItem: () => {
        throw new Error('SecurityError');
      },
    };
    assert.doesNotThrow(() => writeHiddenColumns(throwing, 'x', ['a']));
    assert.doesNotThrow(() => clearHiddenColumns(throwing, 'x'));
  });

  it('非浏览器环境（无 localStorage）返回 null 而不是抛错', () => {
    assert.equal(browserColumnStorage(), null);
  });
});

describe('nextHiddenColumns：切换规则', () => {
  const all = ['moduleStatus', 'taskNo', 'content', 'op'];

  it('隐藏 / 取消隐藏', () => {
    assert.deepEqual(nextHiddenColumns([], 'content', true, all), ['content']);
    assert.deepEqual(nextHiddenColumns(['content'], 'content', false, all), []);
  });

  it('受保护列（操作列）不可隐藏', () => {
    assert.deepEqual(nextHiddenColumns([], 'op', true, all, ['op']), []);
  });

  it('**至少保留一列可见**：无受保护列时，隐藏最后一列被拒绝（避免只剩空表）', () => {
    const dataOnly = ['moduleStatus', 'taskNo', 'content'];
    // 已隐藏前两列 → 再隐藏 content 会让表格空掉 → 拒绝（返回原集合）
    assert.deepEqual(nextHiddenColumns(['moduleStatus', 'taskNo'], 'content', true, dataOnly), ['moduleStatus', 'taskNo']);
    // 还剩两列可见时放行
    assert.deepEqual(nextHiddenColumns(['moduleStatus'], 'taskNo', true, dataOnly), ['moduleStatus', 'taskNo']);
  });

  it('存在受保护列（操作列）时不触发该限制——表格永远不会空', () => {
    assert.deepEqual(nextHiddenColumns(['moduleStatus', 'taskNo'], 'content', true, all, ['op']), [
      'moduleStatus',
      'taskNo',
      'content',
    ]);
  });

  it('未知列 / 空键 不写入（防止陈旧配置残留）', () => {
    assert.deepEqual(nextHiddenColumns(['content'], '已删除的列', true, all), ['content']);
    assert.deepEqual(nextHiddenColumns([], '', true, all), []);
  });

  it('剔除已不在表中的历史隐藏项（列被页面移除后不残留）', () => {
    assert.deepEqual(nextHiddenColumns(['老列', 'content'], 'taskNo', true, all), ['content', 'taskNo']);
  });
});

describe('filterVisibleColumns：列过滤', () => {
  const cols = [
    { title: '状态', key: 'moduleStatus' },
    { title: '采购编号', dataIndex: 'taskNo' },
    { title: '采购内容', key: 'content' },
    { title: '操作', key: 'op' },
    { title: '无标识列' },
  ];

  it('隐藏命中的列；无标识的列始终保留', () => {
    const out = filterVisibleColumns(cols, ['content']);
    assert.deepEqual(out.map(columnKeyOf), ['moduleStatus', 'taskNo', 'op', '']);
  });

  it('受保护列即使被写进隐藏集合也强制显示（防手改存储把操作列弄没）', () => {
    const out = filterVisibleColumns(cols, ['op', 'taskNo'], ['op']);
    assert.deepEqual(out.map(columnKeyOf), ['moduleStatus', 'content', 'op', '']);
  });

  it('空隐藏集合 / 空列数组 安全', () => {
    assert.equal(filterVisibleColumns(cols, []).length, cols.length);
    assert.deepEqual(filterVisibleColumns([], ['a']), []);
  });
});
