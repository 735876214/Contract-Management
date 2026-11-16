import test from 'node:test';
import assert from 'node:assert/strict';
import {
  collectionFontCount,
  extractFontFromCollection,
  hasCffOutlines,
  hasGlyfOutlines,
  isFontCollection,
  sfntTableTags,
} from '../src/modules/ai/ttc-font.ts';

/**
 * 合成一个最小 TTC：1 个字体、2 张表（'head' 8 字节、'cmap' 5 字节），
 * 表数据从 64 开始连续摆放。字段布局按 TTC v1 规范手写，用来验证提取逻辑本身，
 * 不依赖机器上装了什么字体（CI 里没有 macOS 字体）。
 */
function syntheticTtc(): Uint8Array {
  const buf = new Uint8Array(80);
  const dv = new DataView(buf.buffer);
  dv.setUint32(0, 0x74746366, false); // 'ttcf'
  dv.setUint32(4, 0x00010000, false); // version 1.0
  dv.setUint32(8, 1, false); // numFonts
  dv.setUint32(12, 20, false); // offset[0] = 20
  // 字体目录（20 起）：sfnt 版本 + 表数量 2 + 三个搜索参数
  dv.setUint32(20, 0x00010000, false);
  dv.setUint16(24, 2, false);
  dv.setUint16(26, 16, false);
  dv.setUint16(28, 0, false);
  dv.setUint16(30, 0, false);
  // 表记录 1：head @64 len 8
  dv.setUint32(32, 0x68656164, false); // 'head'
  dv.setUint32(36, 0x11111111, false); // checksum
  dv.setUint32(40, 64, false); // 绝对偏移
  dv.setUint32(44, 8, false);
  // 表记录 2：cmap @72 len 5
  dv.setUint32(48, 0x636d6170, false); // 'cmap'
  dv.setUint32(52, 0x22222222, false);
  dv.setUint32(56, 72, false);
  dv.setUint32(60, 5, false);
  buf.fill(0xaa, 64, 72);
  buf.fill(0xbb, 72, 77);
  return buf;
}

test('isFontCollection / collectionFontCount：认 ttcf 头，普通 TTF 不算', () => {
  const ttc = syntheticTtc();
  assert.equal(isFontCollection(ttc), true);
  assert.equal(collectionFontCount(ttc), 1);
  // 真 TTF 的 sfnt 版本号（0x00010000）不是 ttcf
  assert.equal(isFontCollection(new Uint8Array([0, 1, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0])), false);
  assert.equal(isFontCollection(new Uint8Array(4)), false);
  assert.equal(collectionFontCount(new Uint8Array(20)), 0);
});

test('extractFontFromCollection：拆出单字体，表头与数据按新偏移重排', () => {
  const out = extractFontFromCollection(syntheticTtc(), 0);
  const dv = new DataView(out.buffer, out.byteOffset, out.byteLength);
  // 13 字节头部 + 2×16 表记录 = 44，再放两张表（第二张含 3 字节对齐补齐）
  assert.equal(out.length, 60);
  assert.equal(dv.getUint32(0, false), 0x00010000); // sfnt 版本
  assert.equal(dv.getUint16(4, false), 2); // 表数量
  // 表 1
  assert.equal(dv.getUint32(12, false), 0x68656164);
  assert.equal(dv.getUint32(16, false), 0x11111111); // checksum 原样保留
  assert.equal(dv.getUint32(20, false), 44); // 新偏移
  assert.equal(dv.getUint32(24, false), 8);
  // 表 2（偏移对齐到 4 字节，44+8=52 已对齐）
  assert.equal(dv.getUint32(28, false), 0x636d6170);
  assert.equal(dv.getUint32(36, false), 52);
  assert.equal(dv.getUint32(40, false), 5);
  // 数据完整搬过来
  assert.deepEqual([...out.subarray(44, 52)], Array(8).fill(0xaa));
  assert.deepEqual([...out.subarray(52, 57)], Array(5).fill(0xbb));
});

test('extractFontFromCollection：非 TTC 与越界序号都抛错', () => {
  assert.throws(() => extractFontFromCollection(new Uint8Array(40)), /不是 TTC/);
  assert.throws(() => extractFontFromCollection(syntheticTtc(), 1), /越界/);
  assert.throws(() => extractFontFromCollection(syntheticTtc(), -1), /越界/);
});

test('extractFontFromCollection：表数据越界时报错而不是静默截断', () => {
  const broken = syntheticTtc();
  new DataView(broken.buffer).setUint32(44, 99, false); // head 表长度超出文件
  assert.throws(() => extractFontFromCollection(broken, 0), /表数据越界/);
});

/** 合成一个只有表目录的 sfnt（表数据不需要，测标签解析与轮廓判定用） */
function syntheticSfnt(tags: string[]): Uint8Array {
  const buf = new Uint8Array(12 + tags.length * 16);
  const dv = new DataView(buf.buffer);
  dv.setUint32(0, 0x00010000, false);
  dv.setUint16(4, tags.length, false);
  tags.forEach((tag, i) => {
    const base = 12 + i * 16;
    for (let j = 0; j < 4; j += 1) buf[base + j] = tag.charCodeAt(j);
  });
  return buf;
}

test('sfntTableTags：读出表标签（含 "CFF " 的尾随空格）', () => {
  assert.deepEqual(sfntTableTags(syntheticSfnt(['head', 'glyf', 'loca'])), ['head', 'glyf', 'loca']);
  assert.deepEqual(sfntTableTags(syntheticSfnt(['CFF '])), ['CFF ']);
  assert.deepEqual(sfntTableTags(new Uint8Array(4)), []);
  // 表数量谎报成超大值时不越界读
  const broken = syntheticSfnt(['head']);
  new DataView(broken.buffer).setUint16(4, 999, false);
  assert.deepEqual(sfntTableTags(broken), []);
});

test('hasGlyfOutlines / hasCffOutlines：区分 TrueType 与 CFF 轮廓', () => {
  // pdf-lib 只能正确嵌 glyf 字体；CFF（Noto CJK / 思源）会渲染成乱码，必须靠这个判据排除
  assert.equal(hasGlyfOutlines(syntheticSfnt(['head', 'glyf', 'loca'])), true);
  assert.equal(hasCffOutlines(syntheticSfnt(['head', 'glyf', 'loca'])), false);
  assert.equal(hasGlyfOutlines(syntheticSfnt(['head', 'CFF ', 'cmap'])), false);
  assert.equal(hasCffOutlines(syntheticSfnt(['head', 'CFF ', 'cmap'])), true);
  assert.equal(hasGlyfOutlines(new Uint8Array(0)), false);
});
