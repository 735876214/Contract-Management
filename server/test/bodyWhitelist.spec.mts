import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

/**
 * **请求体白名单门禁的自守**（2026-11-21 质量评估 P0-1）。
 *
 * 背景：`main.ts` 的 `ValidationPipe({ whitelist: true })` 因全库没有 DTO 类而空转，
 * 真正的字段白名单靠各 service 的 `pickFields()` / 私有 `normalize()` —— 是约定不是机制。
 * `scripts/check-body-whitelist.mjs` 把约定变成机制：每个 `@Body()` 必须有 `// @body:` 标记，
 * 存量走 `scripts/body-whitelist.allow.txt` 豁免（只允许变少）。
 *
 * 这里钉住三件事，避免门禁退化成装饰品（仓库里已有 56 条没人执行的 `eslint-disable` 作前车之鉴）：
 * ① 门禁对当前仓库**通过**；② 门禁的**负向 fixture 必须判失败**（`--selftest`）；
 * ③ 豁免表条数不超过脚本里的 `MAX_ALLOW`（防止有人只加豁免不降上限）。
 */

const REPO = fileURLToPath(new URL('../../', import.meta.url));
const SCRIPT = path.join(REPO, 'scripts', 'check-body-whitelist.mjs');

const runGate = (args: string[] = []) => {
  try {
    const stdout = execFileSync(process.execPath, [SCRIPT, ...args], { cwd: REPO, encoding: 'utf8' });
    return { code: 0, stdout };
  } catch (e: any) {
    return { code: e?.status ?? -1, stdout: String(e?.stdout ?? '') + String(e?.stderr ?? '') };
  }
};

describe('请求体白名单门禁', () => {
  it('当前仓库通过门禁（存量豁免在册、无悬空标记）', () => {
    const r = runGate();
    assert.equal(r.code, 0, `门禁未通过：\n${r.stdout}`);
    assert.match(r.stdout, /请求体白名单门禁通过/);
  });

  it('负向 fixture 必须判失败（good / bad / dangling 三个用例）', () => {
    const r = runGate(['--selftest']);
    assert.equal(r.code, 0, `selftest 未通过：\n${r.stdout}`);
    for (const c of [
      'good: [] OK',
      'bad: [missing-marker] OK',
      'dangling: [dangling-ref] OK',
    ]) {
      assert.ok(r.stdout.includes(c), `缺少用例结果：${c}\n实际：\n${r.stdout}`);
    }
  });

  it('豁免条数不超过脚本里的 MAX_ALLOW（只减不增）', async () => {
    const fs = await import('node:fs/promises');
    const script = await fs.readFile(SCRIPT, 'utf8');
    const max = Number((script.match(/MAX_ALLOW = Number\(process\.env\.BODY_WHITELIST_MAX_ALLOW \?\? (\d+)\)/) || [])[1]);
    assert.ok(Number.isFinite(max) && max >= 0, `MAX_ALLOW 解析失败：${max}`);
    const allow = await fs.readFile(path.join(REPO, 'scripts', 'body-whitelist.allow.txt'), 'utf8');
    const n = allow.split('\n').map((s) => s.trim()).filter((s) => s && !s.startsWith('#')).length;
    assert.ok(n <= max, `豁免 ${n} 条 > 上限 ${max}：清理后请同步下调 MAX_ALLOW`);
  });
});
