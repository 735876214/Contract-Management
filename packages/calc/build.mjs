#!/usr/bin/env node
/**
 * **packages/calc 的构建**：`src/*.ts` → 包根 `*.js` + `*.d.ts`（扁平产物）。
 *
 * 为什么要构建而不是直接让消费方 import 源码 `.ts`（2026-11-23 P3，源码事实）：
 * - `server` 的 tsc 没有 `rootDir`，`include` 只有 `src/`+`prisma/`，产物布局是 `dist/src/main.js`
 *   （`start:prod = node dist/src/main`）。一旦 import `src/` 之外的 `.ts`，tsc 把公共根提到仓库根，
 *   产物变成 `dist/server/src/main.js`，启动路径、Dockerfile、start.sh 全要跟着改；
 * - 反过来，包自带 `*.d.ts` + `*.js` 就能被四种消费方同时吃下：server 的 tsc（node10 解析读包根）。
 *   、ts-node（test:int）、Node 原生 `.mts`（读 package.json 的 exports）、vite（走 node_modules）。
 *
 * 编译器优先用**调用方已装的 typescript**：本仓 CI 是三个 job 各自 `npm ci`，
 * 给这个包再装一份 typescript 只会多两次安装与两个锁文件。
 *
 * 产物**入库**（18 个 .js/.d.ts），理由：消费方有 4 种（server tsc / ts-node / Node 原生 .mts / vite）
 * 已有产物且比源码新时直接跳过（本地 `npm test` 不重复编译）。
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, statSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(HERE, 'src');

if (process.argv.includes("--clean")) {
  for (const f of readdirSync(HERE)) {
    if (f.endsWith('.js') || f.endsWith('.d.ts')) rmSync(path.join(HERE, f), { force: true });
  }
  console.log('[calc] 已清理产物');
  process.exit(0);
}

/** tsc 候选：调用方（server/web）的 node_modules 优先，最后回落到包自己的 */
const tscCandidates = [
  path.join(process.cwd(), 'node_modules/typescript/bin/tsc'),
  path.join(HERE, '../../server/node_modules/typescript/bin/tsc'),
  path.join(HERE, '../../web/node_modules/typescript/bin/tsc'),
  path.join(HERE, 'node_modules/typescript/bin/tsc'),
];
const tsc = tscCandidates.find((p) => existsSync(p));

/** 产物是否齐全且比源码新（快路径：本地反复跑 npm test 不必每次编译） */
const srcFiles = readdirSync(SRC).filter((f) => f.endsWith(".ts"));
const newestSrc = Math.max(...srcFiles.map((f) => statSync(path.join(SRC, f)).mtimeMs));
const stale = srcFiles.some((f) => {
  const out = path.join(HERE, f.replace(/\.ts$/, '.js'));
  return !existsSync(out) || statSync(out).mtimeMs < newestSrc;
});
const force = process.argv.includes('--force');
if (!stale && !force) {
  console.log('[calc] 产物已是最新，跳过编译');
  process.exit(0);
}

if (!tsc) {
  console.error('[calc] 找不到 typescript：请在 server/ 或 web/ 里先 npm ci ——' +
    '本仓不为共享包单独装依赖（CI 三个 job 各自安装）。已查找：\n  ' + tscCandidates.join('\n  '));
  process.exit(2);
}

execFileSync(process.execPath, [tsc, '-p', path.join(HERE, 'tsconfig.json')], { stdio: 'inherit' });
console.log('[calc] 编译完成 → packages/calc/*.js + *.d.ts');
