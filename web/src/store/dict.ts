import { create } from 'zustand';
import { dictApi, DictOption } from '@/api/dict';

interface DictState {
  cache: Record<string, DictOption[]>;
  nameMap: Record<string, Record<string, string>>;
  ensure: (typeCode: string | string[]) => Promise<void>;
  options: (typeCode: string, extValue?: string) => DictOption[];
  label: (typeCode: string, value?: string) => string;
  invalidate: (typeCode?: string) => void;
}

export const useDictStore = create<DictState>((set, get) => ({
  cache: {},
  nameMap: {},

  ensure: async (typeCode) => {
    const codes = (Array.isArray(typeCode) ? typeCode : [typeCode]).filter(Boolean);
    const missing = codes.filter((c) => !get().cache[c]);
    if (!missing.length) return;
    const res = await dictApi.optionsBatch(missing);
    const cache = { ...get().cache };
    const nameMap = { ...get().nameMap };
    Object.entries(res || {}).forEach(([code, items]) => {
      cache[code] = items;
      nameMap[code] = (items as DictOption[]).reduce((acc: any, i) => {
        acc[i.value] = i.label;
        return acc;
      }, {});
    });
    set({ cache, nameMap });
  },

  options: (typeCode, extValue) => {
    const list = get().cache[typeCode] || [];
    if (extValue) return list.filter((i) => !i.extField1 || i.extField1 === extValue);
    return list;
  },

  label: (typeCode, value) => {
    if (!value) return '-';
    return get().nameMap[typeCode]?.[value] || value;
  },

  invalidate: (typeCode) => {
    if (!typeCode) {
      set({ cache: {}, nameMap: {} });
      return;
    }
    const cache = { ...get().cache };
    const nameMap = { ...get().nameMap };
    delete cache[typeCode];
    delete nameMap[typeCode];
    set({ cache, nameMap });
  },
}));
