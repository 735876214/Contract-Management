import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

/**
 * **列表查询上限门禁的自守**（2026-11-21 质量评估 P1-4；2026-11-28 收紧判定口径）。
 *
 * 全仓 243 处 findMany 曾只有 34 处带 take：台账/结算/采购列表会随项目体量涨内存。
 * 门禁只抓「**项目级**无上限」（顶层没 take、where 里也没按父实体键等值 / in 列表过滤），
 * 按合同/任务过滤的明细查询天然有界，不吵人。
 *
 * 2026-11-28 收紧：旧实现实测放过 31 处项目级全量查询，三个成因
 * ① 父实体键正则原来扫**整段实参**：select 里投影一个主键（id: true）就算「按父实体过滤」了；
 * ② take 原来也在整段里搜：子表 include 里的 take、甚至注释里写过的 take 都能过闸；
 * ③ 键值写成对象（模糊条件 contains 之类）原来被当成等值比较。
 * 现在先剥注释（等长替换），只看顶层参数成员与 where 的顶层键；下面每个负向 fixture 各钉一条。
 *
 * 钉三件事：① 当前仓库通过；② 负向 fixture 必须判失败；③ 豁免条数不超 MAX_ALLOW（只减不增）。
 */

const REPO = fileURLToPath(new URL('../../', import.meta.url));
const SCRIPT = path.join(REPO, 'scripts', 'check-query-limits.mjs');

const runGate = (args: string[] = []) => {
  try {
    return { code: 0, stdout: execFileSync(process.execPath, [SCRIPT, ...args], { cwd: REPO, encoding: 'utf8' }) };
  } catch (e: any) {
    return { code: e?.status ?? -1, stdout: String(e?.stdout ?? '') + String(e?.stderr ?? '') };
  }
};

describe('列表查询上限门禁', () => {
  it('当前仓库通过门禁', () => {
    const r = runGate();
    assert.equal(r.code, 0, `门禁未通过：\n${r.stdout}`);
    assert.match(r.stdout, /列表查询上限门禁通过/);
  });

  it('正向 fixture 判通过、负向 fixture 必须判失败', () => {
    const r = runGate(['--selftest']);
    assert.equal(r.code, 0, `selftest 未通过：\n${r.stdout}`);
    const fixtures = [
      'ok-take: violations=0 want=0 OK',
      'ok-parent-eq: violations=0 want=0 OK',
      'ok-parent-in: violations=0 want=0 OK',
      'ok-marked: violations=0 want=0 OK',
      'bad-project-only: violations=1 want=1 OK',
      // 2026-11-28 收紧时修掉的三处漏判，各有一个 fixture 钉住
      'bad-select-id: violations=1 want=1 OK',
      'bad-order-by-id: violations=1 want=1 OK',
      'bad-nested-take: violations=1 want=1 OK',
      'bad-comment-take: violations=1 want=1 OK',
      'bad-contains: violations=1 want=1 OK',
      'bad-where-var: violations=1 want=1 OK',
      'bad-no-where: violations=1 want=1 OK',
    ];
    for (const c of fixtures) {
      assert.ok(r.stdout.includes(c), `缺少用例结果：${c}\n实际：\n${r.stdout}`);
    }
  });

  it('豁免条数不超过 MAX_ALLOW（只减不增）', async () => {
    const fs = await import('node:fs/promises');
    const script = await fs.readFile(SCRIPT, 'utf8');
    const max = Number((script.match(/QUERY_LIMIT_MAX_ALLOW \?\? (\d+)/) || [])[1]);
    assert.ok(Number.isFinite(max), `MAX_ALLOW 解析失败：${max}`);
    const allow = await fs.readFile(path.join(REPO, 'scripts', 'query-limit.allow.txt'), 'utf8');
    const n = allow.split('\n').map((s) => s.trim()).filter((s) => s && !s.startsWith('#')).length;
    assert.ok(n <= max, `豁免 ${n} 条 > 上限 ${max}`);
  });
});
