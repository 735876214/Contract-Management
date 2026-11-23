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

 * 5. `server/src/common/utils/` **白名单制**：只放「与业务口径无关的通用件」，
 *    新增文件必须登记在 COMMON_UTILS_ALLOWLIST 并写明理由。
 *    业务语义（谁能改这个数字/状态）请放 owner 模块或 `server/src/domain/`——
 *    否则这里会重新变成口径的垃圾场（2026-11-23 P2 前它装着 16 个业务口径文件）。
 *
 * 背景：跨模块 import 曾全部指向 `<m>.module` / `<m>.service`，没有 DTO/类型，
 * 因此可以用一个入口文件收口；`archive` / `ai` 是刻意的聚合器（fan-out 大，但仍须走入口）。
 *
 * 用法：node scripts/check-module-boundaries.mjs [--quiet] [--self-test]
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

/**
 * 任意句柄（`this.prisma` / `tx` / `t` / `db` …）上的写方法调用。
 *
 * ⚠️ 句柄与模型名之间、模型名与方法名之间**允许换行**（`\s*`）。
 * 2026-11-23 之前这里是行内正则，格式化把 `.deleteMany(...)` 折到下一行时该写点会**静默漏检**——
 * 真实后果：`procurement` 越过 `contract` 直接删合同表，门禁仍打印 OK。
 * 改动本正则必须同时跑 `--self-test`（见下）。
 */
const WRITE_RE =
  /\b([A-Za-z_$][\w$]*)\s*\.\s*([A-Za-z]\w*)\s*\.\s*(create|createMany|createManyAndReturn|update|updateMany|upsert|delete|deleteMany)\b/g;

/** 扫描一段源码里的写点（不判归属）；行号按原文偏移算，跨行也能报准 */
function scanWriteSites(source) {
  const out = [];
  for (const m of source.matchAll(WRITE_RE)) {
    out.push({ handle: m[1], model: m[2], op: m[3], line: source.slice(0, m.index).split('\n').length });
  }
  return out;
}

/**
 * 门禁自证（`--self-test`）：证明「写点检测」本身有效，而不只是当前代码恰好干净。
 *
 * 没有反向断言的检查器等于没有检查器：2026-11-23 之前正是因为它漏检跨行写点，
 * 才让跨模块直写他人表在门禁全绿的情况下长期存在。
 */
function runSelfTest() {
  const MODELS = new Set(['contract', 'settlement', 'materialBase']);
  const cases = [
    { name: '单行写点', src: 'await this.prisma.contract.delete({ where: { id } });', want: [['contract', 'delete', 1]] },
    { name: '跨行：模型名与方法名之间换行', src: 'await this.prisma.contract\n  .deleteMany({ where: { id: { in: ids } } });', want: [['contract', 'deleteMany', 1]] },
    { name: '跨行：句柄与模型名之间换行', src: 'await tx\n  .settlement.update({ where: { id }, data });', want: [['settlement', 'update', 1]] },
    { name: '多行链式（真实回归样例）', src: 'if (x) {\n  await this.prisma.contract\n    .deleteMany({ where: { id: { in: ids } } })\n    .catch(() => undefined);\n}', want: [['contract', 'deleteMany', 2]] },
    { name: '非模型字段不算写点', src: 'await foo.bar.create({ data });', want: [] },
    { name: '读方法不是写点', src: 'await this.prisma.contract.findMany({ where: { projectId } });', want: [] },
  ];
  let failed = 0;
  for (const c of cases) {
    const got = scanWriteSites(c.src)
      .filter((s) => MODELS.has(s.model))
      .map((s) => [s.model, s.op, s.line]);
    if (JSON.stringify(got) !== JSON.stringify(c.want)) {
      failed++;
      console.error(`  ✗ ${c.name}\n      期望 ${JSON.stringify(c.want)}\n      实际 ${JSON.stringify(got)}`);
    } else if (!quiet) {
      console.log(`  ✓ ${c.name}`);
    }
  }
  if (failed) {
    console.error(`[module-boundaries] 自证失败 ${failed}/${cases.length}：写点检测已失效，规则 4 的「无跨模块写表」结论不可信`);
    process.exit(1);
  }
  if (!quiet) console.log('[module-boundaries] 自证通过：写点检测覆盖单行与跨行形态');
  process.exit(0);
}

// 自证要在读 git 之前就结束，保证它只依赖正则、不依赖仓库状态
if (process.argv.includes('--self-test')) runSelfTest();

/**
 * **`common/utils/` 白名单**（2026-11-23 架构评审 P2，规则 5）。
 *
 * 这个目录只放「与业务口径无关、谁都能用」的通用件：where 组合器 / CSV / 掩码 / 存储键 /
 * 导入解析 / 分页 / 上传规则 / 口令强度 …。迁移前它还装着 16 个**业务口径**文件
 * （合同链金额、结算期、金额上限、逾期汇总、台账派生、付款安排…），后果是
 * 「这个数字该找谁签」没人答得出——`docs/report-metrics.md` 的 owner 列只能靠记性。
 *
 * 新增文件时二选一，然后把它登记到下面：
 * - 业务口径 → owner 模块（`modules/<owner>/`，跨模块走 `index.ts`）；
 * - 多模块共用且不能归任一模块的**纯口径原语** → `server/src/domain/`（零 DB、零装饰器）。
 */
const COMMON_UTILS_ALLOWLIST = new Set([
  'assert-permission.ts',
  'csv.ts',
  'doc-vars.ts',
  'docx-patch.ts',
  'error-envelope.ts',
  'excel-sheet.ts',
  'group-sum.ts',
  'helpers.ts',
  'import-parse.ts',
  'import-result.ts',
  'import-task.ts',
  'list-where.ts',
  'mask.ts',
  'paged.ts',
  'password-policy.ts',
  'prisma-error.ts',
  'project-context-message.ts',
  'project-scope.ts',
  'public-params.ts',
  'safe-url.ts',
  'storage-audit.ts',
  'storage-keys.ts',
  'storage-url.ts',
  'upload-rules.ts',
]);

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
  for (const site of scanWriteSites(src)) {
    if (!MODEL_PROPS.has(site.model)) continue;
    writeSites.push({ file, module: fromMod, model: site.model, line: site.line, aiAllow: AI_ROOT_WRITE_ALLOWLIST.has(rel) });
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

// ---------------- 规则 5：common/utils 只许白名单 ----------------
const COMMON_UTILS_DIR = 'server/src/common/utils/';
const commonUtilsViolations = tracked
  .filter((f) => f.startsWith(COMMON_UTILS_DIR) && isTs(f))
  .filter((f) => !COMMON_UTILS_ALLOWLIST.has(path.posix.basename(f)))
  .map((f) => ({
    file: f,
    line: 1,
    rule: 'common/utils 只放通用件（白名单制）：先判断归属——业务口径放 owner 模块，多模块共用的纯口径原语放 server/src/domain/；确属通用件再登记 COMMON_UTILS_ALLOWLIST',
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

if (!violations.length && !readViolations.length && !cycles.length && !writeViolations.length && !commonUtilsViolations.length) {
  if (!quiet) {
    const msg = [`[module-boundaries] OK：${files.length} 个模块内文件，无越界 import、无模块环、无跨模块写表，common/utils 全部在白名单内`];
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
if (commonUtilsViolations.length) {
  console.error('[module-boundaries] ' + commonUtilsViolations.length + ' 个 common/utils 文件不在白名单：');
  for (const v of commonUtilsViolations) console.error('  ' + v.file + '  ' + v.rule);
  
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
