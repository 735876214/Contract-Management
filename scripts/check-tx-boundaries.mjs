#!/usr/bin/env node
/**
 * 事务边界检查（秒级，无 DB）。
 *
 * 规则：`$transaction` 的回调体里**只做数据库操作**。
 *   1. 不得 `await this.<x>Service.method(...)`：跨域 service 塞进事务 = 长事务 + 隐式耦合，
 *      且对方的内部实现随时可能再开一次事务/发通知，事务范围失控。
 *   2. 不得做外部 IO（HTTP / 文件读写 / 下载落盘）：IO 的耗时不可控，期间一直持有连接与行锁，
 *      并发下会把连接池打穿（Prisma 交互式事务在 PostgreSQL 上是**单连接长事务**）。
 *
 * 现状（2026-11-23）：全仓 0 违规——本检查是**防劣化**门禁，把「现在已经做对的事」写死。
 * 需要跨模块写表时走 owner 模块导出的写入原语（无状态函数 + 传事务句柄），见
 * `.claude/rules/module-boundaries.md` §3.2。
 *
 * 用法：node scripts/check-tx-boundaries.mjs [--quiet] [--self-test]
 * 退出码：0 通过 / 1 有违规 / 2 环境错误
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const quiet = process.argv.includes('--quiet');
const SRC_DIR = 'server/src/';
const isTs = (f) => /\.ts$/.test(f) && !f.endsWith('.d.ts');

/**
 * 把注释与字符串/模板内容涂成空格（保留换行与字符偏移）。
 * 目的：只在**代码形态**上匹配，不误伤注释里贴的示例代码，行号仍按原文计算。
 */
function mask(source) {
  const out = source.split('');
  const n = source.length;
  let i = 0;
  while (i < n) {
    const c = source[i];
    const d = source[i + 1];
    if (c === '/' && d === '/') {
      while (i < n && source[i] !== '\n') out[i++] = ' ';
      continue;
    }
    if (c === '/' && d === '*') {
      out[i++] = ' ';
      out[i++] = ' ';
      while (i < n && !(source[i] === '*' && source[i + 1] === '/')) {
        if (source[i] !== '\n') out[i] = ' ';
        i++;
      }
      if (i < n) {
        out[i++] = ' ';
        out[i++] = ' ';
      }
      continue;
    }
    if (c === "'" || c === '"' || c === '`') {
      const q = c;
      out[i++] = ' ';
      while (i < n && source[i] !== q) {
        if (source[i] === '\\') {
          out[i++] = ' ';
          if (i < n) out[i++] = ' ';
          continue;
        }
        if (source[i] !== '\n') out[i] = ' ';
        i++;
      }
      if (i < n) out[i++] = ' ';
      continue;
    }
    i++;
  }
  return out.join('');
}

/** 取出所有 `$transaction(...)` 的实参文本（括号配平；在 mask 后的源码上做，括号不会出现在字符串里） */
function txSpans(masked) {
  const spans = [];
  const re = /\$transaction\s*\(/g;
  let m;
  while ((m = re.exec(masked))) {
    const start = m.index + m[0].length;
    let i = start;
    let depth = 1;
    while (i < masked.length && depth > 0) {
      const c = masked[i];
      if (c === '(') depth++;
      else if (c === ')') depth--;
      i++;
    }
    spans.push({ start, end: Math.max(start, i - 1), text: masked.slice(start, Math.max(start, i - 1)) });
  }
  return spans;
}

const lineAt = (source, index) => source.slice(0, index).split('\n').length;

/** 违规模式；命中即报 */
const PATTERNS = [
  {
    id: 'service-call',
    re: /await\s+this\s*\.\s*[A-Za-z_$][\w$]*Service\s*\./g,
    msg: '事务体内调用跨域 service（长事务 + 隐式依赖）；改走 owner 导出的无状态写入原语（传 tx）',
  },
  { id: 'http', re: /\bfetch\s*\(|\baxios\b|\bhttps?\.request\b/g, msg: '事务体内做 HTTP 调用' },
  {
    id: 'fs-io',
    re: /\b(readFile|writeFile|appendFile|mkdir|unlink|rename|createWriteStream|createReadStream)\s*\(/g,
    msg: '事务体内做文件 IO',
  },
  { id: 'fs-module', re: /\bfs\s*\.\s*(promises\s*\.\s*)?[A-Za-z]/g, msg: '事务体内使用 fs' },
  { id: 'download', re: /\bsendFile\s*\(/g, msg: '事务体内生成/发送文件' },
];

/** 纯分析：给定原文，返回违规 [{line, id, msg, snippet}]（自证直接复用） */
function analyze(source) {
  const masked = mask(source);
  const out = [];
  for (const span of txSpans(masked)) {
    for (const p of PATTERNS) {
      p.re.lastIndex = 0;
      let m;
      while ((m = p.re.exec(span.text))) {
        const abs = span.start + m.index;
        out.push({
          line: lineAt(source, abs),
          id: p.id,
          msg: p.msg,
          snippet: masked.slice(abs, abs + 60).replace(/\s+/g, ' ').trim(),
        });
      }
    }
  }
  return out;
}

function runSelfTest() {
  const cases = [
    {
      name: '事务体内调跨域 service（应报）',
      src: 'await this.prisma.$transaction(async (tx) => {\n  await this.contractService.create({}, id);\n});',
      want: 1,
    },
    {
      name: '事务体内 HTTP（应报）',
      src: 'await this.prisma.$transaction(async (tx) => {\n  await fetch(url);\n});',
      want: 1,
    },
    {
      name: '事务体内文件 IO（应报）',
      src: 'await this.prisma.$transaction(async (tx) => {\n  await writeFile(p, buf);\n});',
      want: 1,
    },
    {
      name: '纯 DB 事务（不该报）',
      src: 'await this.prisma.$transaction(async (tx) => {\n  await tx.contract.update({ where: { id }, data });\n});',
      want: 0,
    },
    {
      name: '注释里的示例不误伤（不该报）',
      src: '// await this.fooService.bar()\nawait this.prisma.$transaction(async (tx) => { await tx.contract.delete({ where: { id } }); });',
      want: 0,
    },
    {
      name: '事务外的 service 调用不误伤（不该报）',
      src: 'const a = await this.fooService.list();\nawait this.prisma.$transaction([this.prisma.contract.delete({ where: { id } })]);',
      want: 0,
    },
    {
      name: '嵌套括号配平（应报内层）',
      src: 'await this.prisma.$transaction(async (tx) => {\n  await tx.x.update({ where: { id: f(a, b) }, data: { v: g(c) } });\n  await this.auditService.log(1);\n}, { timeout: 15000 });',
      want: 1,
    },
  ];
  let failed = 0;
  for (const c of cases) {
    const got = analyze(c.src).length;
    if (got !== c.want) {
      failed++;
      console.error(`  ✗ ${c.name}：期望 ${c.want} 处，实际 ${got} 处`);
    } else if (!quiet) {
      console.log(`  ✓ ${c.name}`);
    }
  }
  if (failed) {
    console.error(`[tx-boundaries] 自证失败 ${failed}/${cases.length}：事务边界检测已失效`);
    process.exit(1);
  }
  if (!quiet) console.log('[tx-boundaries] 自证通过：跨域 service / HTTP / 文件 IO 均可识别，注释与事务外调用不误伤');
  process.exit(0);
}

if (process.argv.includes('--self-test')) runSelfTest();

let root;
try {
  root = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
} catch {
  console.error('[tx-boundaries] 不在 git 仓库内');
  process.exit(2);
}

const tracked = execFileSync('git', ['ls-files'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  .split('\n')
  .filter(Boolean);
const files = tracked.filter((f) => f.startsWith(SRC_DIR) && isTs(f));

const violations = [];
for (const file of files) {
  const src = readFileSync(path.join(root, file), 'utf8');
  if (!src.includes('$transaction')) continue;
  for (const v of analyze(src)) violations.push({ file, ...v });
}

if (!violations.length) {
  if (!quiet) console.log(`[tx-boundaries] OK：${files.length} 个源文件，$transaction 回调体内无跨域 service 调用、无外部 IO`);
  process.exit(0);
}

console.error(`[tx-boundaries] ${violations.length} 处事务边界违规：\n`);
for (const v of violations) {
  console.error(`  ${v.file}:${v.line}  [${v.id}] ${v.msg}`);
  console.error(`      ${v.snippet}`);
}
process.exit(1);
