#!/usr/bin/env node
/**
 * 为单个任务创建隔离的 git worktree：独立分支、独立数据库、独立 env、独立依赖。
 *
 *   node scripts/new-task-worktree.mjs <slug> [--branch feat/x] [--base origin/main]
 *        [--port 3111] [--link-web] [--no-fetch]
 *
 * 设计要点：
 * - 主工作树用 `git worktree list --porcelain` 的第一条定位（不是 --show-toplevel），
 *   这样从任意 worktree 里运行，新树仍建在主仓 `.worktrees/` 下。
 * - server/node_modules 必须每树独立（prisma client 内嵌 schema）；
 *   web/node_modules 默认也独立，`--link-web` 才建 junction。
 * - 三只库按 slug 分开：cms_wt_* / cms_int_wt_* / cms_shadow_wt_*。
 * - 幂等：树/库已存在时只补齐 env，不重复建。
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import path from 'node:path';

const NPM = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const NPX = process.platform === 'win32' ? 'npx.cmd' : 'npx';
const PG_CONTAINER = 'cms-postgres-dev';
const PG_USER = 'cms';
const PG_PASSWORD = 'cms123456';
const PG_HOST_PORT = 15432;

function die(msg, code = 2) {
  console.error(`[new-worktree] ${msg}`);
  process.exit(code);
}

function sh(cmd, args, opts = {}) {
  const shell = process.platform === 'win32' && /\.(cmd|bat)$/i.test(cmd);
  const r = spawnSync(cmd, args, { encoding: 'utf8', stdio: opts.stdio ?? 'pipe', shell, ...opts });
  if (r.error) die(`${cmd} 启动失败：${r.error.message}`);
  if (r.status !== 0) {
    const detail = (r.stderr || r.stdout || '').trim();
    die(`${cmd} ${args.join(' ')} 失败${detail ? `\n${detail}` : ''}`);
  }
  return (r.stdout || '').trim();
}

function git(args, opts) {
  return sh('git', args, opts);
}

const argv = process.argv.slice(2);
const slugRaw = argv.find((a) => !a.startsWith('--'));
if (!slugRaw) die('用法：node scripts/new-task-worktree.mjs <slug> [--branch ...] [--base ...] [--port ...]', 1);
const slug = slugRaw
  .toLowerCase()
  .replace(/[^a-z0-9]+/g, '_')
  .replace(/^_+|_+$/g, '')
  .slice(0, 40);
if (!slug) die('slug 必须包含字母或数字', 1);

const opt = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : fallback;
};
const has = (name) => argv.includes(`--${name}`);

const branch = opt('branch', `feat/${slug}`);
const base = opt('base', 'origin/main');
const port = Number(opt('port', '3111'));
const noFetch = has('no-fetch');
const linkWeb = has('link-web');

// 1) 定位主工作树
const porcelain = git(['worktree', 'list', '--porcelain']);
const mainPath = porcelain
  .split('\n')
  .find((l) => l.startsWith('worktree '))
  ?.slice('worktree '.length)
  .trim();
if (!mainPath) die('无法定位主工作树');
const wtPath = path.join(mainPath, '.worktrees', slug);
const relWt = path.relative(mainPath, wtPath).split(path.sep).join('/');

// 2) 预检：数据库容器 + 端口
const docker = spawnSync('docker', ['inspect', '-f', '{{.State.Running}}', PG_CONTAINER], { encoding: 'utf8' });
if (docker.status !== 0 || docker.stdout.trim() !== 'true') {
  die(`PostgreSQL 容器 ${PG_CONTAINER} 未运行。先执行：docker compose -f docker-compose.dev.yml up -d postgres`);
}
async function portFree(p) {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.once('error', () => resolve(false));
    s.once('listening', () => s.close(() => resolve(true)));
    s.listen(p, '127.0.0.1');
  });
}
if (!(await portFree(port))) die(`端口 ${port} 已被占用，用 --port 换一个`);
if (!(await portFree(port + 2000))) die(`前端端口 ${port + 2000} 已被占用，用 --port 换一个`);

// 3) 建树（幂等）
if (!noFetch) {
  try { git(['-C', mainPath, 'fetch', 'origin', 'main', '--prune']); } catch { /* 离线可继续 */ }
}
const branchExists = spawnSync('git', ['-C', mainPath, 'rev-parse', '--verify', '--quiet', branch], { encoding: 'utf8' }).status === 0;
if (!existsSync(wtPath)) {
  console.log(`[new-worktree] 创建 ${relWt}（分支 ${branch}，基于 ${base}）`);
  const args = ['-C', mainPath, 'worktree', 'add', wtPath];
  if (!branchExists) args.push('-b', branch);
  args.push(branchExists ? branch : base);
  git(args);
} else {
  console.log(`[new-worktree] ${relWt} 已存在，只补齐数据库与 env`);
}

// 4) 建三只库（幂等）
const dbs = {
  dev: `cms_wt_${slug}`,
  int: `cms_int_wt_${slug}`,
  shadow: `cms_shadow_wt_${slug}`,
};
function psql(sql, db = 'postgres') {
  return sh('docker', ['exec', PG_CONTAINER, 'psql', '-U', PG_USER, '-d', db, '-tAc', sql]);
}
for (const db of Object.values(dbs)) {
  const exists = psql(`SELECT 1 FROM pg_database WHERE datname='${db}'`);
  if (exists.includes('1')) continue;
  psql(`CREATE DATABASE "${db}"`);
  console.log(`[new-worktree] 建库 ${db}`);
}

// 5) 写 server/.env（保留模板里其它键，只覆盖三行）
const envPath = path.join(wtPath, 'server', '.env');
const templatePath = existsSync(path.join(mainPath, 'server', '.env'))
  ? path.join(mainPath, 'server', '.env')
  : path.join(wtPath, 'server', '.env.example');
let env = readFileSync(templatePath, 'utf8');
const url = (db, extra = '') =>
  `postgresql://${PG_USER}:${PG_PASSWORD}@localhost:${PG_HOST_PORT}/${db}?schema=public${extra}`;
const setKey = (src, key, value) => {
  const re = new RegExp(`^${key}=.*$`, 'm');
  return re.test(src) ? src.replace(re, `${key}="${value}"`) : `${src.trimEnd()}\n${key}="${value}"\n`;
};
env = setKey(env, 'DATABASE_URL', url(dbs.dev, '&connection_limit=4&pool_timeout=20'));
env = setKey(env, 'PORT', String(port));
env = setKey(env, 'UPLOAD_DIR', path.join(wtPath, '.tmp-uploads').replace(/\\/g, '/'));
env = `# 由 scripts/new-task-worktree.mjs 生成（slug=${slug}）\n${env}`;
writeFileSync(envPath, env);
mkdirSync(path.join(wtPath, '.tmp-uploads'), { recursive: true });

// 6) 依赖
console.log('[new-worktree] 安装 server 依赖 + prisma generate …');
sh(NPM, ['ci', '--legacy-peer-deps', '--no-audit', '--no-fund'], { cwd: path.join(wtPath, 'server'), stdio: 'inherit' });
sh(NPX, ['prisma', 'generate'], { cwd: path.join(wtPath, 'server'), stdio: 'inherit' });

const webNm = path.join(wtPath, 'web', 'node_modules');
if (linkWeb) {
  if (!existsSync(webNm)) {
    const target = path.join(mainPath, 'web', 'node_modules');
    if (!existsSync(target)) die('--link-web 需要主树已有 web/node_modules');
    const { symlinkSync } = await import('node:fs');
    symlinkSync(target, webNm, 'junction');
    console.log('[new-worktree] web/node_modules → 主树（junction）');
  }
} else if (!existsSync(webNm)) {
  console.log('[new-worktree] 安装 web 依赖 …');
  sh(NPM, ['ci', '--legacy-peer-deps', '--no-audit', '--no-fund'], { cwd: path.join(wtPath, 'web'), stdio: 'inherit' });
}

console.log(`
[new-worktree] 完成：${relWt}
  分支       ${branch}
  数据库     ${dbs.dev} / ${dbs.int} / ${dbs.shadow}
  后端       cd ${relWt}/server; $env:PORT=${port}; npm run start:dev
  前端       cd ${relWt}/web; $env:VITE_PROXY_TARGET="http://localhost:${port}"; npm run dev -- --port ${port + 2000}
  验收       cd ${relWt}; node scripts/verify-module.mjs
  清理       node scripts/remove-task-worktree.mjs ${slug}
`);
