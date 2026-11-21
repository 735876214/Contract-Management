#!/usr/bin/env node
/**
 * 请求体白名单门禁（秒级，无 DB）。
 *
 * 背景（2026-11-21 质量评估 P0-1）：main.ts 注册了 ValidationPipe({ whitelist: true })，但全库
 * 0 个 DTO 类 → whitelist 无元数据可用，等于空转；117 个 @Body() 里 90 个标 any。真正的字段白名单
 * 靠各 service 的 pickFields() / 私有 normalize() / 显式字段构造 —— 是**约定**，不是**机制**。
 * 本脚本把约定变成机制。
 *
 * 规则（紧口径：显式声明 + 校验声明，不做语义分析）
 * 1. 每个 @Body() 的处理方法必须有机器可读标记（同行或向上 10 行内、不跨过方法定义）：
 *      // @body: pickFields=CONTRACT_FIELDS   —— 走 pickFields(白名单常量)
 *      // @body: normalize=this.pick          —— 走私有 normalize/pick（逐字段显式构造）
 *      // @body: typed=UpdateItemsBody        —— 签名已写明字段类型
 *      // @body: array=CONTRACT_DRAFT_FIELDS  —— 批量数组体，逐项走白名单
 *      // @body: mapped=saveNotice             —— 入参在方法内逐字段显式映射（无整体透传 + 至少读 1 个字段）
 *      // @body: render=renderSubcontractorLetter —— 只读渲染（预览/HTML），无写库路径
 * 2. 标记引用的常量 / 方法必须真实存在（防写错、防改名后标记变僵尸）。
 * 3. scripts/body-whitelist.allow.txt 是存量豁免：只允许变少。
 *    - 每条豁免必须在源码里仍然存在（防僵尸条目）；
 *    - 条数不得超上限（清理后必须同步下调，否则门禁会重新放水）。
 *
 * 为什么不做「静态分析 service 里有没有 pickFields」：实测会产生 51 个假阳性
 * （daily-report / labor / repayment 用的是比 pickFields 更严格的逐字段构造），
 * 维护者只会往豁免表里堆条目，门禁当场失效。标记法假阳性为 0。
 *
 * 用法：
 *   node scripts/check-body-whitelist.mjs              # 校验（CI 用）
 *   node scripts/check-body-whitelist.mjs --list       # 列清单（生成豁免表用）
 *   node scripts/check-body-whitelist.mjs --json       # 机器可读
 *   node scripts/check-body-whitelist.mjs --selftest   # 自测：负向 fixture 必须判失败
 *   node scripts/check-body-whitelist.mjs --dir <path> --allow <file>
 * 退出码：0 通过 / 1 有违规 / 2 环境错误
 */
import { readFileSync, readdirSync, existsSync, mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');

/** 存量豁免上限：清理一条就下调一次（只减不增） */
const MAX_ALLOW = Number(process.env.BODY_WHITELIST_MAX_ALLOW ?? 0);

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(name);
const arg = (name, fallback) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};

const SRC_DIR = path.resolve(REPO, arg('--dir', 'server/src'));
const ALLOW_FILE = path.resolve(REPO, arg('--allow', 'scripts/body-whitelist.allow.txt'));

const KINDS = ['pickFields', 'normalize', 'typed', 'array', 'mapped', 'render'];
const MARKER_RE = /^\s*\/\/\s*@body:\s*([A-Za-z]+)=(\S+)\s*$/;
const METHOD_RE = /^\s{2}(?:async\s+|public\s+|private\s+|protected\s+)*([A-Za-z0-9_]+)\s*\(/;
const BODY_RE = /@Body\(\)/;
/** typed=inline 的判定：@Body() 后有标识符 + ':' + 非 any 的类型 */
const INLINE_TYPED_RE = /@Body\(\)\s*[A-Za-z0-9_]+\s*:\s*(?!any\b)[A-Za-z0-9_{[]/;

function walk(dir, out = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

/** 模块内可被标记引用的符号（常量名 / 方法名） */
function symbolsOf(moduleDir) {
  const names = new Set();
  for (const f of walk(moduleDir)) {
    if (!/\.(ts|mts)$/.test(f)) continue;
    const text = readFileSync(f, 'utf8');
    for (const m of text.matchAll(/(?:const|function|class|interface|type|enum)\s+([A-Za-z0-9_]+)/g)) names.add(m[1]);
    for (const m of text.matchAll(/(?:private|public|protected)?\s*(?:async\s+)?([A-Za-z0-9_]+)\s*\(/g)) names.add(m[1]);
  }
  return names;
}

const NOT_KEYWORD = /^(if|for|while|switch|catch)$/;

/** 取类里的方法体（从方法定义到下一个同级方法定义），供 mapped 校验用 */
function methodBodyOf(src, name) {
  const re = new RegExp('\\n' + '\\s{2}(?:private\\s+|public\\s+|protected\\s+|async\\s+)*' + name + '\\s*\\(');
  const m = re.exec(src);
  if (!m) return null;
  const rest = src.slice(m.index + 1);
  const next = rest.slice(1).search(/\n\s{2}(?:private\s+|public\s+|protected\s+|async\s+)?[A-Za-z0-9_]+\s*\(/);
  return next > 0 ? rest.slice(0, next) : rest;
}

function scan(dir) {
  const controllers = walk(dir).filter((f) => f.endsWith('.controller.ts'));
  const items = [];
  for (const file of controllers) {
    const lines = readFileSync(file, 'utf8').split('\n');
    for (let i = 0; i < lines.length; i++) {
      if (!BODY_RE.test(lines[i])) continue;
      let handler = null;
      for (let j = i; j >= 0 && j > i - 60; j--) {
        const m = lines[j].match(METHOD_RE);
        if (m && !NOT_KEYWORD.test(m[1])) { handler = m[1]; break; }
      }
      let marker = null;
      for (let j = i; j >= 0 && j >= i - 10; j--) {
        const m = lines[j].match(MARKER_RE);
        if (m) { marker = { kind: m[1], ref: m[2], line: j + 1 }; break; }
        if (j < i) {
          const mm = lines[j].match(METHOD_RE);
          // 只跨过**本方法自己**的签名行（多行签名时 @Body() 在签名内部，
          // 标记在装饰器上方）；遇到别的方法定义才算越界。
          if (mm && !NOT_KEYWORD.test(mm[1]) && mm[1] !== handler) break;
        }
      }
      const rel = path.relative(REPO, file);
      items.push({
        file: rel,
        module: path.dirname(file),
        line: i + 1,
        handler: handler ?? '?',
        bodyLine: [lines[i], lines[i + 1] || '', lines[i + 2] || ''].join(' '),
        marker,
        key: rel + '::' + (handler ?? '?'),
      });
    }
  }
  return items;
}

function validateWith(items, allow, maxAllow) {
  const violations = [];
  if (allow.length > maxAllow) {
    violations.push({
      type: 'allow-overflow',
      msg: '豁免表 ' + allow.length + ' 条 > 上限 ' + maxAllow + '（清理后必须同步下调 MAX_ALLOW）',
    });
  }
  const byKey = new Map(items.map((it) => [it.key, it]));
  const allowed = new Set(allow);
  for (const entry of allow) {
    if (!byKey.has(entry)) {
      violations.push({ type: 'stale-allow', msg: '豁免条目已失效（源码里找不到该 @Body）：' + entry });
    }
  }
  for (const it of items) {
    if (allowed.has(it.key)) continue;
    if (!it.marker) {
      violations.push({
        type: 'missing-marker',
        msg: it.file + ':' + it.line + ' ' + it.handler + '() 有 @Body() 但没有 // @body: 标记，且不在豁免表里',
      });
      continue;
    }
    if (!KINDS.includes(it.marker.kind)) {
      violations.push({
        type: 'bad-kind',
        msg: it.file + ':' + it.marker.line + ' 未知标记类型 ' + it.marker.kind + '（允许：' + KINDS.join(' / ') + '）',
      });
      continue;
    }
    if (it.marker.kind === 'typed' && it.marker.ref === 'inline') {
      // typed=inline：要求 @Body() 参数自带非 any 的内联类型注解（字段已写进签名）
      if (!INLINE_TYPED_RE.test(it.bodyLine || '')) {
        violations.push({
          type: 'inline-not-typed',
          msg: it.file + ':' + it.line + ' ' + it.handler + '() 标了 typed=inline 但 @Body() 参数仍是 any / 无注解：' + String(it.bodyLine || '').trim(),
        });
      }
      continue;
    }
    if (it.marker.kind === 'render') {
      // render=<函数名>：只读渲染（预览/HTML 输出），不存在写库路径；符号在 server/src 内任意位置即可
      const name = it.marker.ref.replace(/^this\./, '');
      const all = new Set();
      for (const f of walk(SRC_DIR)) {
        if (!/\.(ts|mts)$/.test(f)) continue;
        for (const m of readFileSync(f, 'utf8').matchAll(/(?:function|const|class)\s+([A-Za-z0-9_]+)/g)) all.add(m[1]);
      }
      if (!all.has(name)) {
        violations.push({ type: 'render-unverified', msg: it.file + ':' + it.marker.line + ' render=' + it.marker.ref + ' 在 server/src 内找不到该渲染函数' });
      }
      continue;
    }
    if (it.marker.kind === 'mapped') {
      // mapped=<方法名>：声明「该方法把入参逐字段显式映射进写库语句」。
      // 机器可验的两条：① 方法体没有 ...spread（不发生整体透传）；② 至少 1 处显式读字段（`{items: [...]}` 这类包装体只取 1 个字段是常态，元素级校验在 service 内）。
      const name = it.marker.ref.replace(/^this\./, '');
      let ok = false;
      let detail = 'method-not-found';
      for (const f of walk(it.module)) {
        if (!/\.(ts|mts)$/.test(f)) continue;
        // service 与 controller 都看：有的是 service 里逐字段映射，有的是 controller
        // 先把字段从 body 取出来再传值（两种都算「显式映射」）。
        const src = readFileSync(f, 'utf8');
        const mb = methodBodyOf(src, name);
        if (!mb) continue;
        // 只把「把**请求参数本身**整体摊进写库语句」算作透传：
        // 摊开方法内部自己构造的 payload 是正常写法，不算风险。
        const sigLine = mb.split('\n')[0];
        const params = (sigLine.match(/\(([^)]*)\)/) || [, ''])[1]
          .split(',')
          .map((s) => (s.match(/([A-Za-z0-9_]+)\s*(?:[:?]|$)/) || [])[1])
          .filter(Boolean);
        const spread = params.some(
          (p) => new RegExp('\\.\\.\\.\\s*' + p + '\\b').test(mb) || new RegExp('\\bdata\\s*:\\s*' + p + '\\b').test(mb),
        );
        const reads = (mb.match(/\b(?:body|data|payload)\s*(?:\?\.|\.|\[)/g) || []).length;
        if (!ok) detail = 'spread=' + spread + ' reads=' + reads + ' params=[' + params.join(',') + '] file=' + path.basename(f);
        ok = ok || (!spread && reads >= 1);
      }
      if (!ok) {
        violations.push({
          type: 'mapped-unverified',
          msg: it.file + ':' + it.marker.line + ' mapped=' + it.marker.ref + ' 校验失败（' + detail + '）：要求方法存在、无整体透传、显式字段读取 ≥ 1 处',
        });
      }
      continue;
    }
    const ref = it.marker.ref.replace(/^this\./, '');
    if (!symbolsOf(it.module).has(ref)) {
      violations.push({
        type: 'dangling-ref',
        msg: it.file + ':' + it.marker.line + ' 标记引用的《' + it.marker.ref + '》在模块内不存在（改名要同步标记）',
      });
    }
  }
  return violations;
}

function readAllowLines() {
  if (!existsSync(ALLOW_FILE)) return [];
  return readFileSync(ALLOW_FILE, 'utf8')
    .split('\n')
    .map((s) => s.trim())
    .filter((s) => s && !s.startsWith('#'));
}

/** 自测：负向 fixture 必须判失败（否则门禁就是装饰品） */
function selftest() {
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'body-wl-'));
  const modDir = path.join(tmp, 'src', 'modules', 'demo');
  mkdirSync(modDir, { recursive: true });
  writeFileSync(
    path.join(modDir, 'demo.service.ts'),
    'export const DEMO_FIELDS = ["a"];\nexport class DemoService { pick(d: unknown) { return d; } }\n',
    'utf8',
  );
  const head =
    "import { Body, Controller, Post } from '@nestjs/common';\n" +
    "@Controller('demo')\n" +
    'export class DemoController {\n';
  const cases = [
    {
      name: 'good',
      expect: [],
      body: '  // @body: pickFields=DEMO_FIELDS\n  @Post()\n  create(@Body() body: Record<string, unknown>) { return body; }',
    },
    {
      name: 'bad',
      expect: ['missing-marker'],
      body: '  @Post()\n  create(@Body() body: any) { return body; }',
    },
    {
      name: 'dangling',
      expect: ['dangling-ref'],
      body: '  // @body: pickFields=NOT_EXIST\n  @Post()\n  create(@Body() body: Record<string, unknown>) { return body; }',
    },
  ];
  const out = [];
  let ok = true;
  for (const c of cases) {
    writeFileSync(path.join(modDir, 'demo.controller.ts'), head + c.body + '}\n', 'utf8');
    const got = validateWith(scan(path.join(tmp, 'src', 'modules')), [], Number.MAX_SAFE_INTEGER).map((v) => v.type);
    const pass = c.expect.every((e) => got.includes(e)) && (c.expect.length > 0 || got.length === 0);
    ok = ok && pass;
    out.push(c.name + ': [' + got.join(',') + '] ' + (pass ? 'OK' : 'FAIL'));
  }
  return { ok, out };
}

// ---- main
if (flag('--selftest')) {
  const r = selftest();
  for (const line of r.out) console.log(line);
  console.log(r.ok ? 'selftest OK' : 'selftest FAILED');
  process.exit(r.ok ? 0 : 1);
}

const items = scan(SRC_DIR);
const allow = readAllowLines();
const violations = validateWith(items, allow, MAX_ALLOW);

if (flag('--json')) {
  console.log(JSON.stringify({ total: items.length, allowed: allow.length, violations, items }, null, 2));
  process.exit(violations.length ? 1 : 0);
}
if (flag('--list')) {
  for (const it of items) {
    console.log(it.key + '  [' + (it.marker ? it.marker.kind + '=' + it.marker.ref : 'NO-MARKER') + ']');
  }
  console.log('');
  console.log('total @Body(): ' + items.length + '，已标记 ' + items.filter((i) => i.marker).length + '，豁免 ' + allow.length);
  process.exit(0);
}
if (violations.length) {
  console.error('✖ 请求体白名单门禁失败（' + violations.length + ' 项）');
  for (const v of violations) console.error('  [' + v.type + '] ' + v.msg);
  console.error('');
  console.error('修法：给该 @Body() 方法补 // @body: pickFields=XXX_FIELDS 标记；确属存量未收口的，加进 scripts/body-whitelist.allow.txt（只允许变少）。');
  process.exit(1);
}
console.log('✔ 请求体白名单门禁通过：@Body() ' + items.length + ' 处，豁免 ' + allow.length + ' 处（上限 ' + MAX_ALLOW + '）');
