import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { pendingPlaceholders, renderTemplate } from '../src/modules/template/template-render.ts';
import { PURCHASE_EXEC_TEMPLATE } from '../prisma/templates/purchase-exec-contract.ts';

/**
 * 种子模板「占位符语法」漂移锁。
 *
 * 起因（真实回归）：`generate()` 已于 2026-10 移除单花括号替换分支，当时的核对只覆盖了
 * 「独立种子模板文件」与「库里已有的模板行」，**漏了 `prisma/seed.ts` 里内联的 3 份模板**——
 * 它们只在**空库 + `npm run seed`** 时创建，现有库因迁移归一看不出来；新环境 seed 后
 * 生成的合同正文会静默残留 `{合同名称}` 之类裸占位符。
 *
 * 本测试把「种子模板内容只用 `{{变量名}}`」钉死，并进一步验证**内容真能被渲染器吃干净**
 * （只查语法可能漏掉"写法对但取不到值"的情况）。
 *
 * ⚠️ 扫描前必须剔掉注释与 `${…}` 插值：注释里会用 `{变量名}` 举例说明，
 * 而 `upsert-purchase-exec.ts` 里有 `${added}` 这类模板字面量（其内层 `{added}` 不是占位符）。
 */

const here = (rel: string) => fileURLToPath(new URL(rel, import.meta.url));

/** 去掉块注释与行注释（种子文件里注释是"解释语法"的地方，不该被当成占位符） */
const stripComments = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '').replace(/([^:'"`])\/\/.*$/gm, '$1');

/** 单花括号占位符（只认 CJK 起头，避开 CSS/对象的 `{color:red}`、`{a:1}` 与插值） */
const SINGLE_BRACE = /(^|[^{])\{([一-龥][一-龥A-Za-z0-9]{0,20})\}/g;

const scanFiles: string[] = [
  here('../prisma/seed.ts'),
  ...readdirSync(fileURLToPath(new URL('../prisma/templates/', import.meta.url)))
    .filter((f) => f.endsWith('.ts'))
    .map((f) => fileURLToPath(new URL(`../prisma/templates/${f}`, import.meta.url))),
];

/** 从源码里取出所有「含花括号的字符串字面量/模板字面量」= 模板内容所在 */
const braceLiteralsOf = (src: string): string[] => {
  const clean = stripComments(src);
  const literals: string[] = [];
  for (const m of clean.matchAll(/`([^`]*)`/g)) literals.push(m[1]);
  for (const m of clean.matchAll(/'([^'\n]*)'/g)) literals.push(m[1]);
  return literals.filter((s) => s.includes('{'));
};

describe('种子模板占位符语法（单花括号 = 回归）', () => {
  it('扫描面不能为空（防路径写错导致测试恒真）', () => {
    assert.ok(scanFiles.length >= 2, `扫描文件过少：${scanFiles.join(', ')}`);
    for (const f of scanFiles) assert.ok(readFileSync(f, 'utf8').length > 100, `文件内容异常：${f}`);
  });

  it('`prisma/seed.ts` 与 `prisma/templates/*.ts` 里不得出现 CJK 起头的单花括号占位符', () => {
    const offenders: string[] = [];
    for (const f of scanFiles) {
      const src = stripComments(readFileSync(f, 'utf8'));
      for (const m of src.matchAll(SINGLE_BRACE)) {
        const line = src.slice(0, m.index).split('\n').length;
        offenders.push(`${f.split(/[\\/]/).pop()}:${line} → {${m[2]}}`);
      }
    }
    assert.deepEqual(offenders, [], `种子模板里仍有单花括号占位符（改为 {{…}}）：\n${offenders.join('\n')}`);
  });

  it('种子模板内容确实使用 `{{变量名}}`（不是"没有占位符"而侥幸通过）', () => {
    const all = scanFiles.flatMap((f) => braceLiteralsOf(readFileSync(f, 'utf8')));
    const keys = all.flatMap((s) => pendingPlaceholders(s));
    assert.ok(keys.length >= 19, `种子模板双花括号占位符过少（${keys.length} 个），扫描可能失效`);
    assert.ok(keys.includes('供应商名称') && keys.includes('合同编号'), `缺少关键占位符：${keys.join(', ')}`);
  });

  it('**内容真能被渲染器吃干净**：用同名值渲染后无残留占位符', () => {
    const html = [
      PURCHASE_EXEC_TEMPLATE.content,
      ...braceLiteralsOf(readFileSync(here('../prisma/seed.ts'), 'utf8')),
    ].join('\n');
    const values = Object.fromEntries(pendingPlaceholders(html).map((k) => [k, `«${k}»`]));
    const rendered = renderTemplate({ html, values });
    assert.deepEqual(pendingPlaceholders(rendered), [], '渲染后仍有未替换的占位符');
    // 反向确认渲染真的发生了（值被插入），而不是 html 本身为空导致"无残留"假通过
    assert.ok(rendered.includes('«供应商名称»'), '渲染未生效（未找到插入的值）');
  });
});
