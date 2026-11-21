#!/usr/bin/env node
/**
 * 列表查询上限门禁（秒级，无 DB）。
 *
 * 背景（2026-11-21 质量评估 P1-4）：全仓 243 处 \`findMany\`，其中只有 34 处带 \`take\`——
 * 台账/结算/采购等列表路径会随项目体量线性涨内存（多张表还会被一次性拉进内存再分组）。
 * 有些全量是**有意**的（如台账带「合规性」内存派生列筛选时必须取全量再切片），
 * 这类必须在源码里写明理由，而不是靠人记得。
 *
 * 规则
 * 1. \`findMany(\` 的调用里必须出现 \`take:\`（分页/上限），否则视为无上限。
 * 2. 确属有意全量的，在同一行或紧邻上一行写 \`// @no-limit: <理由>\`。
 * 3. 存量未收口的走 \`scripts/query-limit.allow.txt\`（按 \`<文件相对路径>::<方法名>\`），
 *    条数不得超 \`MAX_ALLOW\`，且条目必须仍然存在（防僵尸），**只允许变少**。
 *
 * 用法：
 *   node scripts/check-query-limits.mjs            # 校验（CI 用）
 *   node scripts/check-query-limits.mjs --list      # 列清单
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
const MAX_ALLOW = Number(process.env.QUERY_LIMIT_MAX_ALLOW ?? 56);

const argv = process.argv.slice(2);
const flag = (n) => argv.includes(n);
const MARKER = /\/\/\s*@no-limit:\s*\S/;
const METHOD_RE = /^\s{2}(?:private\s+|public\s+|protected\s+|async\s+)*([A-Za-z0-9_]+)\s*\(/;
const NOT_KEYWORD = /^(if|for|while|switch|catch|return)$/;

function walk(dir, out = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

/** 从 \`(\` 起做括号配平，返回调用表达式的结束下标（够用即可：字符串里的括号极少见） */
function callEnd(text, openIdx) {
  let depth = 0;
  for (let i = openIdx; i < text.length; i++) {
    const ch = text[i];
    if (ch === '(' || ch === '[' || ch === '{') depth++;
    else if (ch === ')' || ch === ']' || ch === '}') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return text.length - 1;
}

function scan(dir) {
  const files = walk(dir).filter((f) => /\.(service|query)\.ts$/.test(f) || f.includes(path.sep + 'query' + path.sep));
  const items = [];
  for (const file of files) {
    const src = readFileSync(file, 'utf8');
    const lines = src.split('\n');
    const lineStarts = [];
    let acc = 0;
    for (const l of lines) { lineStarts.push(acc); acc += l.length + 1; }
    const lineOf = (idx) => {
      let lo = 0, hi = lineStarts.length - 1;
      while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (lineStarts[mid] <= idx) lo = mid; else hi = mid - 1; }
      return lo;
    };
    for (const m of src.matchAll(/\.findMany\(/g)) {
      const open = m.index + m[0].length - 1;
      const end = callEnd(src, open);
      const call = src.slice(open, end + 1);
      if (/\btake\s*:/.test(call)) continue;
      // 按父实体过滤的查询天然有界（一个合同/任务/单据的明细），不算「项目级无上限」。
      // projectId 不算：按项目过滤仍可能返回整个项目的全部行。
      const PARENT_KEY = /\b(?:id|contractId|taskId|settlementId|invoiceId|paymentId|orderId|receiptOrderId|materialBaseId|materialId|supplierId|subcontractorId|projectProcedureId|agreementId|ledgerId|docId|finalSettlementId)\s*:\s*(?!\{)/;
      if (PARENT_KEY.test(call)) continue;
      const li = lineOf(m.index);
      const prev = (lines[li] || '') + '\n' + (lines[li - 1] || '');
      // 所在方法名
      let method = '?';
      for (let j = li; j >= 0 && j > li - 120; j--) {
        const mm = lines[j].match(METHOD_RE);
        if (mm && !NOT_KEYWORD.test(mm[1])) { method = mm[1]; break; }
      }
      const rel = path.relative(REPO, file);
      items.push({
        file: rel,
        line: li + 1,
        method,
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
  const reported = new Set();
  for (const entry of allow) {
    if (!keys.has(entry)) violations.push({ type: 'stale-allow', msg: '豁免条目已失效（源码里不再有该无上限查询）：' + entry });
  }
  for (const it of items) {
    if (it.marked || allowed.has(it.key)) continue;
    const k = it.key + '#' + it.line;
    if (reported.has(k)) continue;
    reported.add(k);
    violations.push({
      type: 'missing-take',
      msg: it.file + ':' + it.line + ' ' + it.method + '() 里的 findMany 没有 take（无上限），也没写 // @no-limit: 理由',
    });
  }
  return violations;
}

function selftest() {
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'query-limit-'));
  const dir = path.join(tmp, 'src', 'modules', 'demo');
  mkdirSync(dir, { recursive: true });
  const cases = [
    { name: 'good', code: 'class A {\n  async x() {\n    return this.prisma.a.findMany({ where: { id: 1 }, take: 20 });\n  }\n}', expect: 0 },
    { name: 'bad', code: 'class A {\n  async x() {\n    return this.prisma.a.findMany({ where: { projectId: \'p\' } });\n  }\n}', expect: 1 },
    { name: 'marked', code: 'class A {\n  async x() {\n    // @no-limit: 合规性为内存派生列，必须取全量再切片\n    return this.prisma.a.findMany({ where: { projectId: \'p\' } });\n  }\n}', expect: 0 },
    { name: 'bounded', code: 'class A {\n  async x() {\n    return this.prisma.a.findMany({ where: { contractId: \'c1\' } });\n  }\n}', expect: 0 },
  ];
  const out = [];
  let ok = true;
  for (const c of cases) {
    writeFileSync(path.join(dir, 'demo.service.ts'), c.code + '\n', 'utf8');
    const items = scan(path.join(tmp, 'src'));
    const v = validate(items, [], Number.MAX_SAFE_INTEGER);
    const pass = v.length === c.expect;
    ok = ok && pass;
    out.push(c.name + ': violations=' + v.length + ' ' + (pass ? 'OK' : 'FAIL'));
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
  console.log(JSON.stringify({ total: items.length, allowed: allow.length, violations, items }, null, 2));
  process.exit(violations.length ? 1 : 0);
}
if (flag('--list')) {
  for (const it of items) console.log(it.key + ' #' + it.line + (it.marked ? '  [@no-limit]' : ''));
  console.log('');
  console.log('无上限 findMany: ' + items.length + '（已写理由 ' + items.filter((i) => i.marked).length + '，豁免 ' + allow.length + '）');
  process.exit(0);
}
if (violations.length) {
  console.error('✖ 列表查询上限门禁失败（' + violations.length + ' 项）');
  for (const v of violations.slice(0, 40)) console.error('  [' + v.type + '] ' + v.msg);
  if (violations.length > 40) console.error('  …… 还有 ' + (violations.length - 40) + " 项（--list 看全量）");
  console.error('');
  console.error('修法：给该 findMany 加 take（分页/上限）；确属有意全量的写 // @no-limit: <理由>；存量加进 scripts/query-limit.allow.txt（只允许变少）。');
  process.exit(1);
}
const reasoned = items.filter((i) => i.marked).length;
const perReason = items.length - allow.length;
console.log('✔ 列表查询上限门禁通过：项目级无上限 findMany ' + items.length + ' 处 = 写明理由 ' + reasoned + ' + 存量豁免 ' + allow.length + '（上限 ' + MAX_ALLOW + '）');
