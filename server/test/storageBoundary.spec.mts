import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * 文件 I/O「单一入口」边界锁（评审意见 #4：文件服务接口化）。
 *
 * 现状：3 个落盘点（上传 / 合同签章件 / 导入错误报告）与全部读取已收敛到
 * `common/services/storage.service.ts`（键与路径规则在 `common/utils/storage-keys.ts`，是纯函数不碰 fs）。
 * 本测试把结论钉死：**`server/src` 里除 StorageService 外不得再出现任何 `fs.` 调用**——
 * 否则将来换对象存储（MinIO/S3）时又会出现"漏改一处、只在生产上炸"的老问题。
 *
 * 换存储实现的正确做法：实现同一个 `StorageLike`，改 `common.module.ts` 的 provider 绑定；
 * 静态资源服务（`main.ts` 的 `useStaticAssets`）需一并改为代理/重定向。
 * 若确实需要新增文件 I/O，请把它加进 StorageService，而不是在 service/controller 里直接 fs。
 */

const srcRoot = fileURLToPath(new URL('../src/', import.meta.url));
/** 唯一允许直接碰 fs 的文件（相对 src/） */
const ALLOWED = ['common/services/storage.service.ts'];

const walk = (dir: string, out: string[] = []): string[] => {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (entry.endsWith('.ts')) out.push(full);
  }
  return out;
};

const files = walk(srcRoot);
const rel = (f: string) => path.relative(srcRoot, f).replace(/\\/g, '/');
const FS_CALL = /\bfs\.(promises\.)?[a-zA-Z]/g;

describe('文件 I/O 边界（只允许 StorageService 碰 fs）', () => {
  it('扫描面不能为空（防路径写错导致测试恒真）', () => {
    assert.ok(files.length >= 30, `扫描到的 src 文件过少（${files.length}），路径可能不对`);
    for (const f of ALLOWED) assert.ok(files.some((x) => rel(x) === f), `白名单文件不存在：${f}（改名后请同步本测试）`);
  });

  it('白名单文件自身确实在用 fs（否则本锁形同虚设）', () => {
    const src = readFileSync(files.find((f) => rel(f) === ALLOWED[0]) as string, 'utf8');
    assert.ok((src.match(FS_CALL) || []).length >= 3, 'StorageService 里没检测到 fs 调用，检测逻辑可能失效');
  });

  it('除白名单外，`server/src` 里不得出现 fs 调用', () => {
    const offenders: string[] = [];
    for (const file of files) {
      const r = rel(file);
      if (ALLOWED.includes(r)) continue;
      readFileSync(file, 'utf8')
        .split('\n')
        .forEach((line, i) => {
          if (/\bfs\./.test(line) && !/^\s*(\/\/|\*|\/\*)/.test(line.trim())) {
            offenders.push(`${r}:${i + 1} → ${line.trim()}`);
          }
        });
    }
    assert.deepEqual(
      offenders,
      [],
      `文件 I/O 必须走 StorageService（common/services/storage.service.ts），不要在业务代码里直接 fs：\n${offenders.join('\n')}`,
    );
  });
});
