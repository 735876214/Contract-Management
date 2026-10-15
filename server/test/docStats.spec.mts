import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * 活文档「统计数字」漂移锁。
 *
 * 起因：本文件是**第二次**人工清理同一类过期数字后加的锁。第一次是 2026-10-14 上旬
 * （`CLAUDE.md` 写「schema.prisma 1306 行」实测 1312、docs 里「13 个 spec / 180 项断言」早已过期），
 * 当时只在 `TODO.md` 里登记了「下次梳理要校准」——结果第二次梳理又撞上同样的腐烂，
 * 包括 `TODO.md` 自己写「现为 17 个 spec / 235 项断言」（实际 21 / 253）。
 *
 * 两类文档**待遇不同**（见 `CLAUDE.md` §8 末尾）：
 * - **活文档**（`CLAUDE.md`、`docs/development.md`）：描述的是「现在是什么」，必须与代码一致 → 由本文件锁；
 * - **历史报告**（`docs/07` §0.1 等带日期的实施/验收记录）：描述的是「当时是什么」，
 *   就地标注「当时快照」即可，**不要**追改（改了等于篡改记录），本文件**不扫**它们。
 *
 * 断言数（如「253 项断言」）**刻意不锁也不写进散文**：它随每次加/改用例变动，命令输出即真相。
 */

const abs = (rel: string) => fileURLToPath(new URL(`../../${rel}`, import.meta.url));

const read = (rel: string) => readFileSync(abs(rel), 'utf8');

/** 活文档：数字必须与代码一致 */
const LIVE_DOCS = ['CLAUDE.md', 'docs/development.md'];

const PURE_DIR = 'server/test';
const INT_DIR = 'server/test-integration';

const listFiles = (dir: string, re: RegExp) => readdirSync(abs(dir)).filter((f) => re.test(f)).sort();

/** 无 DB 纯函数套件（`npm test` 的 glob 是 `test/*.spec.ts test/*.spec.mts`） */
const pureSpecs = listFiles(PURE_DIR, /\.spec\.(ts|mts)$/);
/** DB 集成套件（`npm run test:int` 跑 `test-integration/*.int.spec.ts`） */
const intSpecs = listFiles(INT_DIR, /\.int\.spec\.ts$/);

describe('活文档统计数字漂移锁', () => {
  it('扫到了两套件（防空转）', () => {
    // 若文件命名或目录变了，下面几条会「零匹配即通过」——先钉死扫描面本身
    assert.ok(pureSpecs.length >= 20, `纯函数套件数量异常：${pureSpecs.length}`);
    assert.ok(intSpecs.length >= 3, `DB 集成套件数量异常：${intSpecs.length}`);
  });

  it('CLAUDE.md / docs/development.md 里的「N 个 spec」与实际文件数一致', () => {
    const allowed = new Set([pureSpecs.length, intSpecs.length]);
    const seen = new Set<number>();
    let hits = 0;

    for (const doc of LIVE_DOCS) {
      const src = read(doc);
      for (const m of src.matchAll(/(\d+)\s*个?\s*spec/g)) {
        hits += 1;
        const n = Number(m[1]);
        seen.add(n);
        assert.ok(
          allowed.has(n),
          `${doc} 写了「${n} 个 spec」，实际是 ${pureSpecs.length} 个（${PURE_DIR}）+ ${intSpecs.length} 个（${INT_DIR}）`,
        );
      }
    }

    assert.ok(hits >= 5, `只匹配到 ${hits} 处「N 个 spec」，正则或文档措辞可能已变（勿让本锁空转）`);
    for (const n of allowed) {
      assert.ok(seen.has(n), `活文档里没有任何「${n} 个 spec」的声明：新增/删除 spec 后忘了同步文档`);
    }
  });

  it('docs/development.md 的套件清单列全了每个 spec 文件', () => {
    const doc = read('docs/development.md');
    // 防恒真：先确认清单确实在（§5 的表格里逐行列出文件名）
    assert.ok(doc.includes('procurementFlow.spec.ts'), 'docs/development.md 的 spec 清单似乎不见了');

    /**
     * 只认**表格行**（`| \`test/x.spec.ts\` | 覆盖… |`），不认正文里的顺带提及。
     * 之前写成裸 `doc.includes(file)`，结果正文一句「`test/docStats.spec.mts` 会校验本表」
     * 就把它救活了——删掉表格行依旧绿（反测时抓到）。
     * ⚠️ 文档里写的是仓库相对路径（`test/x.spec.ts`），不是 `PURE_DIR` 的 `server/test`。
     */
    const docDir = (dir: string) => dir.replace(/^server\//, '');
    const listedInTable = (dir: string, file: string) =>
      new RegExp(`^\\s*\\|\\s*\`(?:${docDir(dir)}/)?${file.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\``, 'm').test(doc);

    const missing = [
      ...pureSpecs.map((f) => [PURE_DIR, f] as const),
      ...intSpecs.map((f) => [INT_DIR, f] as const),
    ]
      .filter(([dir, f]) => !listedInTable(dir, f))
      .map(([, f]) => f);

    assert.deepEqual(missing, [], `新增了 spec 但 docs/development.md §5/§5.1 未登记：\n  ${missing.join('\n  ')}`);
  });

  it('CLAUDE.md §2 的 model / 业务模块 / 增量迁移 计数与代码一致', () => {
    const models = read('server/prisma/schema.prisma').match(/^model /gm)?.length ?? 0;
    const migrationDirs = readdirSync(abs('server/prisma/migrations'), { withFileTypes: true }).filter((d) =>
      d.isDirectory(),
    );
    const modules = readdirSync(abs('server/src/modules'), { withFileTypes: true }).filter((d) => d.isDirectory());

    const refs = [
      { label: 'model', re: /(\d+)\s*个\s*model/g, actual: models },
      { label: '业务模块', re: /(\d+)\s*个\s*业务模块/g, actual: modules.length },
      // 迁移目录里含 1 个折叠基线（空库 → 当前 schema），其余为增量
      { label: '增量迁移', re: /(\d+)\s*个\s*增量迁移/g, actual: migrationDirs.length - 1 },
    ];

    const agents = read('CLAUDE.md');
    for (const { label, re, actual } of refs) {
      const nums = [...agents.matchAll(re)].map((m) => Number(m[1]));
      assert.ok(nums.length >= 1, `CLAUDE.md 里找不到「N 个 ${label}」的声明（勿让本锁空转）`);
      for (const n of nums) {
        assert.equal(n, actual, `CLAUDE.md 写了「${n} 个 ${label}」，实际是 ${actual}`);
      }
    }

    // 迁移目录列表也在 §2 逐个点名，多一个迁移却不更新注释会看不出来
    for (const d of migrationDirs) {
      if (d.name === '20260901000000_init') continue;
      assert.ok(
        agents.includes(d.name.replace(/^\d+_/, '')),
        `CLAUDE.md §2 未登记迁移 ${d.name}（它只按名字列举增量迁移，不含时间戳前缀）`,
      );
    }
  });
});
