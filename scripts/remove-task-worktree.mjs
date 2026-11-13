#!/usr/bin/env node
/**
 * 清理任务 worktree：先解 web/node_modules 的 junction（不递归删除，避免穿透到主树），
 * 再 git worktree remove，最后按需删库。
 *
 *   node scripts/remove-task-worktree.mjs <slug> [--yes]
 *
 * 不带 --yes 时只删目录、不删数据库（库里有数据时删库不可恢复）。
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, lstatSync, rmdirSync } from 'node:fs';
import path from 'node:path';

const PG_CONTAINER = 'cms-postgres-dev';
const PG_USER = 'cms';

function die(msg, code = 2) {
  console.error(`[remove-worktree] ${msg}`);
  process.exit(code);
}
function sh(cmd, args, opts = {}) {
  const shell = process.platform === 'win32' && /\.(cmd|bat)$/i.test(cmd);
  const r = spawnSync(cmd, args, { encoding: 'utf8', shell, ...opts });
  if (r.error) die(`${cmd} 启动失败：${r.error.message}`);
  if (r.status !== 0) die(`${cmd} ${args.join(' ')} 失败\n${(r.stderr || '').trim()}`);
  return (r.stdout || '').trim();
}

const slug = (process.argv[2] || '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
if (!slug) die('用法：node scripts/remove-task-worktree.mjs <slug> [--yes]', 1);
const dropDb = process.argv.includes('--yes');

const mainPath = execFileSync('git', ['worktree', 'list', '--porcelain'], { encoding: 'utf8' })
  .split('\n')
  .find((l) => l.startsWith('worktree '))
  ?.slice('worktree '.length)
  .trim();
if (!mainPath) die('无法定位主工作树');

const wtPath = path.join(mainPath, '.worktrees', slug);
if (!existsSync(wtPath)) die(`worktree 不存在：${wtPath}`, 1);

// 1) 解 junction（`fs.rmdirSync` 只删链接本身，不递归）
const webNm = path.join(wtPath, 'web', 'node_modules');
if (existsSync(webNm)) {
  try {
    if (lstatSync(webNm).isSymbolicLink()) {
      rmdirSync(webNm);
      console.log('[remove-worktree] 已解除 web/node_modules junction');
    }
  } catch (e) {
    die(`解除 web/node_modules 失败：${e.message}`);
  }
}

// 2) 删树（有未提交改动时 git 会拒绝，交给人处理）
const r = spawnSync('git', ['-C', mainPath, 'worktree', 'remove', wtPath], { encoding: 'utf8' });
if (r.status !== 0) {
  die(`git worktree remove 被拒绝（可能有未提交改动）：\n${(r.stderr || '').trim()}\n` +
    `确认后可手动：git worktree remove --force ${wtPath}`);
}
console.log(`[remove-worktree] 已删除 ${path.relative(mainPath, wtPath)}`);

// 3) 删库
if (dropDb) {
  for (const db of [`cms_wt_${slug}`, `cms_int_wt_${slug}`, `cms_shadow_wt_${slug}`]) {
    const docker = spawnSync('docker', ['inspect', '-f', '{{.State.Running}}', PG_CONTAINER], { encoding: 'utf8' });
    if (docker.status !== 0 || docker.stdout.trim() !== 'true') {
      console.warn(`[remove-worktree] ${PG_CONTAINER} 未运行，跳过删库 ${db}`);
      continue;
    }
    const exists = spawnSync('docker', ['exec', PG_CONTAINER, 'psql', '-U', PG_USER, '-d', 'postgres', '-tAc',
      `SELECT 1 FROM pg_database WHERE datname='${db}'`], { encoding: 'utf8' });
    if (exists.stdout.trim() !== '1') continue;
    spawnSync('docker', ['exec', PG_CONTAINER, 'psql', '-U', PG_USER, '-d', 'postgres', '-tAc',
      `DROP DATABASE "${db}"`], { encoding: 'utf8' });
    console.log(`[remove-worktree] 已删库 ${db}`);
  }
} else {
  console.log('[remove-worktree] 保留数据库（加 --yes 可一并删除）');
}
