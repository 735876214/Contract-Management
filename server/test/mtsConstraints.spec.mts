import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * **`.mts` 加载约束锁**——把「跑测试时才炸的隐蔽地雷」变成 CI 可捕获的约定。
 *
 * 背景（2026-10-15 专项调查结论，原文见 docs/development.md §5）：
 * `server/test/*.spec.mts` 由 **Node 原生类型擦除**加载（不经过 ts-node），因此有三条硬约束：
 * 1. **相对 import 必须带显式扩展名**（Node ESM 不做扩展名推断）——`from './statuses'` 直接炸；
 * 2. **不支持装饰器与 JSX**——`@Injectable()` 的 NestJS 服务、`.tsx` 组件**永远**进不了 `.mts`
 *    （所以后端服务/前端组件只能靠 `test-integration/*.int.spec.ts`（ts-node）覆盖，这是有意的分工）；
 * 3. 不支持内联 enum / 带运行时的 namespace。
 *
 * 本测试只锁**第 1 条**——它是**唯一会随别人改动而突然出现**的那条：
 * 现在某个被测模块是零依赖叶子，别人给它加一行 `import { X } from './helper'`（哪怕只是顺手重构），
 * `.mts` spec 就会在运行时报 `ERR_MODULE_NOT_FOUND`，且报错信息离原因很远。
 * 第 2、3 条是结构性限制，靠「新模块想进 `.mts` 必须保持零依赖」的组织纪律，测试锁不了。
 *
 * ⚠️ 与 docs/development.md §5 的 spec 清单联动：新增本文件必须登记（`docStats` 会校验）。
 */

const repoRoot = fileURLToPath(new URL('../../', import.meta.url));
const abs = (rel: string) => fileURLToPath(new URL(`../../${rel}`, import.meta.url));

const MTS_DIR = `${repoRoot}server/test`;

/** 收集所有 `.mts` spec 里指向仓库内部的相对 import（跨包 ../.. 也算） */
const repoModulesFromMts = (): Map<string, string[]> => {
  const out = new Map<string, string[]>();
  for (const f of readdirSync(MTS_DIR).filter((n) => n.endsWith('.spec.mts'))) {
    const src = readFileSync(`${MTS_DIR}/${f}`, 'utf8');
    for (const m of src.matchAll(/from\s+['"](\.[^'"]+)['"]/g)) {
      const spec = m[1];
      if (!spec.startsWith('../')) continue; // 只关心指向仓库内其他目录的
      // `../src/x.ts` → server/src/x.ts（spec 位于 server/test/）；`../../web/x.ts` → web/x.ts
      const rel = spec.startsWith('../../') ? spec.slice(6) : `server/${spec.slice(3)}`;
      const list = out.get(rel) ?? [];
      list.push(f);
      out.set(rel, list);
    }
  }
  return out;
};

/** 去掉注释（块注释 + 行注释），避免注释里的示例 import 被当成真代码 */
const stripComments = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');

/**
 * 取模块源码里的「运行时相对 import / 重导出」。
 * ⚠️ 必须容忍**多行 import**（`import {\n  X,\n} from './x'` 是本仓主流写法，逐行扫会漏）——
 * 用 `[^;]*?` 跨行匹配到 `from`，并单独处理无 `from` 的副作用导入；
 * `import type` 会被类型擦除，跳过。
 */
const relativeRuntimeImports = (src: string): string[] => {
  const code = stripComments(src);
  const hits: string[] = [];
  for (const m of code.matchAll(/\b(?:import|export)\b([^;]*?)\bfrom\s*['"](\.[^'"]+)['"]/g)) {
    if (/^\s*type\b/.test(m[1])) continue; // import type / export type → 擦除，无运行时依赖
    hits.push(m[2]);
  }
  for (const m of code.matchAll(/^\s*import\s+['"](\.[^'"]+)['"]/gm)) hits.push(m[1]); // 副作用导入
  return hits;
};

/** 是否带扩展名（`.ts`/`.js`/`.css`/`.json`… 任意后缀都算；只有「完全没有后缀」才是违规） */
const HAS_EXT = /\.[A-Za-z0-9]{1,6}$/;

describe('.mts 加载约束锁（相对 import 必须带扩展名）', () => {
  const modules = repoModulesFromMts();

  it('扫描面非空（防解析失效导致恒真）', () => {
    assert.ok(
      modules.size >= 12,
      `只解析到 ${modules.size} 个被 .mts 引用的仓库内模块，解析规则或目录结构可能已变`,
    );
    // 已知会被 .mts 加载的几个模块必须在扫描结果里（抽样锚点）
    for (const anchor of ['server/src/constants/statuses.ts', 'server/src/constants/procurementFlow.ts']) {
      assert.ok(modules.has(anchor), `未扫到 ${anchor} —— .mts 的 import 写法可能变了`);
    }
  });

  it('被 .mts 加载的模块内部，相对 import 一律带扩展名', () => {
    const bad: string[] = [];
    for (const [rel, specs] of modules) {
      let src: string;
      try {
        src = readFileSync(abs(rel), 'utf8');
      } catch {
        bad.push(`${rel}（被 ${specs.join('/')} 引用，但文件不存在？）`);
        continue;
      }
      for (const spec of relativeRuntimeImports(src)) {
        if (!HAS_EXT.test(spec)) {
          bad.push(
            `${rel} 里的 \`from '${spec}'\` 没有扩展名 —— .mts spec（${specs.join('、')}）会加载失败。` +
              `两条出路：①（本仓现状，推荐）把依赖抽成**零依赖叶子**，别让该模块 import 兄弟模块；` +
              `② 若要复用兄弟模块，先在 server/tsconfig.json 开 allowImportingTsExtensions + ` +
              `rewriteRelativeImportExtensions（TS ≥5.7，本仓已是 5.9）并把该行写成 '${spec}.ts'——` +
              `注意这会影响 nest build 与 ts-node（seed/.ts spec/test:int），需整体回归。` +
              `（依据：AGENTS.md §5 / docs/development.md §5）`,
          );
        }
      }
    }
    assert.deepEqual(bad, [], `以下位置会让 .mts 单测在运行时炸掉：\n  ${bad.join('\n  ')}`);
  });
});
