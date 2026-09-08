import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * 通用列表查询 hook：分页 + 筛选 + 重载
 *
 * 注意：调用方通常以内联箭头函数传入 fetcher（如 useTable((p) => api.list(p))），
 * 每次渲染都会产生新的函数引用。因此这里用 ref 持有最新的 fetcher / params，
 * 让 reload 保持稳定引用，仅在 params 变化时重新查询，避免「渲染→请求→渲染」的死循环。
 */
export function useTable<T = any>(fetcher: (params: any) => Promise<any>, defaultParams: any = {}) {
  const [loading, setLoading] = useState(false);
  const [list, setList] = useState<T[]>([]);
  const [total, setTotal] = useState(0);
  const [params, setParams] = useState<any>({ page: 1, pageSize: 20, ...defaultParams });

  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;
  const paramsRef = useRef(params);
  paramsRef.current = params;
  /** 请求序号，丢弃过期响应，防止快速翻页时旧结果覆盖新结果 */
  const seqRef = useRef(0);

  const reload = useCallback(async () => {
    const seq = ++seqRef.current;
    setLoading(true);
    try {
      const res: any = await fetcherRef.current(paramsRef.current);
      if (seq !== seqRef.current) return;
      setList(res?.list || []);
      setTotal(res?.total || 0);
    } catch {
      // 错误已由 http 拦截器统一提示，这里仅避免未捕获的 rejection
      if (seq === seqRef.current) {
        setList([]);
        setTotal(0);
      }
    } finally {
      if (seq === seqRef.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    reload();
  }, [reload, params]);

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
