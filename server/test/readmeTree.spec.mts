import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * README 目录树漂移锁。
 *
 * 起因（2026-11-28 自审 PR #52）：给 `mcp/` 加了 `src/generated/`（插件 MCP 工具清单的生成物），
 * 顺手在 `mcp/README.md` 里把 `server.ts` 那行注释改成「插件工具在 generated/ 下」，
 * 但**目录树那一行没加上**——替换锚点写成了 `├── index.ts`，实际是 `└── index.ts`，
 * `String.replace` 静默没命中，而我只看了「测试绿了」，没回看图。结果：注释指向 `generated/`，
 * 图上压根没这个目录，读者按图找不到。
 *
 * `docStats.spec.mts` 锁的是**数字**（N 个 spec / model / 迁移），锁不住这种**结构性**漂移，故另起一件：
 *  1. 树里写了的条目必须真实存在 —— 防幽灵条目（文件删了/改名了，图还留着旧的）；
 *  2. 指定的代码目录必须**穷尽** —— 防漏条目（加了文件不更新图，正是上面那次）。
 *
 * 为什么不是「所有目录都穷尽」：仓库根的树是有意节选的（`dist/`、`node_modules/`、一堆配置文件
 * 列进来是噪音），所以每个目标自己声明要穷尽的目录；`'*'` 表示「凡是展开了子项的目录都必须穷尽」。
 */

const abs = (rel: string) => fileURLToPath(new URL(`../../${rel}`, import.meta.url));
const read = (rel: string) => readFileSync(abs(rel), 'utf8');

interface TreeTarget {
  /** 仓库相对的 README 路径 */
  doc: string;
  /** 必须穷尽列出的目录（仓库相对路径）；`'*'` = 所有展开了子项的目录 */
  exhaustive: '*' | string[];
  /** 防空转：解析到的条目数下限 */
  minEntries: number;
}

const TARGETS: TreeTarget[] = [
  // 根目录树有意只列要点（dist/ node_modules/ package.json… 不列），但 src/ 必须一个不漏
  { doc: 'mcp/README.md', exhaustive: ['mcp/src'], minEntries: 10 },
  // 这份是插件规范的「照抄起步」图，整棵树都该与磁盘一致
  { doc: 'server/src/plugins/README.md', exhaustive: '*', minEntries: 14 },
];

const GLYPH = /^((?:│   |    )*)(?:├── |└── )(.+)$/;
/** 根行：无树线、以 / 结尾，如 `mcp/`、`server/src/plugins/` */
const ROOT_LINE = /^[\w./-]+\/$/;

interface ParsedTree {
  /** 树里出现的每个条目（仓库相对路径） */
  entries: string[];
  /** 目录（仓库相对路径）→ 树里列出的直接子项名 */
  children: Map<string, Set<string>>;
}

function parseTrees(doc: string): ParsedTree {
  const fences = read(doc).match(/```[a-z]*\n[\s\S]*?```/g) ?? [];
  const entries: string[] = [];
  const children = new Map<string, Set<string>>();
  let roots = 0;

  for (const fence of fences) {
    const body = fence.replace(/^```[a-z]*\n/, '').replace(/```$/, '');
    const lines = body.split('\n');
    if (!lines.some((l) => GLYPH.test(l))) continue;

    let root = '';
    /** 深度 d → 该层对应的目录（仓库相对）；供下一层当父级 */
    const stack: string[] = [];

    for (const raw of lines) {
      const line = raw.trimEnd();
      if (!line.trim()) continue;

      const m = line.match(GLYPH);
      if (!m) {
        // 一个 ``` 里可以写多棵树（如 server/src/plugins/ + web/src/plugins/）
        if (ROOT_LINE.test(line.trim())) {
          root = line.trim().replace(/\/$/, '');
          roots += 1;
          stack.length = 0;
        }
        continue;
      }
      if (!root) continue;

      const depth = m[1].length / 4;
      // 去掉行尾注释：`├── 名字   # 说明`
      const name = m[2].replace(/\s{2,}#.*$/, '').trim();
      if (!name) continue;

      const segments = name.replace(/\/$/, '').split('/');
      const parent = depth === 0 ? root : stack[depth - 1];
      if (!parent) continue;

      entries.push(`${parent}/${segments.join('/')}`);
      // 只记第一段：树里允许压缩写法（`generated/plugin-catalog.generated.ts`）
      if (!children.has(parent)) children.set(parent, new Set());
      children.get(parent)!.add(segments[0]);

      // 多段写法代表叶子文件，不进栈（没人会在它下面继续画）
      stack[depth] = segments.length === 1 ? `${parent}/${segments[0]}` : parent;
      stack.length = depth + 1;
    }
  }

  assert.ok(roots > 0, `${doc} 里没找到目录树的根行（形如 \`mcp/\`）；本锁勿空转`);
  return { entries, children };
}

describe('README 目录树漂移锁', () => {
  for (const target of TARGETS) {
    describe(target.doc, () => {
      it('树里列出的每个条目都真实存在（防幽灵条目）', () => {
        const { entries } = parseTrees(target.doc);
        assert.ok(
          entries.length >= target.minEntries,
          `${target.doc} 只解析到 ${entries.length} 个条目（下限 ${target.minEntries}），树格式或解析器可能已变`,
        );

        const ghosts = entries.filter((rel) => !existsSync(abs(rel)));
        assert.deepEqual(ghosts, [], `${target.doc} 的目录树里有不存在的条目（删了/改名了没跟图）：\n  ${ghosts.join('\n  ')}`);
      });

      it('声明要穷尽的目录必须与磁盘逐个对上（防漏条目）', () => {
        const { children } = parseTrees(target.doc);
        const dirs = target.exhaustive === '*' ? [...children.keys()].sort() : target.exhaustive;
        assert.ok(dirs.length > 0, `${target.doc} 没有可校验的穷尽目录（勿让本锁空转）`);

        for (const dir of dirs) {
          const listed = children.get(dir);
          assert.ok(listed, `${target.doc} 的树里没有展开 ${dir} 的任何子项，但它被声明为必须穷尽`);

          const onDisk = readdirSync(abs(dir), { withFileTypes: true })
            .map((d) => d.name)
            .sort();
          const inTree = [...listed].sort();
          const missing = onDisk.filter((n) => !inTree.includes(n));
          const ghost = inTree.filter((n) => !onDisk.includes(n));

          assert.deepEqual(
            { missing, ghost },
            { missing: [], ghost: [] },
            `${target.doc} 的目录树与 ${dir} 实际内容不一致：` +
              `\n  漏写（磁盘有、图上没有）：${missing.join(', ') || '无'}` +
              `\n  多写（图上有、磁盘没有）：${ghost.join(', ') || '无'}`,
          );
        }
      });
    });
  }
});
