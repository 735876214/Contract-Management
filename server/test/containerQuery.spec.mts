import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { CONTAINER_BREAKPOINTS, resolveContainerSize } from '../../web/src/utils/containerSize.ts';

/**
 * **组件级响应式（Container Queries）漂移锁** —— 方案见 docs/08 V2 §5。
 *
 * 背景：V1 全站按**视口**判断（`useResponsive()` / AntD 断点 prop），解决不了
 * 「桌面视口 + 900px 弹窗里的表格被挤破版」这类问题；V2 立规：**组件内部布局由容器宽度决定**。
 * 两套断点一旦并存又没人管，很快会出现「同一个人一会儿用视口一会儿用容器」，
 * 于是把方案 §5 的要求变成机器可查：
 *
 * 1. 用视口值决定**组件自身**布局的位置，只允许出现在**页面外壳**（白名单，且每条注明何时删除）；
 * 2. `@container` 的条件**只能写字面值**、且数值必须来自 `CONTAINER_BREAKPOINTS`
 *    —— `var()` 在容器查询条件里不被解析（2026-10-15 Edge 实测：整条规则被丢弃；
 *    `calc(720px)` 与 `720px` 正常），所以"断点只有一个来源"改由本锁保证；
 * 3. `container-type` 只许出现在 `web/src/styles/*.css` 的 `.cq` 上
 *    （组件内联样式里挂会绕过 `.cq` 的适用条件与注释说明）；
 * 4. `containerSize.ts` 的常量 ↔ `index.css` 的 `--cq-*` ↔ `@container` 的字面值，
 *    三处必须逐个相等（漏同步即红）；
 * 5. CQ 规则集中的 `styles/containers.css` 必须在 `index.css` **之后**引入
 *    （同特异度的类选择器靠顺序压过基线，顺序反了会静默失效）。
 *
 * ⚠️ 与 `docs/development.md` §5 的 spec 清单联动：新增本文件必须登记清单（`docStats` 会校验）。
 */

const repoRoot = fileURLToPath(new URL('../../', import.meta.url));
const SRC = `${repoRoot}web/src`;
const CONTAINERS_CSS = 'styles/containers.css';

/** 视口层白名单：**允许**用 `useResponsive()` 决定布局的位置（页面外壳） */
const VIEWPORT_LAYER_ALLOWED: Record<string, string> = {
  'hooks/useResponsive.ts': '视口断点的定义处本身（封装 AntD Grid.useBreakpoint）',
  'layouts/BasicLayout.tsx': '页面外壳：侧栏折叠、内容区边距、顶栏精简——它的容器就是视口',
  'components/Sider/index.tsx': '页面外壳：≤md 侧栏改 Drawer',
  'components/ProjectSwitch.tsx': '页面外壳：顶栏内的项目切换宽度',
  // ↓↓↓ 过渡豁免：V2 分阶段迁移期间保留，迁走一个就删一行（留着会被"白名单条目必须带删除时机"约束盯住）
  'components/procurement/ModuleListPage.tsx':
    '过渡豁免（V2 阶段 3 迁走后删除）：冻结列/紧凑行高/筛选列数待改容器驱动',
};

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
const read = (full: string) => readFileSync(full, 'utf8');

/**
 * 把注释内容替换为**等长空白**（保留换行）后再扫描：既避免"文档里提到 useResponsive /
 * `@container` 被误报"，又不打乱行号（报错要能指回真实位置）。
 * `//` 只在其前面不是 `:` 时才算注释（别把 `https://` 截断）。
 */
const blankComments = (src: string): string =>
  src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:])(\/\/[^\n]*)/g, (_m, pre: string, cmt: string) => pre + ' '.repeat(cmt.length));

const BREAKPOINT_VALUES = new Set<number>(Object.values(CONTAINER_BREAKPOINTS));

describe('组件级响应式漂移锁（Container Queries）', () => {
  const files = walk(SRC);
  const styles = files.filter((f) => /\.(css|less)$/.test(f));
  const sources = files.filter((f) => /\.(ts|tsx)$/.test(f));

  it('扫描面非空（防解析失效导致恒真）', () => {
    assert.ok(sources.length >= 60, `只扫到 ${sources.length} 个源码文件，web/src 结构可能变了`);
    assert.ok(
      styles.some((f) => relOf(f) === CONTAINERS_CSS),
      `没扫到 ${CONTAINERS_CSS} —— 目录结构或文件名变了，本锁需同步改`,
    );
    assert.ok(
      sources.some((f) => relOf(f) === 'utils/containerSize.ts'),
      '没扫到 utils/containerSize.ts —— 容器断点的单一事实源不见了',
    );
    for (const rel of Object.keys(VIEWPORT_LAYER_ALLOWED)) {
      assert.ok(
        files.some((f) => relOf(f) === rel),
        `视口层白名单文件不存在：${rel}（改名/迁移了就要同步改白名单）`,
      );
    }
  });

  it('视口值不得决定组件自身布局（只允许页面外壳用 useResponsive）', () => {
    const offenders: string[] = [];
    for (const full of sources) {
      const rel = relOf(full);
      if (VIEWPORT_LAYER_ALLOWED[rel]) continue;
      const src = blankComments(read(full));
      for (const m of src.matchAll(/useResponsive\s*\(/g)) {
        const line = src.slice(0, m.index ?? 0).split('\n').length;
        offenders.push(`${rel}:${line}  用了 useResponsive()（视口值）`);
      }
      // 顺带把"自己取视口宽"也堵死（V1 立规，V2 继续有效）
      for (const m of src.matchAll(/window\.innerWidth|matchMedia\s*\(/g)) {
        const line = src.slice(0, m.index ?? 0).split('\n').length;
        offenders.push(`${rel}:${line}  ${m[0]}（视口断点必须走 useResponsive()）`);
      }
    }
    assert.deepEqual(
      offenders,
      [],
      '组件内部请改用 Container Queries（`.cq` + `@container`）或 useContainerWidth()，' +
        `页面外壳才允许用视口值：\n  ${offenders.join('\n  ')}`,
    );
  });

  it('@container 条件只能写字面值，且数值必须来自 CONTAINER_BREAKPOINTS', () => {
    const offenders: string[] = [];
    let conditions = 0;
    for (const full of styles) {
      const rel = relOf(full);
      const src = blankComments(read(full));
      for (const m of src.matchAll(/@container\s*([^{]+)\{/g)) {
        conditions += 1;
        const cond = m[1].trim();
        const line = src.slice(0, m.index ?? 0).split('\n').length;
        if (/var\s*\(/.test(cond)) {
          offenders.push(
            `${rel}:${line}  @container 条件里用了 var()（浏览器会整条丢弃该规则）：${cond}`,
          );
          continue;
        }
        const px = [...cond.matchAll(/([\d.]+)px/g)].map((x) => Number(x[1]));
        if (!px.length) {
          offenders.push(`${rel}:${line}  @container 条件里没有 px 断点值：${cond}`);
          continue;
        }
        for (const v of px) {
          if (!BREAKPOINT_VALUES.has(v)) {
            offenders.push(
              `${rel}:${line}  断点值 ${v}px 不在 CONTAINER_BREAKPOINTS ` +
                `{${[...BREAKPOINT_VALUES].join(', ')}} 里：${cond}`,
            );
          }
        }
      }
      if (rel !== CONTAINERS_CSS && /@container/.test(src)) {
        offenders.push(`${rel}  容器查询规则必须集中在 ${CONTAINERS_CSS}（docs/08 §6.2）`);
      }
    }
    assert.ok(conditions >= 1, `一条 @container 都没扫到，本锁在空转（${CONTAINERS_CSS} 应有规则）`);
    assert.deepEqual(offenders, [], `容器查询写法不合规：\n  ${offenders.join('\n  ')}`);
  });

  it('container-type 只允许出现在 styles/*.css 的 .cq 上', () => {
    const offenders: string[] = [];
    let found = 0;
    for (const full of files) {
      const rel = relOf(full);
      const src = blankComments(read(full));
      if (/containerType/.test(src)) {
        offenders.push(`${rel}  tsx 内联样式里挂了 containerType（应改用 .cq 类）`);
      }
      if (!/container-type/.test(src)) continue;
      if (!/^styles\//.test(rel)) {
        offenders.push(`${rel}  出现 container-type，CQ 容器标记只能在 web/src/styles/*.css 定义`);
        continue;
      }
      // 逐条规则检查：含 container-type 的规则，选择器必须落在 .cq 上
      for (const chunk of src.split('}')) {
        if (!/container-type/.test(chunk)) continue;
        found += 1;
        const selector = chunk.split('{')[0].trim();
        if (!/(^|[\s,])\.cq\b/.test(selector)) {
          offenders.push(`${rel}  规则「${selector}」上挂了 container-type，只允许挂在 .cq 上`);
        }
      }
    }
    assert.ok(found >= 1, '.cq 的 container-type 没扫到，本锁在空转');
    assert.deepEqual(offenders, [], `容器标记放置不合规：\n  ${offenders.join('\n  ')}`);
  });

  it('三处断点值必须一致：containerSize.ts ↔ index.css 的 --cq-* ↔ @container 条件', () => {
    const indexCss = read(`${SRC}/index.css`);
    for (const [key, value] of Object.entries(CONTAINER_BREAKPOINTS)) {
      const m = indexCss.match(new RegExp(`--cq-${key}\\s*:\\s*([\\d.]+)px`));
      assert.ok(m, `index.css 的 :root 里找不到 --cq-${key}（容器断点的 CSS 镜像）`);
      assert.equal(
        Number(m[1]),
        value,
        `--cq-${key} = ${m[1]}px，但 containerSize.ts 里是 ${value}px —— 改断点要三处同步`,
      );
    }
  });

  it('styles/containers.css 必须在 index.css 之后引入（顺序反了会静默失效）', () => {
    const main = read(`${SRC}/main.tsx`);
    const iBase = main.indexOf("'./index.css'");
    const iCq = main.indexOf(`'./${CONTAINERS_CSS}'`);
    assert.ok(iBase >= 0, "main.tsx 里找不到 './index.css' 的 import");
    assert.ok(iCq >= 0, `main.tsx 里找不到 './${CONTAINERS_CSS}' 的 import`);
    assert.ok(
      iBase < iCq,
      'container 规则与基线多为同特异度类选择器，containers.css 必须排在 index.css 之后',
    );
  });

  it('用到 .doc-preview 的组件，其外层容器必须挂 .cq（否则容器查询无处可查）', () => {
    const offenders: string[] = [];
    for (const full of sources) {
      const rel = relOf(full);
      const src = blankComments(read(full));
      if (!/className="doc-preview"/.test(src)) continue;
      if (!/className="cq"/.test(src)) {
        offenders.push(`${rel}  渲染了 .doc-preview 但同文件里没有 className="cq" 的容器`);
      }
    }
    assert.deepEqual(
      offenders,
      [],
      `预览区的外层包裹要挂 className="cq"（CQ 只能查祖先容器）：\n  ${offenders.join('\n  ')}`,
    );
  });
});

describe('容器宽度 → 档位（resolveContainerSize）', () => {
  it('边界值：sm 480 / md 720 / lg 1024', () => {
    const at = (w: number) => {
      const s = resolveContainerSize(w);
      return [s.isCompact, s.isNarrow, s.isWide];
    };
    // [isCompact(<480), isNarrow(<720), isWide(≥1024)]
    assert.deepEqual(at(0), [true, true, false], '宽度未知时按极窄算，调用方需自己兜底');
    assert.deepEqual(at(479), [true, true, false]);
    assert.deepEqual(at(480), [false, true, false], '480 起不再算极窄');
    assert.deepEqual(at(719), [false, true, false]);
    assert.deepEqual(at(720), [false, false, false], '720 起容器算「不窄」');
    assert.deepEqual(at(1023), [false, false, false]);
    assert.deepEqual(at(1024), [false, false, true], '1024 起算宽容器');
  });

  it('原样带回宽度，且不做任何取整/夹取', () => {
    assert.equal(resolveContainerSize(721.5).width, 721.5);
  });
});
