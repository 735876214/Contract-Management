import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

/**
 * **列表查询上限门禁的自守**（2026-11-21 质量评估 P1-4）。
 *
 * 全仓 243 处 findMany 曾只有 34 处带 take：台账/结算/采购列表会随项目体量涨内存。
 * 门禁只抓「**项目级**无上限」（没 take、也没按父实体 id 过滤），
 * 按合同/任务过滤的明细查询天然有界，不吵人。
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

  it('负向 fixture 必须判失败（good / bad / marked / bounded）', () => {
    const r = runGate(['--selftest']);
    assert.equal(r.code, 0, `selftest 未通过：\n${r.stdout}`);
    for (const c of ['good: violations=0 OK', 'bad: violations=1 OK', 'marked: violations=0 OK', 'bounded: violations=0 OK']) {
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
