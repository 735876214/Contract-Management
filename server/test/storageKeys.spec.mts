import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as path from 'node:path';
import {
  StorageKeyError,
  absPathOf,
  assertSafeStorageKey,
  defaultSubDir,
  normalizeStorageKey,
  publicUrlOf,
  resolveUploadRoot,
  storageFileName,
} from '../src/common/utils/storage-keys.ts';

/**
 * 存储「键/路径」纯逻辑单测（批次 C：落盘写入点收敛为 `StorageService` 的配套）。
 *
 * 为什么值得测：
 * - 键最终会被拼进 `fs` 路径，`..` / 绝对路径 / 反斜杠写法是典型的**越权读盘面**，必须在拼接前拦掉；
 * - 键是以「相对 POSIX 路径」落库的（`signed/x.pdf`），若在 Windows 上退化成 `signed\x.pdf`，
 *   Linux 侧读不到、也拼不出 URL——这种问题只在跨平台时才暴露，锁在这里最省事。
 *
 * ⚠️ 断言避免写死平台相关的绝对路径（CI 跑在 Linux、本地是 Windows）：
 * 需要绝对路径时用 `path.join/path.resolve` 现算。
 */

describe('resolveUploadRoot：上传根目录解析', () => {
  it('绝对路径原样返回', () => {
    assert.equal(resolveUploadRoot('/var/uploads'), '/var/uploads');
  });

  it('相对路径按工作目录解析（与改造前各处的口径一致）', () => {
    assert.equal(resolveUploadRoot('./uploads', '/app'), path.resolve('/app', './uploads'));
    assert.equal(resolveUploadRoot('data/uploads', '/app'), path.resolve('/app', 'data/uploads'));
  });

  it('空值 / 未设置 回落到工作目录下的 uploads', () => {
    assert.equal(resolveUploadRoot(undefined, '/app'), path.resolve('/app', 'uploads'));
    assert.equal(resolveUploadRoot('   ', '/app'), path.resolve('/app', 'uploads'));
  });
});

describe('defaultSubDir / storageFileName：目录与命名规则', () => {
  it('默认子目录 = 当前月份 YYYY-MM（补零）', () => {
    assert.equal(defaultSubDir(new Date(2026, 9, 14)), '2026-10');
    assert.equal(defaultSubDir(new Date(2026, 0, 3)), '2026-01');
  });

  it('文件名 = <时间戳>-<8位随机><.扩展名>，尾扩展名不留双点', () => {
    const name = storageFileName('.pdf', new Date(1730000000000));
    assert.match(name, /^1730000000000-[a-z0-9]{8}\.pdf$/);
    assert.match(storageFileName('pdf'), /\.pdf$/);
    assert.match(storageFileName(''), /^\d+-[a-z0-9]{8}$/);
  });

  it('两次生成不撞名（随机串参与）', () => {
    const set = new Set(Array.from({ length: 50 }, () => storageFileName('.png', new Date(0))));
    assert.equal(set.size, 50);
  });
});

describe('normalizeStorageKey：键规范化（落库/拼 URL 前统一）', () => {
  it('反斜杠统一为 `/`（避免 Windows 下把 `signed\\x.pdf` 写进库）', () => {
    assert.equal(normalizeStorageKey('signed\\1730-ab12.pdf'), 'signed/1730-ab12.pdf');
  });

  it('去掉 `./`、重复与首尾分隔符', () => {
    assert.equal(normalizeStorageKey('./2026-10//x.png'), '2026-10/x.png');
    assert.equal(normalizeStorageKey('/2026-10/x.png/'), '2026-10/x.png');
    assert.equal(normalizeStorageKey('a/./b'), 'a/b');
  });

  it('空值 → 空串（不抛错，交由调用方决定）', () => {
    assert.equal(normalizeStorageKey(''), '');
    assert.equal(normalizeStorageKey(null as unknown as string), '');
  });
});

describe('assertSafeStorageKey：越权路径拦截', () => {
  it('正常键放行', () => {
    for (const k of ['2026-10/x.png', 'signed/1730-ab12.pdf', 'import-errors/import-errors-t1.xlsx', 'x.png']) {
      assert.doesNotThrow(() => assertSafeStorageKey(k));
    }
  });

  it('上级目录引用一律拒绝（含反斜杠写法与中间位置）', () => {
    for (const k of ['../etc/passwd', 'a/../../b', '..\\windows\\win.ini', 'a/b/../../../c', '..']) {
      assert.throws(() => assertSafeStorageKey(k), StorageKeyError, `应拒绝：${k}`);
    }
  });

  it('绝对路径 / 驱动器号 / UNC 一律拒绝', () => {
    for (const k of ['/etc/passwd', 'C:\\Windows\\win.ini', '\\\\server\\share\\x']) {
      assert.throws(() => assertSafeStorageKey(k), StorageKeyError, `应拒绝：${k}`);
    }
  });

  it('空键拒绝（避免拼出存储根目录本身被当成文件读写）', () => {
    assert.throws(() => assertSafeStorageKey(''), StorageKeyError);
    assert.throws(() => assertSafeStorageKey('   '), StorageKeyError);
  });
});

describe('absPathOf / publicUrlOf：绝对路径与对外 URL', () => {
  it('绝对路径 = 根目录 + 规范化键（平台分隔符由 path 决定）', () => {
    const root = path.join('/tmp', 'uploads');
    assert.equal(absPathOf(root, 'signed/x.pdf'), path.join(root, 'signed', 'x.pdf'));
    assert.equal(absPathOf(root, 'signed\\x.pdf'), path.join(root, 'signed', 'x.pdf'));
    assert.equal(absPathOf(root, ''), root);
  });

  it('对外 URL 用 `/` 分隔并带静态服务前缀（与 main.ts 的 useStaticAssets 一致）', () => {
    assert.equal(publicUrlOf('2026-10/x.png'), '/api/files/2026-10/x.png');
    assert.equal(publicUrlOf('signed\\x.pdf'), '/api/files/signed/x.pdf');
    assert.equal(publicUrlOf('', '/api/files'), '/api/files');
  });
});
