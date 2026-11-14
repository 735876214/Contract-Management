#!/usr/bin/env node
/**
 * 模块边界检查（秒级，无 DB）。
 *
 * 规则：
 * 1. 模块之间只允许通过公开入口 `<module>/index.ts` 互相引用；
 *    直接引另一个模块的 `.module.ts` / `.service.ts` 等内部文件 = 越界。
 * 2. `auth` 是横切基础设施（JWT / 权限守卫），按白名单允许深层引用。
 * 3. 模块级依赖图不允许出现循环（SCC > 1）。
 *
 * 背景：跨模块 import 曾全部指向 `<m>.module` / `<m>.service`，没有 DTO/类型，
 * 因此可以用一个入口文件收口；`archive` / `ai` 是刻意的聚合器（fan-out 大，但仍须走入口）。
 *
 * 用法：node scripts/check-module-boundaries.mjs [--quiet]
 * 退出码：0 通过 / 1 有越界或环 / 2 环境错误
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const quiet = process.argv.includes('--quiet');

/** 横切基础设施：允许任何模块深层引用（守卫/装饰器） */
const INFRA_MODULES = new Set(['auth']);

/** fan-out 超过该值的模块会在输出里标为聚合器（仅供参考，不是错误） */
const AGGREGATOR_FANOUT = 5;

let root;
try {
  root = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
} catch {
  console.error('[module-boundaries] 不在 git 仓库内');
  process.exit(2);
}

const tracked = execFileSync('git', ['ls-files'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  .split('\n')
  .filter(Boolean);
const trackedSet = new Set(tracked);

const MODULES_DIR = 'server/src/modules/';
const isTs = (f) => /\.(ts|tsx)$/.test(f) && !f.endsWith('.d.ts');
const moduleOf = (f) => (f.startsWith(MODULES_DIR) ? f.slice(MODULES_DIR.length).split('/')[0] : null);

const IMPORT_RE = /\bfrom\s+['"]([^'"]+)['"]|\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g;

function resolve(fromFile, spec) {
  if (!spec.startsWith('.')) return null;
  const base = path.posix.normalize(path.posix.join(path.posix.dirname(fromFile), spec));
  const candidates = [base + '.ts', base + '.tsx', base + '/index.ts', base + '/index.tsx'];
  for (const c of candidates) if (trackedSet.has(c)) return c;
  return null;
}

const files = tracked.filter((f) => f.startsWith(MODULES_DIR) && isTs(f) && !f.endsWith('/index.ts'));
const violations = [];
const edges = new Map(); // module -> Set<module>

for (const file of files) {
  const fromMod = moduleOf(file);
  if (!fromMod) continue;
  const src = readFileSync(path.join(root, file), 'utf8');
  for (const m of src.matchAll(IMPORT_RE)) {
    const spec = m[1] || m[2];
    const target = resolve(file, spec);
    if (!target) continue;
    const toMod = moduleOf(target);
    if (!toMod || toMod === fromMod) continue;

    if (!edges.has(fromMod)) edges.set(fromMod, new Set());
    edges.get(fromMod).add(toMod);

    if (INFRA_MODULES.has(toMod)) continue;
    const isPublicEntry = target === `${MODULES_DIR}${toMod}/index.ts`;
    if (!isPublicEntry) {
      violations.push({
        file,
        from: fromMod,
        to: toMod,
        target,
        spec,
        line: src.slice(0, m.index).split('\n').length,
      });
    }
  }
}

// 模块级循环检测（Tarjan SCC）
function findCycles(graph) {
  let index = 0;
  const stack = [];
  const onStack = new Set();
  const indices = new Map();
  const low = new Map();
  const sccs = [];
  const strongConnect = (v) => {
    indices.set(v, index);
    low.set(v, index);
    index++;
    stack.push(v);
    onStack.add(v);
    for (const w of graph.get(v) || []) {
      if (!indices.has(w)) {
        strongConnect(w);
        low.set(v, Math.min(low.get(v), low.get(w)));
      } else if (onStack.has(w)) {
        low.set(v, Math.min(low.get(v), indices.get(w)));
      }
    }
    if (low.get(v) === indices.get(v)) {
      const comp = [];
      let w;
      do {
        w = stack.pop();
        onStack.delete(w);
        comp.push(w);
      } while (w !== v);
      if (comp.length > 1) sccs.push(comp.sort());
    }
  };
  for (const v of graph.keys()) if (!indices.has(v)) strongConnect(v);
  return sccs;
}

const cycles = findCycles(edges);
const aggregators = [...edges]
  .filter(([, s]) => s.size > AGGREGATOR_FANOUT)
  .sort((a, b) => b[1].size - a[1].size);

if (!violations.length && !cycles.length) {
  if (!quiet) {
    const msg = [`[module-boundaries] OK：${files.length} 个模块内文件，无越界 import、无模块环`];
    if (aggregators.length) {
      msg.push(`  聚合器（fan-out > ${AGGREGATOR_FANOUT}，允许但请走公开入口）：` +
        aggregators.map(([m, s]) => `${m}(${s.size})`).join(', '));
    }
    console.log(msg.join('\n'));
  }
  process.exit(0);
}

if (cycles.length) {
  console.error('[module-boundaries] 模块级循环依赖：');
  for (const c of cycles) console.error(`  - ${c.join(' ↔ ')}`);
  console.error('  修法：把共享部分下沉到 common/，或改为依赖公开入口的单向调用。\n');
}
if (violations.length) {
  console.error(`[module-boundaries] ${violations.length} 处越界 import（必须走公开入口 <module>/index.ts）：\n`);
  for (const v of violations) {
    console.error(`  ${v.file}:${v.line}  ${v.from} -> ${v.to}`);
    console.error(`      from '${v.spec}'   （目标 ${v.target}）`);
    console.error(`      改成 from '${v.spec.replace(/\/[^/]+\/?$/, '')}' 并确认 index.ts 已导出所需符号`);
  }
}
process.exit(1);
