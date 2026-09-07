import { useCallback, useEffect, useState } from 'react';

/** 通用列表查询 hook：分页 + 筛选 + 重载 */
export function useTable<T = any>(fetcher: (params: any) => Promise<any>, defaultParams: any = {}) {
  const [loading, setLoading] = useState(false);
  const [list, setList] = useState<T[]>([]);
  const [total, setTotal] = useState(0);
  const [params, setParams] = useState<any>({ page: 1, pageSize: 20, ...defaultParams });

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      const res: any = await fetcher(params);
      setList(res?.list || []);
      setTotal(res?.total || 0);
    } finally {
      setLoading(false);
    }
  }, [fetcher, params]);

  useEffect(() => {
    reload();
  }, [reload]);

  const search = (extra: any = {}) => setParams((p: any) => ({ ...p, ...extra, page: 1 }));

  return {
    loading,
    list,
    total,
    params,
    setParams,
    search,
    reload,
    pagination: {
      current: params.page,
      pageSize: params.pageSize,
      total,
      showSizeChanger: true,
      showTotal: (t: number) => `共 ${t} 条`,
      onChange: (page: number, pageSize: number) => setParams((p: any) => ({ ...p, page, pageSize })),
    },
  };
}
