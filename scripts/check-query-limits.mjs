#!/usr/bin/env node
/**
 * 列表查询上限门禁（秒级，无 DB）。
 *
 * 背景（2026-11-21 质量评估 P1-4；2026-11-28 收紧）：全仓几百处 findMany 里绝大多数没有 take，
 * 台账/结算/采购等列表路径会随项目体量线性涨内存（多张表还会被一次性拉进内存再分组）。
 * 有些全量是**有意**的（如台账带「合规性」内存派生列筛选时必须取全量再切片），
 * 这类必须在源码里写明理由，而不是靠人记得。
 *
 * 判定规则（只认三种「有界」写法，其余都要写理由）
 * 1. **顶层**参数里有 take（分页/上限）。只看顶层：select/include 里嵌套的 take 限的是子表，
 *    父列表照样无上限，不算。
 * 2. where 是对象字面量，且其中**直接**写了父实体键的等值 / 简写 / in 列表
 *    （PARENT_KEYS：contractId、taskId、settlementId、supplierId ...）——按父实体过滤天然有界。
 *    projectId **不算**：按项目过滤仍可能是整个项目的全部行。
 *    contractNo: { contains: x } 这类模糊条件也不算（父子关系不成立，且一行都筛不出来）。
 * 3. 确属有意全量的：在 findMany 同一行或紧邻上一行写 // @no-limit: <理由>。
 *
 * 2026-11-28 修掉的三处漏判（本次收紧的由来，selftest 里各有一个负向 fixture 钉住）
 * (1) 原来把父实体键正则作用在**整段调用文本**上：select: { id: true } 里的 "id:" 就算数，
 *     于是只要顺手 select 一下主键，项目级无上限查询就能过闸（实测放过 31 处）。
 * (2) 原来 take 也是在整段调用里搜：include: { details: { take: 5 } }、甚至**注释里**写过的
 *     "take" 都能让它通过。
 * (3) 原来 key: { ... } 被当成等值（(?!\{) 前的 \s* 能回溯到 0 个空格），
 *     contractNo: { contains } 也判成有界。
 * 现在：先剥注释（等长替换，不打乱下标）→ 只看顶层参数成员 → 再看 where 的顶层键。
 *
 * 存量未收口的走 scripts/query-limit.allow.txt（<文件相对路径>::<方法名>），
 * 条数不得超 MAX_ALLOW，条目必须仍然存在（防僵尸），**只允许变少**。
 *
 * 用法：
 *   node scripts/check-query-limits.mjs             # 校验（CI 用）
 *   node scripts/check-query-limits.mjs --list      # 列清单（每条标明判定依据）
 *   node scripts/check-query-limits.mjs --json
 *   node scripts/check-query-limits.mjs --selftest  # 自测：负向 fixture 必须判失败
 * 退出码：0 通过 / 1 有违规 / 2 环境错误
 */
import { readFileSync, readdirSync, existsSync, mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');
const SRC_DIR = path.resolve(REPO, 'server/src');
const ALLOW_FILE = path.resolve(REPO, 'scripts/query-limit.allow.txt');

/** 存量豁免上限：清理一条就下调一次 */
const MAX_ALLOW = Number(process.env.QUERY_LIMIT_MAX_ALLOW ?? 0);

const argv = process.argv.slice(2);
const flag = (n) => argv.includes(n);
const MARKER = /\/\/\s*@no-limit:\s*\S/;
const METHOD_RE = /^\s{2}(?:private\s+|public\s+|protected\s+|async\s+)*([A-Za-z0-9_]+)\s*\(/;
const NOT_KEYWORD = /^(if|for|while|switch|catch|return)$/;

/**
 * 父实体键：where 里直接写这些键的等值/in 列表，说明「这是某一条父实体名下的明细」，天然有界。
 * 加新键前先想清楚：它真的能限定到一个父实体吗？（projectId 明确不在其中）
 */
const PARENT_KEYS = new Set([
  'id',
  'contractId',
  'parentContractId',
  'taskId',
  'settlementId',
  'invoiceId',
  'paymentId',
  'orderId',
  'receiptOrderId',
  'materialBaseId',
  'materialId',
  'supplierId',
  'subcontractorId',
  'projectProcedureId',
  'agreementId',
  'ledgerId',
  'docId',
  'finalSettlementId',
  'profitLossId',
  'templateId',
  'contractNo',
  'materialContractId',
]);

function walk(dir, out = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

const QUOTES = new Set(['"', String.fromCharCode(39), String.fromCharCode(96)]);
const isQuote = (c) => QUOTES.has(c);

/**
 * 剥注释：把 // 与和块注释的内容替换成等长空格（保留换行），下标与原文完全一致。
 * 不这么做的话，注释里出现的 take、id: 会被当成代码（这正是 2026-11-28 修掉的漏判之一）。
 */
function stripComments(text) {
  const out = text.split('');
  let i = 0;
  const n = text.length;
  while (i < n) {
    const c = text[i];
    if (isQuote(c)) {
      const q = c;
      i += 1;
      while (i < n && text[i] !== q) {
        if (text[i] === '\\') i += 1;
        i += 1;
      }
      i += 1;
      continue;
    }
    if (c === '/' && text[i + 1] === '/') {
      while (i < n && text[i] !== '\n') { out[i] = ' '; i += 1; }
      continue;
    }
    if (c === '/' && text[i + 1] === '*') {
      out[i] = ' '; out[i + 1] = ' '; i += 2;
      while (i < n && !(text[i] === '*' && text[i + 1] === '/')) {
        if (text[i] !== '\n') out[i] = ' ';
        i += 1;
      }
      if (i < n) { out[i] = ' '; out[i + 1] = ' '; i += 2; }
      continue;
    }
    i += 1;
  }
  return out.join('');
}

/** 从开括号起做括号配平（跳过字符串），返回配平的下标 */
function matchEnd(text, openIdx) {
  let depth = 0;
  for (let i = openIdx; i < text.length; i += 1) {
    const c = text[i];
    if (isQuote(c)) {
      const q = c;
      i += 1;
      while (i < text.length && text[i] !== q) {
        if (text[i] === '\\') i += 1;
        i += 1;
      }
      continue;
    }
    if (c === '(' || c === '[' || c === '{') depth += 1;
    else if (c === ')' || c === ']' || c === '}') {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return text.length - 1;
}

/** 拆对象字面量的**顶层**成员（跳过字符串与嵌套括号），返回成员原文数组 */
function members(objText) {
  const out = [];
  const n = objText.length;
  let i = objText[0] === '{' ? 1 : 0;
  let depth = 0;
  let from = i;
  while (i < n) {
    const c = objText[i];
    if (isQuote(c)) {
      const q = c;
      i += 1;
      while (i < n && objText[i] !== q) {
        if (objText[i] === '\\') i += 1;
        i += 1;
      }
      i += 1;
      continue;
    }
    if (c === '{' || c === '[' || c === '(') { depth += 1; i += 1; continue; }
    if (c === '}' || c === ']' || c === ')') {
      if (depth === 0) { out.push(objText.slice(from, i)); break; }
      depth -= 1; i += 1; continue;
    }
    if (depth === 0 && c === ',') { out.push(objText.slice(from, i)); from = i + 1; i += 1; continue; }
    i += 1;
  }
  return out.map((s) => s.trim()).filter((s) => s.length > 0);
}

/** 成员 -> { key, kind, valueText }；kind: scalar / shorthand / object / in（展开等认不出的返回 null） */
function classify(raw) {
  const m = /^([A-Za-z0-9_$]+)\s*(:?)/.exec(raw);
  if (!m) return null;
  const key = m[1];
  const hasColon = m[2] === ':';
  const valueText = raw.slice(m[0].length).trim();
  if (!hasColon) return { key, kind: 'shorthand', valueText: '' };
  if (valueText.startsWith('{')) {
    return { key, kind: /^\{\s*in\s*:/.test(valueText) ? 'in' : 'object', valueText };
  }
  return { key, kind: 'scalar', valueText };
}

/** 判定一次 findMany 的参数是否「有界」，并给出依据文案 */
function analyzeArgs(argsText) {
  const a = argsText.trim();
  if (!a.startsWith('{')) return { bounded: false, how: '参数不是对象字面量' };
  const top = members(a).map(classify).filter(Boolean);
  if (top.some((x) => x.key === 'take')) return { bounded: true, how: '顶层 take' };
  const whereMember = top.find((x) => x.key === 'where');
  if (!whereMember) return { bounded: false, how: '没有顶层 where（全表/全项目扫）' };
  if (whereMember.kind !== 'object') return { bounded: false, how: 'where 不是字面量（变量/函数调用，静态看不出）' };
  const wm = members(whereMember.valueText).map(classify).filter(Boolean);
  const hit = wm.find((x) => PARENT_KEYS.has(x.key) && (x.kind === 'scalar' || x.kind === 'shorthand' || x.kind === 'in'));
  if (hit) return { bounded: true, how: 'where.' + hit.key + (hit.kind === 'in' ? '（in 列表）' : '') };
  const fuzzy = wm.filter((x) => PARENT_KEYS.has(x.key));
  if (fuzzy.length) return { bounded: false, how: 'where.' + fuzzy.map((x) => x.key).join('/') + ' 只是模糊条件，不构成父子过滤' };
  return { bounded: false, how: '只按 projectId 等非父键过滤' };
}

function scan(dir) {
  const files = walk(dir).filter((f) => /\.(service|query)\.ts$/.test(f) || f.includes(path.sep + 'query' + path.sep));
  const items = [];
  for (const file of files) {
    const raw = readFileSync(file, 'utf8');
    const src = stripComments(raw);
    const lines = raw.split('\n');
    const lineStarts = [];
    let acc = 0;
    for (const l of lines) { lineStarts.push(acc); acc += l.length + 1; }
    const lineOf = (idx) => {
      let lo = 0;
      let hi = lineStarts.length - 1;
      while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if (lineStarts[mid] <= idx) lo = mid;
        else hi = mid - 1;
      }
      return lo;
    };
    for (const m of src.matchAll(/\.findMany\(/g)) {
      const open = m.index + m[0].length - 1;
      const end = matchEnd(src, open);
      const args = src.slice(open + 1, end);
      const info = analyzeArgs(args);
      const li = lineOf(m.index);
      const prev = (lines[li] || '') + '\n' + (lines[li - 1] || '');
      let method = '?';
      for (let j = li; j >= 0 && j > li - 120; j -= 1) {
        const mm = lines[j].match(METHOD_RE);
        if (mm && !NOT_KEYWORD.test(mm[1])) { method = mm[1]; break; }
      }
      const rel = path.relative(REPO, file);
      items.push({
        file: rel,
        line: li + 1,
        method,
        how: info.how,
        bounded: info.bounded,
        marked: MARKER.test(prev),
        key: rel + '::' + method,
      });
    }
  }
  return items;
}

function readAllow() {
  if (!existsSync(ALLOW_FILE)) return [];
  return readFileSync(ALLOW_FILE, 'utf8').split('\n').map((s) => s.trim()).filter((s) => s && !s.startsWith('#'));
}

function validate(items, allow, maxAllow) {
  const violations = [];
  if (allow.length > maxAllow) {
    violations.push({ type: 'allow-overflow', msg: '豁免表 ' + allow.length + ' 条 > 上限 ' + maxAllow + '（清理后必须同步下调 MAX_ALLOW）' });
  }
  const keys = new Set(items.map((i) => i.key));
  const allowed = new Set(allow);
  for (const entry of allow) {
    if (!keys.has(entry)) violations.push({ type: 'stale-allow', msg: '豁免条目已失效（源码里不再有该无上限查询）：' + entry });
  }
  const reported = new Set();
  for (const it of items) {
    if (it.bounded || it.marked || allowed.has(it.key)) continue;
    const k = it.key + '#' + it.line;
    if (reported.has(k)) continue;
    reported.add(k);
    violations.push({
      type: 'missing-limit',
      msg: it.file + ':' + it.line + ' ' + it.method + '() 里的 findMany 无上限（' + it.how + '）：既没 take、也没按父实体过滤、也没写 // @no-limit: 理由',
    });
  }
  return violations;
}

function selftest() {
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'query-limit-'));
  const dir = path.join(tmp, 'src', 'modules', 'demo');
  mkdirSync(dir, { recursive: true });
  const cases = [
    // 有界的三条正路
    { name: 'ok-take', expect: 0, code: 'class A {\n  async x() {\n    return this.prisma.a.findMany({ where: { projectId: p }, take: 20 });\n  }\n}' },
    { name: 'ok-parent-eq', expect: 0, code: 'class A {\n  async x() {\n    return this.prisma.a.findMany({ where: { contractId: c1 } });\n  }\n}' },
    { name: 'ok-parent-in', expect: 0, code: 'class A {\n  async x() {\n    return this.prisma.a.findMany({ where: { id: { in: ids } } });\n  }\n}' },
    { name: 'ok-marked', expect: 0, code: 'class A {\n  async x() {\n    // @no-limit: 合规性为内存派生列，必须取全量再切片\n    return this.prisma.a.findMany({ where: { projectId: p } });\n  }\n}' },
    // 无上限
    { name: 'bad-project-only', expect: 1, code: 'class A {\n  async x() {\n    return this.prisma.a.findMany({ where: { projectId: p } });\n  }\n}' },
    // (1) select 里出现主键不再算有界
    { name: 'bad-select-id', expect: 1, code: 'class A {\n  async x() {\n    return this.prisma.a.findMany({ where: { projectId: p }, select: { id: true } });\n  }\n}' },
    { name: 'bad-order-by-id', expect: 1, code: 'class A {\n  async x() {\n    return this.prisma.a.findMany({ where: { projectId: p }, orderBy: { id: desc } });\n  }\n}' },
    // (2) 嵌套 take / 注释里的 take 都不算
    { name: 'bad-nested-take', expect: 1, code: 'class A {\n  async x() {\n    return this.prisma.a.findMany({ where: { projectId: p }, include: { details: { take: 5 } } });\n  }\n}' },
    { name: 'bad-comment-take', expect: 1, code: 'class A {\n  async x() {\n    return this.prisma.a.findMany({\n      // 以前这里靠 take: 100 兜底\n      where: { projectId: p },\n    });\n  }\n}' },
    // (3) 模糊条件不算父子过滤
    { name: 'bad-contains', expect: 1, code: 'class A {\n  async x() {\n    return this.prisma.a.findMany({ where: { projectId: p, contractNo: { contains: kw } } });\n  }\n}' },
    // where 不是字面量：静态看不出，要写理由
    { name: 'bad-where-var', expect: 1, code: 'class A {\n  async x() {\n    return this.prisma.a.findMany({ where });\n  }\n}' },
    // 完全没有 where
    { name: 'bad-no-where', expect: 1, code: 'class A {\n  async x() {\n    return this.prisma.a.findMany({ select: { id: true } });\n  }\n}' },
  ];
  const out = [];
  let ok = true;
  for (const c of cases) {
    writeFileSync(path.join(dir, 'demo.service.ts'), c.code + '\n', 'utf8');
    const items = scan(path.join(tmp, 'src'));
    const v = validate(items, [], Number.MAX_SAFE_INTEGER);
    const pass = v.length === c.expect;
    ok = ok && pass;
    out.push(c.name + ': violations=' + v.length + ' want=' + c.expect + ' ' + (pass ? 'OK' : 'FAIL'));
  }
  return { ok, out };
}

if (flag('--selftest')) {
  const r = selftest();
  for (const l of r.out) console.log(l);
  console.log(r.ok ? 'selftest OK' : 'selftest FAILED');
  process.exit(r.ok ? 0 : 1);
}

const items = scan(SRC_DIR);
const allow = readAllow();
const violations = validate(items, allow, MAX_ALLOW);

if (flag('--json')) {
  console.log(JSON.stringify({ total: items.length, bounded: items.filter((i) => i.bounded).length, violations, items }, null, 2));
  process.exit(violations.length ? 1 : 0);
}
if (flag('--list')) {
  for (const it of items) {
    const tag = it.marked ? '  [@no-limit]' : it.bounded ? '  [有界: ' + it.how + ']' : '  [无上限]';
    console.log(it.key + ' #' + it.line + tag);
  }
  console.log('');
  console.log(
    'findMany ' + items.length + ' 处 = 有界 ' + items.filter((i) => i.bounded).length
      + ' + 写明理由 ' + items.filter((i) => !i.bounded && i.marked).length
      + ' + 豁免 ' + allow.length
      + ' + 违规 ' + violations.length,
  );
  process.exit(violations.length ? 1 : 0);
}
if (violations.length) {
  console.error('✖ 列表查询上限门禁失败（' + violations.length + ' 项）');
  for (const v of violations.slice(0, 40)) console.error('  [' + v.type + '] ' + v.msg);
  if (violations.length > 40) console.error('  …… 还有 ' + (violations.length - 40) + ' 项（--list 看全量）');
  console.error('');
  console.error('修法：给该 findMany 加顶层 take（分页/上限）；确实按父实体过滤也算有界；确属有意全量的写 // @no-limit: <理由>；存量加进 scripts/query-limit.allow.txt（只允许变少）。');
  process.exit(1);
}
const boundedCount = items.filter((i) => i.bounded).length;
const reasonedCount = items.filter((i) => !i.bounded && i.marked).length;
console.log(
  '✔ 列表查询上限门禁通过：findMany ' + items.length + ' 处 = 有界 ' + boundedCount
    + ' + 无上限但写明理由 ' + reasonedCount
    + ' + 存量豁免 ' + allow.length + '（上限 ' + MAX_ALLOW + '）',
);
