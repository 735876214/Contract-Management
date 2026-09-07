import { useTable } from './useTable';

export default function useTablePage<T = any>(fetcher: (params: any) => Promise<any>, defaultParams: any = {}) {
  return useTable<T>(fetcher, defaultParams);
}
