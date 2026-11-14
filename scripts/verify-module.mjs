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
import { existsSync, mkdtempSync, openSync, readFileSync, statSync, unlinkSync, writeSync, closeSync, writeFileSync, rmSync } from 'node:fs';
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

// 改动集：相对 base 的差异（含已提交）+ 已暂存 + 未跟踪
const changed = new Set(
  [
    ...git(['diff', '--name-only', base]).split('\n'),
    ...git(['diff', '--name-only', '--cached']).split('\n'),
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

const INT_RELEVANT = /(settlement|invoice|daily-report|receipt-order|procurement|import|archive|final-settlement|cost|amount|contract)/;
const needsInt =
  intMode === 'all' ||
  (intMode === 'auto' &&
    (schemaChanged || serverChanged.some((f) => INT_RELEVANT.test(f) || f.startsWith('server/test-integration/'))));

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
    step('web build（tsc --noEmit && vite build）', () => run(NPM, ['run', 'build'], { cwd: path.join(root, 'web') }));
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
      '--to-schema-datamodel', 'prisma/schema.prisma', '--exit-code', '--shadow-database-url', shadowUrl],
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
      const testEnv = { DATABASE_URL: testUrl, JWT_SECRET: env.JWT_SECRET || 'cms-int-test-secret',
        UPLOAD_DIR: env.UPLOAD_DIR && env.UPLOAD_DIR.includes('.tmp-uploads') ? env.UPLOAD_DIR : mkdtempSync(path.join(tmpdir(), 'cms-int-uploads-')) };

      if (!npx(['prisma', 'migrate', 'deploy'], { cwd: path.join(root, 'server'), env: testEnv })) return false;

      const specs = selectIntSpecs(changed);
      const ok = run(NPM, ['run', 'test:int:run', '--', ...specs], { cwd: path.join(root, 'server'), env: testEnv });

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

function selectIntSpecs(files) {
  files = [...files]; // 调用方传的是 Set（changed），统一成数组再用 filter
  const all = git(['ls-files', 'server/test-integration/*.int.spec.ts'])
    .split('\n')
    .filter((f) => f.endsWith('.int.spec.ts'))
    .map((f) => f.replace(/^server\//, ''));
  if (!all.length) die('未扫描到任何 int spec（目录结构可能已变），拒绝用空参数跑 node --test');
  const direct = files.filter((f) => f.startsWith('server/test-integration/') && f.endsWith('.int.spec.ts'))
    .map((f) => f.replace(/^server\//, ''));
  const tokens = new Set();
  for (const f of files) {
    const m = /server\/src\/modules\/([^/]+)\//.exec(f);
    if (m) tokens.add(m[1].replace(/-/g, ''));
    const b = path.basename(f).replace(/\.[^.]+$/, '');
    tokens.add(b.replace(/-/g, ''));
  }
  const matched = all.filter((s) => [...tokens].some((t) => t && s.replace(/-/g, '').includes(t)));
  const picked = [...new Set([...direct, ...matched])];
  if (picked.length) {
    console.log(`  选中 ${picked.length} 个 int spec：${picked.join(', ')}`);
    return picked;
  }
  console.log('  未匹配到具体 spec，回退全量 int 套件');
  return all;
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
