import http from './http';

export interface DictOption {
  value: string;
  label: string;
  color?: string;
  extField1?: string;
}

export const dictApi = {
  types: (params?: any) => http.get('/dict/types', { params }),
  createType: (data: any) => http.post('/dict/types', data),
  updateType: (id: string, data: any) => http.put(`/dict/types/${id}`, data),
  removeType: (id: string) => http.delete(`/dict/types/${id}`),
  items: (params?: any) => http.get('/dict/items', { params }),
  options: (typeCode: string, extValue?: string) =>
    http.get<any, DictOption[]>(`/dict/options/${typeCode}`, { params: { extValue } }),
  optionsBatch: (types: string[]) => http.get<any, Record<string, DictOption[]>>('/dict/options', { params: { types: types.join(',') } }),
  createItem: (data: any) => http.post('/dict/items', data),
  updateItem: (id: string, data: any) => http.put(`/dict/items/${id}`, data),
  removeItem: (id: string) => http.delete(`/dict/items/${id}`),
  toggleItem: (id: string) => http.post(`/dict/items/${id}/toggle`),
  sortItems: (typeCode: string, ids: string[]) => http.post('/dict/items/sort', { typeCode, ids }),
  usage: (id: string) => http.get(`/dict/items/usage/${id}`),
  refreshCache: (typeCode?: string) => http.post('/dict/cache/refresh', { typeCode }),
  exportUrl: (typeCode: string) => `${http.defaults.baseURL}/dict/export?typeCode=${typeCode}`,
  importUrl: (typeCode: string) => `${http.defaults.baseURL}/dict/import?typeCode=${typeCode}`,
};
