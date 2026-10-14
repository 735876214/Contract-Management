import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * 迁移纪律门禁：**任何可执行配置里都不许出现 `prisma db push`**（铁律 1）。
 *
 * 为什么需要它：`AGENTS.md`/`README`/docs 都写了「禁止 db push」，但那是**给人看的**——
 * 2026-10 审计发现 CI 里其实**没有任何机器检查**，换句话说"禁止"只靠自觉；
 * 而历史上真的出现过（`.workbuddy/memory/2026-09-13.md` 还留着"改 schema 后务必 db push"的操作指引，
 * 已随本批清理）。`db push` 让库脱离迁移历史，问题只在别人/生产上暴露。
 *
 * **配对的门禁**：`.github/workflows/build.yml` 里还有一条 `prisma migrate diff --exit-code`
 * ——它管「改了 schema 必须出迁移」，本文件管「别用 db push 绕过迁移」，两条一起才完整。
 *
 * 扫描范围只限**可执行配置**（package.json scripts / CI / compose / Dockerfile / shell / 脚本源码）：
 * md 文档里的"禁止 db push"是**说明**而非指令，扫进来只会误报。
 */

const repoRoot = fileURLToPath(new URL('../../', import.meta.url));
const abs = (rel: string) => fileURLToPath(new URL(`../../${rel}`, import.meta.url));

/** 递归收集指定扩展名的文件 */
const walk = (dir: string, exts: string[], out: string[] = []): string[] => {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === '.git') continue;
    const full = `${dir}/${entry}`;
    if (statSync(full).isDirectory()) walk(full, exts, out);
    else if (exts.some((e) => entry.endsWith(e))) out.push(full);
  }
  return out;
};

/** 剥掉注释：YAML/Shell/Dockerfile 的 `#` 行注释；JS/TS/Python 的行注释与块注释 */
const stripComments = (src: string, kind: 'hash' | 'slash') => {
  const noBlock = kind === 'slash' ? src.replace(/\/\*[\s\S]*?\*\//g, '') : src;
  const noLine = kind === 'slash' ? noBlock.replace(/(^|[^:])\/\/.*$/gm, '$1') : noBlock;
  return kind === 'hash' ? noLine.replace(/(^|\s)#.*$/gm, '$1') : noLine;
};

interface ScanTarget {
  file: string;
  kind: 'hash' | 'slash';
}

const targets: ScanTarget[] = [
  { file: abs('server/package.json'), kind: 'slash' },
  { file: abs('web/package.json'), kind: 'slash' },
  { file: abs('docker-compose.yml'), kind: 'hash' },
  { file: abs('docker-compose.dev.yml'), kind: 'hash' },
  ...walk(abs('.github/workflows'), ['.yml', '.yaml']).map((file) => ({ file, kind: 'hash' as const })),
  ...walk(abs('deploy'), ['.sh', '.conf', 'Dockerfile', '.single']).map((file) => ({ file, kind: 'hash' as const })),
  ...walk(abs('scripts'), ['.sh', '.mjs', '.js', '.ps1', '.py', '.mts']).map((file) => ({
    file,
    kind: (file.endsWith('.mjs') || file.endsWith('.js') ? 'slash' : 'hash') as 'hash' | 'slash',
  })),
];

const DB_PUSH = /db\s+push/i;

describe('迁移纪律（禁止 prisma db push）', () => {
  it('扫描面不能为空（防路径写错导致测试恒真）', () => {
    assert.ok(targets.length >= 8, `待扫文件过少（${targets.length}），路径可能不对`);
    for (const t of targets) {
      assert.ok(existsSync(t.file), `文件不存在：${t.file}`);
      assert.ok(readFileSync(t.file, 'utf8').length > 20, `文件内容异常：${t.file}`);
    }
  });

  it('可执行配置里不得出现 `db push`（注释除外）', () => {
    const offenders: string[] = [];
    for (const t of targets) {
      const clean = stripComments(readFileSync(t.file, 'utf8'), t.kind);
      clean.split('\n').forEach((line, i) => {
        if (DB_PUSH.test(line)) offenders.push(`${t.file.slice(repoRoot.length)}:${i + 1} → ${line.trim()}`);
      });
    }
    assert.deepEqual(offenders, [], `禁止 db push（改模型请用 npx prisma migrate dev），命中：\n${offenders.join('\n')}`);
  });

  it('npm scripts 里不得暴露 db push，且必须保留 `prisma migrate deploy` 这条迁移路径', () => {
    for (const pkg of [abs('server/package.json'), abs('web/package.json')]) {
      const scripts = JSON.parse(readFileSync(pkg, 'utf8')).scripts ?? {};
      for (const [name, cmd] of Object.entries(scripts)) {
        assert.ok(!DB_PUSH.test(String(cmd)), `scripts.${name} 使用了 db push：${cmd}`);
      }
    }
    const serverScripts = JSON.parse(readFileSync(abs('server/package.json'), 'utf8')).scripts ?? {};
    assert.match(String(serverScripts['prisma:deploy'] ?? ''), /migrate deploy/, 'server scripts 缺少 prisma:deploy（migrate deploy）');
  });

  it('**反向确认**：注释里的「禁止 db push」不会误报（剥注释生效）', () => {
    const sample = '# 不要用 db push：会让库脱离迁移历史\nrun: npx prisma migrate deploy\n';
    assert.ok(!DB_PUSH.test(stripComments(sample, 'hash')), '剥注释失效：说明文字被当成指令');
    assert.ok(DB_PUSH.test(stripComments('run: npx prisma db push\n', 'hash')), '剥注释过头：真指令没被检出');
  });
});
