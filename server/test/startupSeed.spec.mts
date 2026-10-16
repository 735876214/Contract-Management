import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * **启动播种的并发安全锁**（2026-10-16 加的回归锁）。
 *
 * 背景（真实事故）：CI 的 `test:int` 在**空库**上跑，而 `node --test` **每个 spec 文件一个进程**，
 * 每个进程各自启动一次应用、各自跑一遍播种 → 5 个进程**并发**插入同一批字典；
 * Prisma 的 `upsert` 并非原子（会退化成 insert → 撞唯一键则 update），于是有人抛 `P2002`
 * → 该 seed 函数被**中断**、它后面的字典项/参数**漏播** → 依赖字典的用例红。
 * 症状极具迷惑性：**本地怎么跑都绿**（本地库早已播种，upsert 全走 update 分支），**只有 CI 红**；
 * 而它是在"spec 从 4 个加到 5 个"那一提交才变成必现的（并发度变了，不是那次改动本身的错）。
 *
 * 两道防线（本文件锁住它们）：
 * ① 生产启动（`src/main.ts`）与测试启动（`test-integration/helpers.ts`）都必须走
 *    `runStartupSeed()` —— 它用事务级咨询锁 `pg_advisory_xact_lock` 把整段播种串行化
 *    （事务级锁随事务释放，规避了会话级 advisory lock 在连接池下"加锁/解锁不同连接"的坑）；
 * ② `runStartupSeed` 自身必须保留那把锁。
 */

const repoRoot = fileURLToPath(new URL('../../', import.meta.url));
const read = (rel: string) => readFileSync(`${repoRoot}server/${rel}`, 'utf8');

/** 该文件是否"直接"调用了某个播种函数（排除 import 行与注释行） */
const callsSeedFnDirectly = (src: string, fn: string): boolean =>
  src
    .split('\n')
    .filter((l) => !/^\s*(import|\/\/|\*|\/\*)/.test(l))
    .some((l) => new RegExp(`\\b${fn}\\s*\\(`).test(l));

describe('启动播种的并发安全（多进程同时播种会撞 P2002）', () => {
  const SEED_FNS = ['seedAdmin', 'seedDictAndParams', 'seedDefaultProject', 'fixLegacyData'];

  it('生产启动（main.ts）走 runStartupSeed，不直接调各 seed 函数', () => {
    const src = read('src/main.ts');
    assert.match(src, /await runStartupSeed\(/, 'main.ts 必须通过 runStartupSeed() 播种（它带咨询锁）');
    for (const fn of SEED_FNS) {
      assert.ok(!callsSeedFnDirectly(src, fn), `main.ts 不应直接调用 ${fn}()：绕过咨询锁会与其它进程并发播种`);
    }
  });

  it('测试启动（test-integration/helpers.ts）同样走 runStartupSeed', () => {
    const src = read('test-integration/helpers.ts');
    assert.match(
      src,
      /await runStartupSeed\(/,
      'bootIntApp 必须通过 runStartupSeed() 播种：`node --test` 每个 spec 一个进程，' +
        '空库上并发播种会撞 P2002 导致字典漏播（CI 必现、本地看不见）',
    );
    for (const fn of SEED_FNS) {
      assert.ok(!callsSeedFnDirectly(src, fn), `helpers.ts 不应直接调用 ${fn}()`);
    }
  });

  it('runStartupSeed 保留事务级咨询锁（且用事务级而非会话级）', () => {
    const raw = read('src/seed.ts');
    // ⚠️ 先剥注释再扫：本文件与 seed.ts 的注释里都会**提到**会话级锁名（用来解释为什么不用它），
    // 不剥就会把注释当代码读而误伤（同量级问题在 supplierSnapshot 的字段扫描锁里也踩过）。
    const src = raw
      .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
      .replace(/(^|[^:])\/\/[^\n]*/g, (_m, pre: string, cmt: string) => pre + ' '.repeat(cmt.length));
    assert.match(
      src,
      /pg_advisory_xact_lock/,
      'runStartupSeed 必须用事务级咨询锁 pg_advisory_xact_lock（会话级 pg_advisory_lock 在连接池下会' +
        '"加锁与解锁不在同一连接"，锁可能一直不释放）',
    );
    assert.ok(
      !/pg_advisory_lock/.test(src),
      '不要用会话级 `pg_advisory_lock`（见上一条说明）；事务级 `pg_advisory_xact_lock` 才是安全的',
    );
    assert.match(src, /\$transaction\(/, '锁必须包在同一个事务里（Prisma 保证事务内查询走同一条连接）');
  });
});
