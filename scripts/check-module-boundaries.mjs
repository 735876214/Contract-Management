#!/usr/bin/env node
/**
 * 模块边界检查（秒级，无 DB）。
 *
 * 规则：
 * 1. 模块之间只允许通过公开入口 `<module>/index.ts` 互相引用；
 *    直接引另一个模块的 `.module.ts` / `.service.ts` 等内部文件 = 越界。
 * 2. `auth` 是横切基础设施（JWT / 权限守卫），按白名单允许深层引用。
 * 3. 模块级依赖图不允许出现**静态**循环（SCC > 1）。
 *    循环只看静态 `import ... from`：`await import('../x')` 是运行期加载，不成环，
 *    因此「只借用对方若干无状态写入函数、不注入对方 Service」的场景用动态 import 表达。
 *    此外禁止跨模块直写他人表（见规则 4）。
 * 4. 模块只能写自己拥有的表：`<模块>/*.ts` 里出现 `prisma.<模型>.create/update/upsert/delete*`
 *    或事务句柄 `tx.<模型>.<写方法>`，且该模型的 owner 是别的模块 = 越界。
 *    owner 由「谁在写」聚合成表（见 MODEL_OWNER）。
 *
 * 背景：跨模块 import 曾全部指向 `<m>.module` / `<m>.service`，没有 DTO/类型，
 * 因此可以用一个入口文件收口；`archive` / `ai` 是刻意的聚合器（fan-out 大，但仍须走入口）。
 *
 * 用法：node scripts/check-module-boundaries.mjs [--quiet]
 * 退出码：0 通过 / 1 有越界或环 / 2 环境错误
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const quiet = process.argv.includes('--quiet');

/** 横切基础设施：允许任何模块深层引用（守卫/装饰器） */
const INFRA_MODULES = new Set(['auth']);

/** 归档是聚合器，但跨域读取必须走 query/，不得自己 prisma.<模型> */
const ARCHIVE_DIR = 'server/src/modules/archive/';
/**
 * 工作台同样是纯只读聚合器（读 10 张表），跨域读取一律走 `query/dashboard-queries.ts`。
 * 2026-11-23 收敛前它有 37 处 `prisma.<模型>`——口径改动要在工作台里再抄一遍 where，
 * 抄漏就是第二套口径，而且检查器锁不住。收敛后为 0，从此由本规则守门。
 */
const DASHBOARD_DIR = 'server/src/modules/dashboard/';

/**
 * AI 根目录的 service 不得直查业务域事实表（必须走 server/src/query/）。
 * 例外：`register.service.ts` 是刻意的写路径（复用 ContractService/SupplierService 的校验）。
 * 子目录（analytics/anomaly/analysis）按只读子域规则处理。
 */
const AI_ROOT_DIR = 'server/src/modules/ai/';
const AI_ROOT_WRITE_ALLOWLIST = new Set(['register.service.ts']);
const AI_FACT_MODELS = new Set([
  'contract',
  'settlement',
  'paymentRecord',
  'invoice',
  'dailyReport',
  'procurementTask',
  'monthlyProfitLoss',
  'assetLedger',
  'settlementLedger',
  'project',
  'supplier',
]);

/**
 * AI 的只读子域：只允许读、不允许依赖业务模块。
 * `ai/register.service.ts` 是刻意的写路径（复用 ContractService/SupplierService 的校验），不在名单内。
 */
const AI_READ_ONLY_DIRS = [
  'server/src/modules/ai/analytics/',
  'server/src/modules/ai/anomaly/',
  'server/src/modules/ai/analysis/',
];

/**
 * **AI 只读子域不得内联口径片段**（2026-11-23 架构评审 P1）。
 *
 * §3.1 允许只读子域自己写**明细查询**（数据集逐行取数，字段各异、无法复用 `load*Facts()`），
 * 但口径的原子片段只能来自单一来源：`notDraft` / `paidPaymentWhere()` / `countedInvoiceWhere()`。
 * 手写等价 where 的后果是"排除草稿/排除失败退款/排除红冲"各写一遍，改一处漏一处——
 * 这类副本在 SQL 三值逻辑下还会静默漏掉 `NULL` 状态行。
 */
const INLINE_PREDICATE_RULES = [
  {
    re: /statusCode:\s*\{\s*not:\s*['"]DRAFT['"]\s*\}/g,
    hint: "改用 constants/statuses.ts 的 notDraft（它显式把 NULL 算作非草稿）",
  },
  {
    re: /notIn:\s*\[[^\]]*['"]DRAFT['"][^\]]*\]/g,
    hint: '改用 notDraft：手写 notIn 会在 SQL 三值逻辑下漏掉 statusCode IS NULL 的行',
  },
  {
    re: /(?:notIn|in):\s*\[[^\]]*['"](?:FAILED|REFUNDED)['"][^\]]*\]/g,
    hint: '改用 constants/statuses 的 paidPaymentWhere() / PAYMENT_EXCLUDED_STATUSES',
  },
  {
    re: /(?:notIn|in):\s*\[[^\]]*['"](?:CANCELLED|RED)['"][^\]]*\]/g,
    hint: '改用 constants/statuses 的 countedInvoiceWhere() / INVOICE_EXCLUDED_STATUSES',
  },
];

/** fan-out 超过该值的模块会在输出里标为聚合器（仅供参考，不是错误） */
const AGGREGATOR_FANOUT = 5;

let root;
try {
  root = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
} catch {
  console.error('[module-boundaries] 不在 git 仓库内');
  process.exit(2);
}

const tracked = execFileSync('git', ['ls-files'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  .split('\n')
  .filter(Boolean);
const trackedSet = new Set(tracked);

const MODULES_DIR = 'server/src/modules/';
const isTs = (f) => /\.(ts|tsx)$/.test(f) && !f.endsWith('.d.ts');
const moduleOf = (f) => (f.startsWith(MODULES_DIR) ? f.slice(MODULES_DIR.length).split('/')[0] : null);

const IMPORT_RE = /\bfrom\s+['"]([^'"]+)['"]|\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
/** 只匹配静态 import：循环检测用它（动态 import 是运行期加载，不成环） */
const STATIC_IMPORT_RE = /\bfrom\s+['"]([^'"]+)['"]/g;

function resolve(fromFile, spec) {
  if (!spec.startsWith('.')) return null;
  const base = path.posix.normalize(path.posix.join(path.posix.dirname(fromFile), spec));
  const candidates = [base + '.ts', base + '.tsx', base + '/index.ts', base + '/index.tsx'];
  for (const c of candidates) if (trackedSet.has(c)) return c;
  return null;
}

const files = tracked.filter((f) => f.startsWith(MODULES_DIR) && isTs(f) && !f.endsWith('/index.ts'));
const violations = [];
const readViolations = [];
const edges = new Map(); // module -> Set<module>

for (const file of files) {
  const fromMod = moduleOf(file);
  if (!fromMod) continue;
  const src = readFileSync(path.join(root, file), 'utf8');

  // 归档：跨域读取必须走 server/src/query/*
  if (file.startsWith(ARCHIVE_DIR)) {
    const m = /\bprisma\.[A-Za-z]\w*/.exec(src);
    if (m) {
      readViolations.push({
        file,
        line: src.slice(0, m.index).split('\n').length,
        rule: `archive 不得直接查表（命中 ${m[0]}），改走 server/src/query/ 的只读查询`,
      });
    }
  }

  // 工作台：同上（聚合读取全部收进 query/dashboard-queries.ts）
  if (file.startsWith(DASHBOARD_DIR)) {
    const m = /\bprisma\.[A-Za-z]\w*/.exec(src);
    if (m) {
      readViolations.push({
        file,
        line: src.slice(0, m.index).split('\n').length,
        rule: `dashboard 不得直接查表（命中 ${m[0]}），改走 server/src/query/dashboard-queries.ts 的只读查询`,
      });
    }
  }

  // AI 根目录：业务事实表必须走 query/（register 的写路径是刻意例外）
  const aiRel = file.startsWith(AI_ROOT_DIR) ? file.slice(AI_ROOT_DIR.length) : '';
  if (aiRel && !aiRel.includes('/') && !AI_ROOT_WRITE_ALLOWLIST.has(aiRel)) {
    for (const m of src.matchAll(/\bprisma\.([A-Za-z]\w*)/g)) {
      if (!AI_FACT_MODELS.has(m[1])) continue;
      readViolations.push({
        file,
        line: src.slice(0, m.index).split('\n').length,
        rule: `AI 根目录不得直查业务事实表（命中 prisma.${m[1]}），请改用 server/src/query/ 的 load*Facts()`,
      });
    }
  }

  const aiReadOnly = AI_READ_ONLY_DIRS.some((d) => file.startsWith(d));

  // AI 只读子域：明细查询允许，但口径片段不得内联（必须 import 单一来源）
  if (aiReadOnly) {
    for (const rule of INLINE_PREDICATE_RULES) {
      rule.re.lastIndex = 0;
      let pm;
      while ((pm = rule.re.exec(src))) {
        readViolations.push({
          file,
          line: src.slice(0, pm.index).split('\n').length,
          rule: `AI 只读子域不得内联口径片段（命中「${pm[0].replace(/\s+/g, ' ').trim()}」）— ${rule.hint}`,
        });
      }
    }
  }
  for (const m of src.matchAll(IMPORT_RE)) {
    const spec = m[1] || m[2];
    const target = resolve(file, spec);
    if (!target) continue;
    const toMod = moduleOf(target);
    if (!toMod || toMod === fromMod) continue;

    if (INFRA_MODULES.has(toMod)) continue;

    // AI 只读子域不得依赖业务模块（读数据走 Prisma / 查询层，写数据走 register 的显式白名单）
    if (aiReadOnly) {
      readViolations.push({
        file,
        line: src.slice(0, m.index).split('\n').length,
        rule: `AI 只读子域不得依赖业务模块（${fromMod} -> ${toMod}）；需要数据请在 ai 内直接查询或用 server/src/query/`,
      });
      continue;
    }

    const isPublicEntry = target === `${MODULES_DIR}${toMod}/index.ts`;
    if (!isPublicEntry) {
      violations.push({
        file,
        from: fromMod,
        to: toMod,
        target,
        spec,
        line: src.slice(0, m.index).split('\n').length,
      });
    }
  }

  // 依赖边只取静态 import（动态 import 是运行期加载，不进 SCC 图）
  for (const m of src.matchAll(STATIC_IMPORT_RE)) {
    const target = resolve(file, m[1]);
    if (!target) continue;
    const toMod = moduleOf(target);
    if (!toMod || toMod === fromMod) continue;
    if (!edges.has(fromMod)) edges.set(fromMod, new Set());
    edges.get(fromMod).add(toMod);
  }
}

// ---------------- 规则 4：跨模块直写他人表 ----------------
/** schema.prisma 里的模型名集合（PascalCase → Prisma 客户端属性名 camelCase） */
const SCHEMA = trackedSet.has('server/prisma/schema.prisma')
  ? readFileSync(path.join(root, 'server/prisma/schema.prisma'), 'utf8')
  : '';
const MODEL_PROPS = new Set(
  [...SCHEMA.matchAll(/^model\s+(\w+)\s*\{/gm)].map((m) => m[1].charAt(0).toLowerCase() + m[1].slice(1)),
);
/** 任意句柄（this.prisma / tx / t / db …）上的写方法调用 */
const WRITE_RE = /\b([A-Za-z_$][\w$]*)\.([A-Za-z]\w*)\.(create|createMany|update|updateMany|upsert|delete|deleteMany)\b/g;

/** 表归属覆盖：语义归属与「写入次数最多者」不一致时在此钉死 */
const MODEL_OWNER_OVERRIDES = {
  user: 'system',
  contractTemplate: 'template',
  contractMaterial: 'material',
};

const writeSites = []; // {file, module, model, line}
for (const file of files) {
  const fromMod = moduleOf(file);
  if (!fromMod) continue;
  const src = readFileSync(path.join(root, file), 'utf8');
  const rel = path.posix.basename(file);
  for (const m of src.matchAll(WRITE_RE)) {
    const model = m[2];
    if (!MODEL_PROPS.has(model)) continue;
    writeSites.push({ file, module: fromMod, model, line: src.slice(0, m.index).split('\n').length, aiAllow: AI_ROOT_WRITE_ALLOWLIST.has(rel) });
  }
}

/** 归属 = 覆盖表优先，否则取写该表次数最多的模块（并列时按模块名排序取第一个） */
const ownerOf = new Map();
{
  const counts = new Map(); // model -> Map(module -> n)
  for (const s of writeSites) {
    if (!counts.has(s.model)) counts.set(s.model, new Map());
    const c = counts.get(s.model);
    c.set(s.module, (c.get(s.module) || 0) + 1);
  }
  for (const [model, c] of counts) {
    const best = [...c.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0][0];
    ownerOf.set(model, MODEL_OWNER_OVERRIDES[model] || best);
  }
  for (const [model, owner] of Object.entries(MODEL_OWNER_OVERRIDES)) ownerOf.set(model, owner);
}

const writeViolations = writeSites
  .filter((s) => !s.aiAllow && ownerOf.get(s.model) !== s.module)
  .map((s) => ({
    file: s.file,
    line: s.line,
    rule: `跨模块直写他人表：${s.module} 写了 ${s.model}（owner=${ownerOf.get(s.model)}）。改走对方模块 index.ts 导出的写入原语，或在对方模块提供语义化写入函数`,
  }));

// 模块级循环检测（Tarjan SCC）
function findCycles(graph) {
  let index = 0;
  const stack = [];
  const onStack = new Set();
  const indices = new Map();
  const low = new Map();
  const sccs = [];
  const strongConnect = (v) => {
    indices.set(v, index);
    low.set(v, index);
    index++;
    stack.push(v);
    onStack.add(v);
    for (const w of graph.get(v) || []) {
      if (!indices.has(w)) {
        strongConnect(w);
        low.set(v, Math.min(low.get(v), low.get(w)));
      } else if (onStack.has(w)) {
        low.set(v, Math.min(low.get(v), indices.get(w)));
      }
    }
    if (low.get(v) === indices.get(v)) {
      const comp = [];
      let w;
      do {
        w = stack.pop();
        onStack.delete(w);
        comp.push(w);
      } while (w !== v);
      if (comp.length > 1) sccs.push(comp.sort());
    }
  };
  for (const v of graph.keys()) if (!indices.has(v)) strongConnect(v);
  return sccs;
}

const cycles = findCycles(edges);
const aggregators = [...edges]
  .filter(([, s]) => s.size > AGGREGATOR_FANOUT)
  .sort((a, b) => b[1].size - a[1].size);

if (!violations.length && !readViolations.length && !cycles.length && !writeViolations.length) {
  if (!quiet) {
    const msg = [`[module-boundaries] OK：${files.length} 个模块内文件，无越界 import、无模块环、无跨模块写表`];
    if (aggregators.length) {
      msg.push(`  聚合器（fan-out > ${AGGREGATOR_FANOUT}，允许但请走公开入口）：` +
        aggregators.map(([m, s]) => `${m}(${s.size})`).join(', '));
    }
    console.log(msg.join('\n'));
  }
  process.exit(0);
}

if (cycles.length) {
  console.error('[module-boundaries] 模块级循环依赖：');
  for (const c of cycles) console.error(`  - ${c.join(' ↔ ')}`);
  console.error('  修法：把共享部分下沉到 common/，或改成只依赖对方公开入口的单向调用；\n  若只是借用对方几个无状态写入函数，改 `await import(...)`（运行期加载，不进 SCC 图）。\n');
}
if (readViolations.length) {
  console.error('[module-boundaries] 读取边界违规：');
  for (const v of readViolations) console.error(`  ${v.file}:${v.line}  ${v.rule}`);
  console.error('');
}
if (writeViolations.length) {
  console.error(`[module-boundaries] ${writeViolations.length} 处跨模块直写他人表：\n`);
  for (const v of writeViolations) console.error(`  ${v.file}:${v.line}  ${v.rule}`);
  console.error('');
}
if (violations.length) {
  console.error(`[module-boundaries] ${violations.length} 处越界 import（必须走公开入口 <module>/index.ts）：\n`);
  for (const v of violations) {
    console.error(`  ${v.file}:${v.line}  ${v.from} -> ${v.to}`);
    console.error(`      from '${v.spec}'   （目标 ${v.target}）`);
    console.error(`      改成 from '${v.spec.replace(/\/[^/]+\/?$/, '')}' 并确认 index.ts 已导出所需符号`);
  }
}
process.exit(1);
