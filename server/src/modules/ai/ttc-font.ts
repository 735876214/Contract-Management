/**
 * TTC（TrueType Collection）→ 单字体 TTF 提取（**零依赖纯函数，只吃 ArrayBuffer**）。
 *
 * 为什么需要：服务器上最省事的中文字体来源（`fonts-noto-cjk` / `wqy-zenhei`）都是 `.ttc`，
 * 而 pdf-lib 只能嵌单一字体文件（TTC 会报 `createSubset is not a function`）。
 * 与其一堆文档让人手工 `fonttools` 转换，不如在内存里把选中的那一支拆出来：
 * TTC 里每个字体的表目录只记录「表数据在文件中的绝对偏移」，把用到的表按新偏移
 * 连续复制出来就是一份合法的单字体 sfnt。
 */

const TTC_TAG = 0x74746366; // 'ttcf'

/** 判断字节流是不是 TTC */
export function isFontCollection(bytes: Uint8Array): boolean {
  if (!bytes || bytes.length < 12) return false;
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(0, false) === TTC_TAG;
}

/** TTC 里的字体数量（非 TTC 返回 0） */
export function collectionFontCount(bytes: Uint8Array): number {
  if (!isFontCollection(bytes)) return 0;
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(8, false);
}

const align4 = (n: number): number => (n + 3) & ~3;

/** 读 sfnt 表目录里的表标签（4 字符，含尾随空格时保留），非 sfnt 返回空数组 */
export function sfntTableTags(bytes: Uint8Array): string[] {
  if (!bytes || bytes.length < 12) return [];
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const numTables = dv.getUint16(4, false);
  if (!numTables || 12 + numTables * 16 > bytes.length) return [];
  const tags: string[] = [];
  for (let i = 0; i < numTables; i += 1) {
    const base = 12 + i * 16;
    let tag = '';
    for (let j = 0; j < 4; j += 1) tag += String.fromCharCode(bytes[base + j]);
    tags.push(tag);
  }
  return tags;
}

/**
 * 只有 TrueType（`glyf` 轮廓）字体能被 pdf-lib 正确嵌入。
 * **CFF / CID-keyed CFF（`CFF `，Noto CJK、苹方、Hiragino、思源都是）实测会渲染成乱码**
 * ——pdf-lib 的子集化对 CID-keyed CFF 支持有缺陷，不是我们的 bug。
 * 所以字体探测阶段要把 CFF 直接排除，宁可报「没装可用中文字体」也不给用户一份乱码 PDF。
 */
export function hasGlyfOutlines(bytes: Uint8Array): boolean {
  return sfntTableTags(bytes).includes('glyf');
}

export function hasCffOutlines(bytes: Uint8Array): boolean {
  return sfntTableTags(bytes).includes('CFF ');
}

/**
 * 取出 TTC 中第 `index` 个字体，返回独立的 sfnt 字节。
 * 参数非法（不是 TTC / 越界 / 表越界）一律抛错——调用方会换下一个候选字体或报「没有可用中文字体」。
 */
export function extractFontFromCollection(bytes: Uint8Array, index = 0): Uint8Array {
  if (!isFontCollection(bytes)) throw new Error('不是 TTC 字体集合');
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const count = dv.getUint32(8, false);
  if (index < 0 || index >= count) throw new Error(`TTC 字体序号越界：${index}/${count}`);

  const fontOffset = dv.getUint32(12 + index * 4, false);
  if (fontOffset + 12 > bytes.length) throw new Error('TTC 字体目录越界');

  const numTables = dv.getUint16(fontOffset + 4, false);
  if (!numTables) throw new Error('TTC 字体没有任何表');

  const headerSize = 12 + numTables * 16;
  // 先算出每张表在新文件里的位置（头部之后逐张对齐）
  const records: { tag: number; checksum: number; offset: number; length: number; newOffset: number }[] = [];
  let cursor = headerSize;
  for (let i = 0; i < numTables; i += 1) {
    const base = fontOffset + 12 + i * 16;
    if (base + 16 > bytes.length) throw new Error('TTC 表记录越界');
    const tag = dv.getUint32(base, false);
    const checksum = dv.getUint32(base + 4, false);
    const offset = dv.getUint32(base + 8, false);
    const length = dv.getUint32(base + 12, false);
    if (offset + length > bytes.length) throw new Error('TTC 表数据越界');
    records.push({ tag, checksum, offset, length, newOffset: cursor });
    cursor = align4(cursor + length);
  }

  const out = new Uint8Array(cursor);
  const odv = new DataView(out.buffer);
  // sfnt 头：版本 + 表数量 + 二分查找参数（沿用原值即可，字体渲染不依赖它们）
  odv.setUint32(0, dv.getUint32(fontOffset, false), false);
  odv.setUint16(4, numTables, false);
  odv.setUint16(6, dv.getUint16(fontOffset + 6, false), false);
  odv.setUint16(8, dv.getUint16(fontOffset + 8, false), false);
  odv.setUint16(10, dv.getUint16(fontOffset + 10, false), false);

  records.forEach((r, i) => {
    const base = 12 + i * 16;
    odv.setUint32(base, r.tag, false);
    odv.setUint32(base + 4, r.checksum, false);
    odv.setUint32(base + 8, r.newOffset, false);
    odv.setUint32(base + 12, r.length, false);
    out.set(bytes.subarray(r.offset, r.offset + r.length), r.newOffset);
  });

  return out;
}
