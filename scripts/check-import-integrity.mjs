#!/usr/bin/env node
/**
 * 提交自洽检查：只对**已入库（git ls-files）**的 TS/TSX 文件解析静态 import，
 * 目标不存在、或存在但未入库 → 报错并给出文件:行。
 *
 * 为什么需要它（C2/C4）：
 * - `tsc --noEmit` / `vite build` 会把**未跟踪文件**一起编进依赖图，所以"工作树 build 绿"
 *   证明不了"提交是完整的"。真实踩过：页面提交了 `import '@/hooks/usePermission'`，
 *   而 hook 当时未跟踪 —— 干净检出必红。
 * - 文件移动/改名期的瞬时 TS2307 也能在这里被提前拦下。
 *
 * 边界：只做**静态 import 解析**，不做类型检查（类型交给 build）。
 * 动态拼接的 require/import 无法解析，按设计跳过。
 *
 * 用法：node scripts/check-import-integrity.mjs [--quiet]
 * 退出码：0 通过 / 1 发现断裂 / 2 环境错误
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

const quiet = process.argv.includes('--quiet');

function sh(args) {
  return execFileSync('git', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
}

let root;
try {
  root = sh(['rev-parse', '--show-toplevel']).trim();
} catch {
  console.error('[import-integrity] 不在 git 仓库内');
  process.exit(2);
}

const toPosix = (p) => p.split(path.sep).join('/');
const tracked = new Set(
  sh(['ls-files', '-z'])
    .split('\0')
    .filter(Boolean)
    .map(toPosix),
);
const untracked = new Set(
  sh(['ls-files', '-z', '-o', '--exclude-standard'])
    .split('\0')
    .filter(Boolean)
    .map(toPosix),
);

const SCAN = /\.(ts|tsx|mts|cts)$/;
const files = [...tracked].filter((f) => SCAN.test(f));

/** 按包根解析 `@/`：server 与 web 各有一套 tsconfig paths（均为 `@/* -> src/*`） */
function aliasRoot(file) {
  if (file.startsWith('web/')) return 'web/src';
  if (file.startsWith('server/')) return 'server/src';
  return null;
}

/** 纯文本候选后缀（按 TS 解析顺序；目录 index 另行处理） */
const SUFFIXES = ['', '.ts', '.tsx', '.mts', '.cts', '.d.ts', '.js', '.json'];

/** 明确带扩展名的资源（vite 支持直接 import） */
const ASSET = /\.(css|less|scss|sass|svg|png|jpg|jpeg|gif|webp|ico|txt|md|xlsx|docx|woff2?)$/i;

function resolveSpecifier(importer, rawSpec) {
  const spec = rawSpec.split('?')[0].split('#')[0];
  let base;
  if (spec.startsWith('@/')) {
    const ar = aliasRoot(importer);
    if (!ar) return { skip: true };
    base = path.join(root, ar, spec.slice(2));
  } else if (spec.startsWith('.')) {
    base = path.resolve(path.dirname(path.join(root, importer)), spec);
  } else {
    return { skip: true };
  }

  const candidates = [];
  if (ASSET.test(base)) {
    candidates.push(base);
  } else {
    for (const s of SUFFIXES) candidates.push(base + s);
  }
  for (const c of candidates) {
    if (!existsSync(c)) continue;
    if (!statSync(c).isFile()) continue;
    const rel = toPosix(path.relative(root, c));
    return { rel, tracked: tracked.has(rel) };
  }
  // 目录 index
  for (const idx of ['index.ts', 'index.tsx', 'index.d.ts', 'index.js']) {
    const c = path.join(base, idx);
    if (!existsSync(c)) continue;
    const rel = toPosix(path.relative(root, c));
    return { rel, tracked: tracked.has(rel) };
  }
  return { missing: true };
}

const IMPORT_PATTERNS = [
  /\bfrom\s+['"]([^'"]+)['"]/g,
  /\bimport\s+['"]([^'"]+)['"]/g,
  /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
];

/**
 * 剥掉注释与模板字符串，但保留普通引号字符串（import 的模块名就在里面），
 * 并**保持换行位置**以便报出行号。否则 JSDoc/示例代码里的 `from './x'` 会全部误报。
 */
function stripForImports(src) {
  const n = src.length;
  let out = '';
  let i = 0;
  let state = 'code';
  while (i < n) {
    const c = src[i];
    const c2 = src.slice(i, i + 2);
    if (state === 'code') {
      if (c2 === '//') { state = 'line'; out += '  '; i += 2; continue; }
      if (c2 === '/*') { state = 'block'; out += '  '; i += 2; continue; }
      if (c === '`') { state = 'template'; out += '`'; i++; continue; }
      if (c === '"' || c === "'") { state = c === '"' ? 'double' : 'single'; out += c; i++; continue; }
      out += c; i++; continue;
    }
    if (state === 'line') {
      if (c === '\n') { state = 'code'; out += '\n'; } else out += ' ';
      i++; continue;
    }
    if (state === 'block') {
      if (c2 === '*/') { state = 'code'; out += '  '; i += 2; continue; }
      out += c === '\n' ? '\n' : ' ';
      i++; continue;
    }
    if (state === 'template') {
      if (c === '\\') { out += '  '; i += 2; continue; }
      if (c === '`') { state = 'code'; out += '`'; i++; continue; }
      out += c === '\n' ? '\n' : ' ';
      i++; continue;
    }
    // 普通引号字符串：原样保留（模块名在这里）
    if (c === '\\') { out += src.slice(i, i + 2); i += 2; continue; }
    if (c === (state === 'single' ? "'" : '"')) state = 'code';
    out += c;
    i++;
  }
  return out;
}

const problems = [];
for (const file of files) {
  const raw = readFileSync(path.join(root, file), 'utf8');
  const src = stripForImports(raw);
  const lines = raw.split('\n');
  for (const re of IMPORT_PATTERNS) {
    re.lastIndex = 0;
    for (const m of src.matchAll(re)) {
      const spec = m[1];
      if (!spec.startsWith('.') && !spec.startsWith('@/')) continue;
      const r = resolveSpecifier(file, spec);
      if (r.skip) continue;
      const line = src.slice(0, m.index).split('\n').length;
      if (r.missing) {
        problems.push({ file, line, spec, reason: '目标文件不存在', srcLine: lines[line - 1]?.trim() });
      } else if (!r.tracked) {
        const hint = untracked.has(r.rel) ? '（目标存在但未入库）' : '（目标未入库）';
        problems.push({ file, line, spec, reason: `解析到 ${r.rel} ${hint}`, srcLine: lines[line - 1]?.trim() });
      }
    }
  }
}

if (!problems.length) {
  if (!quiet) console.log(`[import-integrity] OK：扫描 ${files.length} 个已入库文件，无断裂 import`);
  process.exit(0);
}

console.error(`[import-integrity] 发现 ${problems.length} 处断裂 import（提交后干净检出会编译失败）：\n`);
for (const p of problems) {
  console.error(`  ${p.file}:${p.line}  ${p.spec}`);
  console.error(`      → ${p.reason}`);
  if (p.srcLine) console.error(`      ${p.srcLine}`);
}
console.error(`\n修复：把目标文件一并 git add，或改正 import 路径。`);
process.exit(1);
