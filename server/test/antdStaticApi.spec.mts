import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * **antd 静态 API 主题桥锁**（扫描 web/src）。
 *
 * 起因（2026-11-22 真渲染核验）：控制台每次弹提示都报
 *   Warning: [antd: message] Static function can not consume context like dynamic theme
 * 排查结果：全站 **61 个文件**从 antd 直接 import 静态 message（**297 处调用**）。
 * 静态 API 在自己的 React 根里渲染，拿不到 ConfigProvider theme —— DESIGN token 因此不生效。
 *
 * 收口方式：统一走 web/src/utils/antdStatic.ts 的桥接 message（Proxy 转发给 App.tsx 里
 * <AntdStaticBridge/> 绑定的 App.useApp().message），调用点因此一行未改。
 *
 * 本锁防的是「新代码又写回从 antd import 静态 message」。
 * ⚠️ 联动：新增本文件需在 docs/development.md §5 登记（docStats.spec.mts 会校验）。
 */

const repoRoot = fileURLToPath(new URL('../../', import.meta.url));
const SRC = repoRoot + 'web/src';

/** 桥接模块自身是唯一允许直接接触 antd 静态 API 的地方 */
const BRIDGE_REL = 'utils/antdStatic.ts';

/**
 * 静态 Modal.xxx 已清零（2026-11-22）：与 message 同一类问题（拿不到 ConfigProvider 主题），
 * 全部改为 `@/utils/antdStatic` 的 `modal`（App.useApp().modal 的桥接）。
 * 故这里从「冻结存量」升级为**硬规则：必须为 0**。
 */
const STATIC_MODAL_ALLOWED = 0;

const walk = (dir: string, out: string[] = []): string[] => {
  for (const name of readdirSync(dir)) {
    const full = dir + '/' + name;
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.(ts|tsx)$/.test(name)) out.push(full);
  }
  return out;
};

const relOf = (full: string) => full.substring(SRC.length + 1).replace(/\\/g, '/');

describe('antd 静态 API 主题桥锁（web/src）', () => {
  const files = walk(SRC);

  it('扫描面非空（防解析失效导致恒真）', () => {
    assert.ok(files.length >= 120, '只扫到 ' + files.length + ' 个源文件，web/src 结构可能变了');
    assert.ok(
      files.some((f) => relOf(f) === BRIDGE_REL),
      '桥接模块不存在：' + BRIDGE_REL + '（改名了就要同步改本锁与 App.tsx）',
    );
  });

  it('除桥接模块外，不得从 antd 具名 import 静态 message', () => {
    const re = /import\s*\{[^}]*\bmessage\b[^}]*\}\s*from\s*'antd'/s;
    const offenders = files
      .filter((f) => relOf(f) !== BRIDGE_REL)
      .filter((f) => re.test(readFileSync(f, 'utf8')))
      .map(relOf);
    assert.deepEqual(
      offenders,
      [],
      '这些文件仍从 antd 直接引入静态 message（改为从 @/utils/antdStatic 导入）：\n  ' + offenders.join('\n  '),
    );
  });

  it('App.tsx 必须把 App.useApp() 的 message / modal 绑到桥接模块', () => {
    const app = readFileSync(SRC + '/App.tsx', 'utf8');
    // 两个实例都要绑：只绑 message 的话 modal.confirm 仍会退回无主题 fallback
    assert.ok(app.includes('bindAntdStatic({ message, modal })'), 'App.tsx 没有 bindAntdStatic({ message, modal })：静态调用会退回无主题实例');
    assert.ok(app.includes('const { message, modal } = AntdApp.useApp()'), 'App.tsx 未从 AntdApp.useApp() 取到 message / modal');
    assert.ok(/<AntdStaticBridge\s*\/>/.test(app), 'App.tsx 没挂载 <AntdStaticBridge/>：桥接永不绑定');
    assert.ok(
      /<AntdApp>[\s\S]*<AntdStaticBridge\s*\/>[\s\S]*<\/AntdApp>/.test(app),
      '<AntdStaticBridge/> 必须在 <AntdApp> 内部，否则 App.useApp() 拿不到带主题的实例',
    );
  });

  it('不得再出现静态 Modal.confirm/info/success/error/warning', () => {
    const count = files.reduce(
      (n, f) => n + (readFileSync(f, 'utf8').match(/\bModal\.(confirm|info|success|error|warning)\(/g)?.length ?? 0),
      0,
    );
    assert.equal(
      count,
      STATIC_MODAL_ALLOWED,
      '仍有 ' + count + ' 处静态 Modal 调用：它拿不到 ConfigProvider 主题，' +
        '请改为 import { modal } from \'@/utils/antdStatic\' 后调用 modal.confirm(...)',
    );
  });
});
