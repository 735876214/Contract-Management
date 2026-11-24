#!/usr/bin/env node
/**
 * **把《物资结算书》xlsx 模板编码成 TS 常量**（`final-settlement-template.ts`）。
 *
 * 为什么要 base64 内嵌：`nest build` 只搬 `dist`，Docker 运行层也只带构建产物，
 * 外部资源文件在镜像里不一定在同一个相对位置；内嵌后「构建产物就是模板」，没有寻址问题。
 *
 * 为什么要折行（2026-11-24 审计 P3）：原来是**单行 72 KB**，diff/blame 直接不可读
 * ——看这行等于看二进制。现在按 CHUNK 字符拼接，语义完全一样，但能定位、能 review。
 *
 * 用法（在 server/ 下）：`node scripts/encode-settlement-template.mjs`
 * 改了 xlsx 就重跑本脚本，**不要手改**生成的 .ts。
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MODULE_DIR = path.join(HERE, '..', 'src', 'modules', 'final-settlement');
const XLSX = path.join(MODULE_DIR, 'assets', 'final-settlement-template.xlsx');
const OUT = path.join(MODULE_DIR, 'final-settlement-template.ts');

/** 每行长度：够短便于 diff / blame，又不至于把文件撑到几千行 */
const CHUNK = 1000;

const HEADER = `/**
 * AUTO-GENERATED — 请勿手改（生成器：\`server/scripts/encode-settlement-template.mjs\`）。
 * 源文件：./assets/final-settlement-template.xlsx（《物资结算书》5-sheet 模板：36 行明细槽位行 8..43，合计行 44，审减行 47；含 4 枚 logo/图章）。
 * 以 base64 内嵌，确保 nest build / Docker 打包后无需依赖外部资源文件即可渲染。
 * 更新流程：改 assets 下 xlsx → 在 server/ 下跑 \`node scripts/encode-settlement-template.mjs\`（勿手改本文件）。
 * 排版：按 ${CHUNK} 字符折行拼接 —— 内容与单行完全等价，只为让 diff/blame 可读。
 */
`;

const b64 = readFileSync(XLSX).toString('base64');
const chunks = [];
for (let i = 0; i < b64.length; i += CHUNK) chunks.push(b64.slice(i, i + CHUNK));

const body = chunks.map((c) => `  '${c}'`).join(' +\n');
writeFileSync(OUT, `${HEADER}export const FINAL_SETTLEMENT_TEMPLATE_BASE64 =\n${body};\n`, 'utf8');
console.log(`[template] ${path.basename(XLSX)} → ${path.basename(OUT)}：base64 ${b64.length} 字符，${chunks.length} 行`);
