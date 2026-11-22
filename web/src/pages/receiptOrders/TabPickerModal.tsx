import { useCallback, useEffect, useState } from 'react';
import { Input, Modal, Table, Tabs } from 'antd';

/**
 * Tab 名称选择弹窗（供应单位 / 领用单位；需求 2.4.4 / 2.4.5）。
 * 每次切换 Tab 或输入关键词回车都会重新拉取对应数据源。
 */
interface TabPickerProps {
  open: boolean;
  title: string;
  tabs: { key: string; label: string }[];
  defaultTab: string;
  loading?: boolean;
  onCancel: () => void;
  /** 按 Tab 拉取数据源；keyword 为空表示不筛选 */
  onLoad: (tab: string, keyword: string) => Promise<any[]>;
  onPick: (row: any, tab: string) => void;
  /** 各行展示的列（可随 Tab 不同而变化） */
  columnsFor: (tab: string) => any[];
}

/**
 * 查询弹窗：Tab 标签页切换数据源（需求 2.4.4 / 2.4.5）
 * 每次切换 Tab 或输入关键词回车都会重新拉取对应数据源。
 */
function TabPickerModal({
  open, title, tabs, defaultTab, loading, onCancel, onLoad, onPick, columnsFor,
}: TabPickerProps) {
  const [tab, setTab] = useState(defaultTab);
  const [keyword, setKeyword] = useState('');
  const [rows, setRows] = useState<any[]>([]);
  const [innerLoading, setInnerLoading] = useState(false);

  const fetchRows = useCallback(
    async (t: string, kw: string) => {
      setInnerLoading(true);
      try {
        setRows((await onLoad(t, kw)) || []);
      } catch {
        setRows([]);
      } finally {
        setInnerLoading(false);
      }
    },
    [onLoad],
  );

  // 打开时复位到默认 Tab 并加载
  useEffect(() => {
    if (!open) return;
    setTab(defaultTab);
    setKeyword('');
    fetchRows(defaultTab, '');
  }, [open, defaultTab, fetchRows]);

  return (
    <Modal title={title} open={open} onCancel={onCancel} footer={null} width={860} destroyOnHidden>
      <Tabs
        activeKey={tab}
        items={tabs.map((t) => ({ key: t.key, label: t.label }))}
        onChange={(k) => {
          setTab(k);
          setKeyword('');
          fetchRows(k, '');
        }}
      />
      <Input.Search
        placeholder="输入名称关键词后回车检索"
        allowClear
        enterButton
        value={keyword}
        onChange={(e) => setKeyword(e.target.value)}
        onSearch={(v) => fetchRows(tab, v)}
        style={{ marginBottom: 12 }}
      />
      <Table
      scroll={{ x: 'max-content' }}
        rowKey={(r: any) => `${tab}-${r.id}`}
        size="small"
        loading={loading || innerLoading}
        dataSource={rows}
        pagination={{ pageSize: 8, showTotal: (t) => `共 ${t} 条` }}
        onRow={(record) => ({ onClick: () => onPick(record, tab), style: { cursor: 'pointer' } })}
        columns={columnsFor(tab)}
        locale={{ emptyText: '该分类下暂无数据' }}
      />
    </Modal>
  );
}
export default TabPickerModal;
