import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { METRICS, METRIC_IDS } from '../src/constants/metrics.ts';

/**
 * **报表口径单一实现锁**（2026-11-23 架构评审 P1）。
 *
 * 背景：系统的真痛点是「同一个指标在不同页面各算一遍」——合同额在看板是裸 `SUM(amount)`、
 * 在台账是「链根只计一次」，有补充协议时两个数字对不上，且没人能列出系统到底有哪些指标。
 * `server/src/constants/metrics.ts` 是登记表，本文件是它的**执行者**。
 *
 * 三道锁（任一漂移即红）：
 * 1. **代码标记**：每个登记指标的唯一实现上方必须有 `// @metric: <id>`，且全仓**恰好一次**
 *    （两处 = 口径分叉；零处 = 实现被删/改名而登记表没跟上）；
 * 2. **登记一致**：标记所在文件必须等于登记表 `impl` 的路径部分，且 `impl` 的符号确实在该文件里出现；
 * 3. **文档一致**：`docs/report-metrics.md` 必须逐行列出每个 id（与 `docStats` 锁活文档同一套思路）。
 *
 * ⚠️ 本文件只校验「登记的那些**确实唯一**」，证明不了「所有指标都登记了」。
 * 发现新的分叉时，先收敛再登记，并同步文档——不要把已知不一致直接登记进来（等于把错误固化）。
 */

const abs = (rel) => fileURLToPath(new URL('../../' + rel, import.meta.url));
const SRC = 'server/src';

/** 递归收集 server/src 下的 .ts / .mts 源文件（仓库相对路径，posix 分隔） */
function collectSourceFiles() {
  const out = [];
  const walk = (rel) => {
    for (const name of readdirSync(abs(rel))) {
      const childRel = rel + '/' + name;
      if (statSync(abs(childRel)).isDirectory()) walk(childRel);
      else if (/\.(ts|mts)$/.test(name) && !name.endsWith('.d.ts')) out.push(childRel);
    }
  };
  walk(SRC);
  return out;
}

const SOURCE_FILES = collectSourceFiles();

/** id → 命中位置（文件 + 行号） */
function collectTags() {
  const hits = new Map();
  for (const file of SOURCE_FILES) {
    const src = readFileSync(abs(file), 'utf8');
    if (!src.includes('@metric:')) continue;
    src.split('\n').forEach((l, i) => {
      const m = /\/\/\s*@metric:\s*([A-Za-z0-9._-]+)/.exec(l);
      if (!m) return;
      const id = m[1];
      if (!hits.has(id)) hits.set(id, []);
      hits.get(id).push({ file: file, line: i + 1 });
    });
  }
  return hits;
}

describe('报表口径单一实现锁', () => {
  it('登记表本身：id 非空、唯一，impl 都带 # 符号', () => {
    assert.ok(METRICS.length >= 5, '登记表疑似被清空（' + METRICS.length + ' 条）');
    const seen = new Set();
    for (const m of METRICS) {
      assert.ok(m.id && m.id.trim() === m.id, '指标 id 非法：' + m.id);
      assert.ok(!seen.has(m.id), '指标 id 重复：' + m.id);
      seen.add(m.id);
      assert.match(m.impl, /^server\/src\/.+#[A-Za-z_$][\w$]*$/, m.id + ' 的 impl 必须写成 <路径>#<符号>');
      assert.ok(m.owner, m.id + ' 缺 owner（改口径该谁签字）');
      assert.ok(m.note, m.id + ' 缺口径说明（排除项必须写清）');
      assert.equal(m.id, m.id.toLowerCase(), m.id + ' 必须全小写短横线风格');
    }
  });

  it('每个登记指标在源码里恰好有一个 @metric 标记', () => {
    const tags = collectTags();
    const problems = [];
    for (const id of METRIC_IDS) {
      const hit = tags.get(id) || [];
      if (hit.length === 0) problems.push(id + '：没有任何 // @metric: ' + id + ' 标记（实现被删/改名，或忘了加标记）');
      if (hit.length > 1) {
        problems.push(
          id + '：出现 ' + hit.length + ' 次（口径分叉，必须收敛成一处在 owner 模块）\n      ' +
            hit.map((h) => h.file + ':' + h.line).join('\n      '),
        );
      }
    }
    assert.deepEqual(problems, [], '\n  ' + problems.join('\n  '));
  });

  it('标记位置与登记表 impl 一致，且符号真的在那个文件里', () => {
    const tags = collectTags();
    const problems = [];
    for (const m of METRICS) {
      const parts = m.impl.split('#');
      const implFile = parts[0];
      const symbol = parts[1];
      const hit = (tags.get(m.id) || [])[0];
      if (!hit) continue; // 上一条已报
      if (hit.file !== implFile) {
        problems.push(m.id + '：标记在 ' + hit.file + '，登记表写的是 ' + implFile);
        continue;
      }
      const src = readFileSync(abs(implFile), 'utf8');
      if (!new RegExp('\\b' + symbol + '\\b').test(src)) {
        problems.push(m.id + '：' + implFile + ' 里找不到符号 ' + symbol + '（impl 写错了或函数改名）');
      }
    }
    assert.deepEqual(problems, [], '\n  ' + problems.join('\n  '));
  });

  it('没有孤儿标记（源码里有 @metric 但登记表没登记）', () => {
    const tags = collectTags();
    const orphans = [...tags.keys()].filter((id) => !METRIC_IDS.includes(id));
    const detail = orphans
      .map((id) => id + ' @ ' + tags.get(id).map((h) => h.file + ':' + h.line).join(', '))
      .join('\n  ');
    assert.deepEqual(orphans, [], '以下标记未登记进 server/src/constants/metrics.ts：\n  ' + detail);
  });

  it('docs/report-metrics.md 逐行登记了每个口径', () => {
    const doc = readFileSync(abs('docs/report-metrics.md'), 'utf8');
    // 防恒真：先确认文档确实有那张表
    assert.ok(doc.includes('| 指标 id |'), 'docs/report-metrics.md 的表格似乎不见了');
    const BT = '\u0060';
    const missing = METRIC_IDS.filter((id) => !new RegExp('^\\s*\\|\\s*' + BT + id + BT + '\\s*\\|', 'm').test(doc));
    assert.deepEqual(missing, [], '以下指标未在 docs/report-metrics.md 的表格里登记：\n  ' + missing.join('\n  '));
  });
});
