#!/usr/bin/env node
/**
 * 模块级验收：只证明「本 worktree 的改动」是绿的，不替代合入 main 前的全局门。
 *
 *   node scripts/verify-module.mjs [--base origin/main] [--fast]
 *        [--int auto|all|none] [--isolate=schema]
 *
 * 覆盖：
 * - 提交自洽（check-import-integrity，只认已入库文件）
 * - web 改动 → 全量 build；--fast 且改动全在 pages/ → 临时 tsconfig 子集 tsc
 * - server 改动 → nest build + 全量 npm test（关键词筛会漏 parity/docStats）
 * - schema/迁移改动 → prisma migrate diff --exit-code（本树影子库）
 * - 金额/状态/导入/关联 → migrate deploy + 选中的 int spec（只对本树 *_wt_* 库）
 *
 * 退出码：0 全绿 / 1 有步骤失败 / 2 环境或守卫失败
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, statSync, unlinkSync, writeSync, closeSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const NPM = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const NPX = process.platform === 'win32' ? 'npx.cmd' : 'npx';
const PG_CONTAINER = 'cms-postgres-dev';
const PG_USER = 'cms';

const argv = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : fallback;
};
const has = (name) => argv.includes(`--${name}`);

const base = opt('base', 'origin/main');
const fast = has('fast');
const intMode = opt('int', 'auto'); // auto | all | none
const isolateSchema = has('isolate') || argv.includes('--isolate=schema');

/** 共享层改动（common/query/prisma）影响面不可枚举 → 直接跑全量 */
const SHARED_PREFIXES = ['server/src/common/', 'server/src/query/', 'server/src/constants/', 'server/prisma/'];


function die(msg, code = 2) {
  console.error(`[verify] ${msg}`);
  process.exit(code);
}
function git(args) {
  const r = spawnSync('git', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0) die(`git ${args.join(' ')} 失败\n${(r.stderr || '').trim()}`);
  return r.stdout.trim();
}

const root = git(['rev-parse', '--show-toplevel']);

// 改动集：相对**分支基点**（merge-base）的差异（含已提交）+ 未跟踪。
// 不能直接 diff `origin/main`：主分支前进后，别人的改动会被算成"本树的改动"，
// 导致选错 int spec、跑无关测试（实测：origin/main 前进 71 个文件后选中了 settlement 套件）。
const mergeBase = (() => {
  try {
    return git(['merge-base', 'HEAD', base]) || base;
  } catch {
    return base;
  }
})();
const changed = new Set(
  [
    ...git(['diff', '--name-only', mergeBase]).split('\n'),
    ...git(['ls-files', '-o', '--exclude-standard']).split('\n'),
  ]
    .map((s) => s.trim())
    .filter(Boolean),
);

const webChanged = [...changed].filter((f) => f.startsWith('web/'));
const serverChanged = [...changed].filter((f) => f.startsWith('server/'));
const schemaChanged = serverChanged.some(
  (f) => f === 'server/prisma/schema.prisma' || f.startsWith('server/prisma/migrations/'),
);

// 环境：DATABASE_URL 优先取 server/.env（worktree 脚本写的那份），其次 process.env
function parseEnv(file) {
  if (!existsSync(file)) return {};
  const out = {};
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*"?([^"\n]*)"?\s*$/.exec(line);
    if (m) out[m[1]] = m[2];
  }
  return out;
}
const env = { ...parseEnv(path.join(root, 'server', '.env')), ...process.env };
const dbNameOf = (url) => (url || '').split('/').pop()?.split('?')[0] || '';

/**
 * 是否跑 int：`auto` 模式**以「选集里到底有几个 spec」为唯一判据**。
 *
 * 早先用关键词白名单（`settlement|invoice|import|…`）判断，payment / asset / material /
 * daily-report / repayment / ledger 这些模块的改动会被判成「不用跑 int」而整段跳过——
 * 白名单和真实 spec 集合迟早对不上。选集已按 `@domains` 标签精确到控件，白名单不再需要，
 * 留着只会误伤（实测：改 `payment.service.ts` 时 `needsInt=false`）。
 *
 * 只按 `server/` 侧改动选集：前端 / 文档改动不应触发 int 套件。
 */
const intCandidates = [...changed].filter((f) => f.startsWith('server/'));
const autoIntSpecs =
  intMode === 'auto' && intCandidates.length ? selectIntSpecs(intCandidates) : [];
if (intMode === 'auto' && intCandidates.length && !autoIntSpecs.length) {
  console.log('  改动未关联任何 int spec → 本次跳过 int 套件（PR 门仍跑全量）');
}
const needsInt = intMode === 'all' || (intMode === 'auto' && autoIntSpecs.length > 0);

// --dry-run（VERIFY_INT_DRY=1）：只打印「改动 → 选中哪些 int spec」，不连库、不跑测试
if (process.env.VERIFY_INT_DRY === '1') {
  const specs = intMode === 'all' ? allIntSpecs() : autoIntSpecs;
  console.log(`[dry-run] intMode=${intMode} needsInt=${needsInt} 改动 ${changed.size} 个文件`);
  for (const s of specs) console.log(`  ${s}`);
  process.exit(0);
}

const devDb = dbNameOf(env.DATABASE_URL);
const wtSlug = devDb.replace(/^cms_(int_)?wt_/, '');
// 集成测试必须跑在独立的 int 库上：helpers.assertTestDatabase() 要求库名含 test/int
const intDb = `cms_int_wt_${wtSlug}`;
const shadowDb = `cms_shadow_wt_${wtSlug}`;
const urlFor = (db, schema = 'public') => {
  const u = new URL(env.DATABASE_URL);
  u.pathname = `/${db}`;
  u.searchParams.set('schema', schema);
  return u.toString();
};

if ((schemaChanged || needsInt) && !/^cms_(int_)?wt_/.test(devDb)) {
  die(
    `拒绝在非 worktree 库上验收：DATABASE_URL 指向「${devDb || '(空)'}」。\n` +
      `先执行 scripts/new-task-worktree.mjs 生成独立库，或在 .env 里把库名改成 cms_wt_* / cms_int_wt_*。`,
  );
}

// ---- 步骤执行 ----
const results = [];
function step(name, fn) {
  const t0 = Date.now();
  process.stdout.write(`\n▶ ${name}\n`);
  const r = fn();
  const ok = r === undefined ? true : r;
  results.push({ name, ok, ms: Date.now() - t0 });
  return ok;
}
const WIN = process.platform === 'win32';
/** Windows 下 .cmd 必须经 shell 启动（Node 对 .cmd 的 spawn 做了限制） */
const needsShell = (cmd) => WIN && /\.(cmd|bat)$/i.test(cmd);
/** 经 shell 启动时参数是不转义的（DEP0190），含 `&` 的 URL 必须自己加引号，否则被 cmd 当命令分隔符 */
const q = (s) => (WIN ? `"${s}"` : s);

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, {
    cwd: opts.cwd || root,
    stdio: 'inherit',
    env: { ...env, ...opts.env },
    shell: needsShell(cmd),
  });
  if (r.error) console.error(`  启动失败：${cmd} — ${r.error.message}`);
  return r.status === 0;
}
function npx(args, opts = {}) {
  return run(NPX, args, opts);
}

// 1) 提交自洽
step('提交自洽（已入库文件的 import 完整性）', () =>
  spawnSync(process.execPath, [path.join(root, 'scripts/check-import-integrity.mjs')], {
    cwd: root,
    stdio: 'inherit',
  }).status === 0,
);

// 1.5) 模块边界
step('模块边界（跨模块只走公开入口 + 无环）', () =>
  spawnSync(process.execPath, [path.join(root, 'scripts/check-module-boundaries.mjs')], {
    cwd: root,
    stdio: 'inherit',
  }).status === 0,
);

// 2) web
if (webChanged.length) {
  const onlyPages = webChanged.every((f) => f.startsWith('web/src/pages/'));
  if (fast && onlyPages) {
    step('web 类型检查（--fast：pages 子集）', () => {
      const cfgPath = path.join(root, 'web', 'tsconfig.verify.json');
      const cfg = {
        extends: './tsconfig.json',
        compilerOptions: { noEmit: true, incremental: false },
        // 必须带上 src 下的环境声明（vite-env.d.ts 声明 import.meta.env），
        // 否则子集检查会把 `Property 'env' does not exist on type 'ImportMeta'` 误报成模块错误。
        include: ['src/**/*.d.ts', ...webChanged.map((f) => f.replace(/^web\//, ''))],
        references: [],
      };
      writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));
      try {
        return npx(['tsc', '--noEmit', '-p', 'tsconfig.verify.json'], { cwd: path.join(root, 'web') });
      } finally {
        rmSync(cfgPath, { force: true });
      }
    });
  } else {
    if (fast && !onlyPages) {
      console.log('  [verify] --fast 只在「改动全在 web/src/pages」时生效，本次退回全量 build');
    }
    step('web build（tsc --noEmit && vite build）', () => {
      // Windows 沙箱下 vite/esbuild 删除系统 TEMP 里的临时文件会被拒（Access is denied），
      // 把 TEMP 指到工程内目录（docs/development.md §9 的既有做法）。
      const tmpDir = path.join(root, 'web', 'node_modules', '.tmp');
      mkdirSync(tmpDir, { recursive: true });
      return run(NPM, ['run', 'build'], { cwd: path.join(root, 'web'), env: { TEMP: tmpDir, TMP: tmpDir } });
    });
  }
}

// 3) server
if (serverChanged.length) {
  step('server build（nest build）', () => run(NPM, ['run', 'build'], { cwd: path.join(root, 'server') }));
  step('server 纯函数单测（全量 npm test）', () => run(NPM, ['test'], { cwd: path.join(root, 'server') }));
}

// 4) schema 迁移完整性
if (schemaChanged) {
  step('迁移完整性（migrate diff --exit-code，本树影子库）', () => {
    const shadowUrl = urlFor(shadowDb);
    const exists = spawnSync('docker', ['exec', PG_CONTAINER, 'psql', '-U', PG_USER, '-d', 'postgres', '-tAc',
      `SELECT 1 FROM pg_database WHERE datname='${shadowDb}'`], { encoding: 'utf8' });
    if (exists.stdout.trim() !== '1') {
      die(`影子库 ${shadowDb} 不存在；先运行 scripts/new-task-worktree.mjs（幂等）`);
    }
    return npx(['prisma', 'migrate', 'diff', '--from-migrations', 'prisma/migrations',
      '--to-schema-datamodel', 'prisma/schema.prisma', '--exit-code', '--shadow-database-url', q(shadowUrl)],
      { cwd: path.join(root, 'server') });
  });
}

// 5) int
if (needsInt && intMode !== 'none') {
  step('DB 集成测试（本树 cms_int_wt_* 库）', () => {
    const lockPath = path.join(root, 'server', '.verify.lock');
    const release = acquireLock(lockPath);
    try {
      const exists = spawnSync('docker', ['exec', PG_CONTAINER, 'psql', '-U', PG_USER, '-d', 'postgres', '-tAc',
        `SELECT 1 FROM pg_database WHERE datname='${intDb}'`], { encoding: 'utf8' });
      if (exists.stdout.trim() !== '1') {
        die(`集成测试库 ${intDb} 不存在；先运行 scripts/new-task-worktree.mjs（幂等）`);
      }
      const runId = isolateSchema ? `verify_${Date.now().toString(36)}_${process.pid}` : null;
      const testUrl = urlFor(intDb, runId || 'public');
      if (runId) {
        const created = spawnSync('docker', ['exec', PG_CONTAINER, 'psql', '-U', PG_USER, '-d', intDb, '-tAc',
          `CREATE SCHEMA "${runId}"`], { encoding: 'utf8' });
        if (created.status !== 0) die(`建 schema 失败：${(created.stderr || '').trim()}`);
      }
      // 集成测试必须用**测试专用** JWT_SECRET：`.env.example` 里的占位值（cms-super-secret-key）
      // 会被 jwt.strategy 拒绝，表现为每个 spec 进程启动即失败、且只报 "test failed" 无子用例输出。
      const testEnv = {
        DATABASE_URL: testUrl,
        JWT_SECRET: 'cms-int-test-secret',
        UPLOAD_DIR: env.UPLOAD_DIR && env.UPLOAD_DIR.includes('.tmp-uploads') ? env.UPLOAD_DIR : mkdtempSync(path.join(tmpdir(), 'cms-int-uploads-')),
      };

      if (!npx(['prisma', 'migrate', 'deploy'], { cwd: path.join(root, 'server'), env: testEnv })) return false;

      const specs = intMode === 'all' ? allIntSpecs() : autoIntSpecs;
      // 直接 spawn node（不经 npm.cmd / cmd.exe）：Windows 下 `shell: true` 启动的
      // npm 会让 node:test 的子进程在继承 stdio 时整批无输出失败；同一命令直跑 node 稳定通过。
      const ok = run(
        process.execPath,
        [
          '--require', 'ts-node/register',
          '--disable-warning=MODULE_TYPELESS_PACKAGE_JSON',
          '--test', '--test-concurrency=2',
          ...specs,
        ],
        { cwd: path.join(root, 'server'), env: testEnv },
      );

      if (runId) {
        spawnSync('docker', ['exec', PG_CONTAINER, 'psql', '-U', PG_USER, '-d', intDb, '-tAc',
          `DROP SCHEMA IF EXISTS "${runId}" CASCADE`], { encoding: 'utf8' });
      }
      return ok;
    } finally {
      release();
    }
  });
}

function acquireLock(lockPath) {
  const staleMs = 30 * 60 * 1000;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(lockPath, 'wx');
      writeSync(fd, JSON.stringify({ pid: process.pid, at: Date.now() }));
      closeSync(fd);
      return () => { try { unlinkSync(lockPath); } catch { /* ignore */ } };
    } catch {
      try {
        const st = JSON.parse(readFileSync(lockPath, 'utf8'));
        if (Date.now() - Number(st.at) > staleMs) {
          console.warn(`  [verify] 接管陈旧锁（${lockPath}）`);
          unlinkSync(lockPath);
          continue;
        }
        if (Date.now() - statSync(lockPath).mtimeMs > staleMs) { unlinkSync(lockPath); continue; }
      } catch { /* 无法解析或读取，按陈旧处理 */ try { unlinkSync(lockPath); } catch { /* ignore */ } continue; }
      die(`另一个 verify 正在本树运行（${lockPath}）。超过 30 分钟无活动的陈旧锁会自动接管。`);
    }
  }
  die(`无法获取锁 ${lockPath}`);
}

function allIntSpecs() {
  const all = git(['ls-files', 'server/test-integration/*.int.spec.ts'])
    .split('\n')
    .filter((f) => f.endsWith('.int.spec.ts'))
    .map((f) => f.replace(/^server\//, ''));
  if (!all.length) die('未扫描到任何 int spec（目录结构可能已变），拒绝用空参数跑 node --test');
  return all;
}

/**
 * 读某个 int spec 的文件头域标签：
 *
 *   // @domains: settlement, ledger, payment
 *
 * 约定见 `.claude/rules/parallel-development.md` §4.1：标签是**机器可读**的，
 * `--int auto` 靠它在「改了哪个模块」与「该跑哪些 spec」之间做映射。
 */
function specDomains(rel) {
  try {
    // `allIntSpecs()` / `direct` 给的路径都已摘掉 `server/` 前缀，这里要按 server 根再拼回去；
    // 只拼仓库根会读不到文件 → 标签静默失效 → 选集退回文件名兜底（看起来"跑了"，其实没按标签选）。
    const abs = [path.join(root, 'server', rel), path.join(root, rel)].find((p) => existsSync(p));
    if (!abs) return [];
    const head = readFileSync(abs, 'utf8').split('\n').slice(0, 8).join('\n');
    const m = /@domains?\s*:?\s*([^\n*]+)/i.exec(head);
    if (!m) return [];
    return m[1]
      .split(/[,\s]+/)
      .map((x) => x.trim().toLowerCase().replace(/-/g, ''))
      .filter(Boolean);
  } catch {
    return [];
  }
}

function selectIntSpecs(files) {
  // 调用方传的是 Set（changed），统一转数组，避免 .filter is not a function
  const list = Array.from(files || []);
  const all = allIntSpecs();
  const direct = list.filter((f) => f.startsWith('server/test-integration/') && f.endsWith('.int.spec.ts'))
    .map((f) => f.replace(/^server\//, ''));

  const sharedHit = list.find((f) => SHARED_PREFIXES.some((p) => f.startsWith(p)));
  if (sharedHit && !direct.length) {
    console.log(`  改动了共享层（${sharedHit}），影响面不可枚举 → 跑全量 int 套件`);
    return all;
  }

  const tokens = new Set();
  for (const f of list) {
    const m = /server\/src\/modules\/([^/]+)\//.exec(f);
    if (m) tokens.add(m[1].replace(/-/g, ''));
    const b = path.basename(f).replace(/\.[^.]+$/, '');
    tokens.add(b.replace(/-/g, ''));
  }

  // 标签一个都读不到 = 路径或格式坏了（曾因拼错根目录静默退化成纯文件名兜底），明确警告
  if (!all.some((s) => specDomains(s).length)) {
    console.warn('  [verify] 没有任何 int spec 读到 @domains 标签，只能按文件名兜底（检查文件头格式）');
  }

  const matched = all.filter((s) => {
    // 1) 显式域标签命中（优先，语义准确）
    if (specDomains(s).some((d) => tokens.has(d))) return true;
    // 2) 兜底：文件名片段命中（老 spec 没打标签时仍可用）
    return [...tokens].some((t) => t && s.replace(/-/g, '').includes(t));
  });
  const picked = [...new Set([...direct, ...matched])];
  if (picked.length) {
    console.log(`  选中 ${picked.length}/${all.length} 个 int spec：${picked.join(', ')}`);
    return picked;
  }
  // 一个都没匹配上 = 改动与 int 覆盖面无关（只动了单测 / 文档注释 / 无关模块），
  // 返回空集表示「跳过」，由调用方决定；不要在这里静默回退全量——那等于没有切片。
  return [];
}

// ---- 汇总 ----
console.log('\n===== verify-module 结果 =====');
for (const r of results) {
  console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${(r.ms / 1000).toFixed(1).padStart(6)}s  ${r.name}`);
}
if (!results.length) console.log('（没有命中任何验收步骤——改动集为空？）');
const failed = results.filter((r) => !r.ok);
console.log(failed.length ? `\n❌ ${failed.length} 个步骤失败` : `\n✅ 全部通过（${results.length} 个步骤）`);
process.exit(failed.length ? 1 : 0);
