import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * **色值来源锁**：`web/src` 里的颜色只许来自 token 层。
 *
 * 起因：换视觉时实测前端散落 **157 处** `#xxxxxx`（`#8c8c8c` 一个就有 42 处），
 * 改主题时无法一处生效、也无法保证一致性。本轮把可判定的 97 处收敛到 `theme.ts` 的色板
 * 与 `index.css` 的 `--cms-*` 变量，其余按上下文逐个归位。
 *
 * 本测试把它变成 CI 可捕获的约定（对应铁律「字典驱动 + code 单一事实源」的视觉版）：
 * `web/src` 下**任何文件**都不许出现 `#hex` 或 `rgb()/rgba()` 字面量，
 * **除非**在下面的白名单里——白名单每一条都要写明"为什么它必须是例外"。
 *
 * ⚠️ 与 `docs/development.md` §5 的 spec 清单联动：新增本文件必须登记清单（`docStats` 会校验）。
 */

const repoRoot = fileURLToPath(new URL('../../', import.meta.url));
const SRC = `${repoRoot}web/src`;

/** 白名单：路径（相对 web/src，POSIX 风格）→ 例外理由 */
const ALLOWED: Record<string, string> = {
  'theme.ts': 'token 层的 JS 事实源：色板/语义色/图表配色/chartPalette 都在这里定义',
  'index.css': 'token 层的 CSS 镜像：`:root { --cms-* }` 变量 + 深色顶栏/标签色覆盖',
  'components/Sider/index.less': 'token 层的 LESS 镜像：侧栏深墨面色值（LESS 变量不能用 var()）',
  'components/RichTextEditor.tsx': '编辑器**功能**：正文颜色/背景色是给用户选的编辑能力，不是界面主题',
  'utils/docExport.ts': '导出物：Word/打印模板用内联样式（Word 不认 CSS 变量），与屏幕主题无关',
};

const HEX = /#[0-9a-fA-F]{3,8}\b/g;
const RGB = /\brgba?\([0-9]/g;

/** 递归收集 web/src 下的样式与源码文件 */
const walk = (dir: string, out: string[] = []): string[] => {
  for (const name of readdirSync(dir)) {
    const full = `${dir}/${name}`;
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.(ts|tsx|css|less)$/.test(name)) out.push(full);
  }
  return out;
};

const relOf = (full: string) => full.slice(SRC.length + 1).replace(/\\/g, '/');

describe('色值来源锁（web/src 只许用 token 层）', () => {
  const files = walk(SRC);

  it('扫描面非空（防解析失效导致恒真）', () => {
    assert.ok(files.length >= 60, `只扫到 ${files.length} 个文件，web/src 结构可能变了`);
    assert.ok(
      files.some((f) => /(^|\/)theme\.ts$/.test(f)),
      '没扫到 theme.ts —— 白名单与扫描路径可能已经不匹配',
    );
    // 白名单里每个文件都必须真实存在，防止改名后锁形同虚设
    for (const rel of Object.keys(ALLOWED)) {
      assert.ok(
        files.some((f) => relOf(f) === rel),
        `白名单文件不存在：${rel}（改名了就要同步改这里）`,
      );
    }
  });

  it('token 层之外不得出现 #hex / rgb() 字面量', () => {
    const offenders: string[] = [];
    for (const full of files) {
      const rel = relOf(full);
      if (ALLOWED[rel]) continue;
      const src = readFileSync(full, 'utf8');
      for (const m of src.matchAll(HEX)) {
        const line = src.slice(0, m.index ?? 0).split('\n').length;
        offenders.push(`${rel}:${line}  ${m[0]}`);
      }
      for (const m of src.matchAll(RGB)) {
        const line = src.slice(0, m.index ?? 0).split('\n').length;
        offenders.push(`${rel}:${line}  ${m[0]}(...)`);
      }
    }
    assert.deepEqual(
      offenders,
      [],
      `以下位置写死了颜色，请改用 theme.ts 的色板 / index.css 的 --cms-* 变量：\n  ${offenders.join('\n  ')}`,
    );
  });

  it('白名单文件确实持有色值（防止"白名单留着一堆空壳"）', () => {
    for (const rel of Object.keys(ALLOWED)) {
      const full = files.find((f) => relOf(f) === rel);
      if (!full) continue;
      const src = readFileSync(full, 'utf8');
      assert.ok(
        /#[0-9a-fA-F]{3,8}\b/.test(src) || /\brgba?\([0-9]/.test(src),
        `${rel} 里已经没有色值了——若已不需要例外，请把它从白名单移除`,
      );
    }
  });
});
