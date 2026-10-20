import { BadRequestException, Injectable } from '@nestjs/common';
import * as fs from 'fs';
import {
  StorageKeyError,
  absPathOf,
  assertSafeStorageKey,
  defaultSubDir,
  normalizeStorageKey,
  publicUrlOf,
  resolveUploadRoot,
  storageFileName,
} from '../utils/storage-keys';

/**
 * 文件存储的**单一入口**（`StorageLike` 接口 + 本地磁盘实现）。
 *
 * 背景：落盘写入点此前散在 **3 处**（`file.controller` 的 multer、`contract.service.sign()` 的签章件、
 * `import-task.service` 的导入错误报告），各自拼目录/文件名（连"UPLOAD_DIR 相对还是绝对"都要各判一次），
 * 规则容易漂移，将来接对象存储也无处下手。现在统一走本服务：
 * - 目录/命名规则、越权路径校验、对外 URL 全部收在这里；
 * - 调用方只拿一个**相对键**（如 `signed/1730-ab12.pdf`）与 `publicUrl(key)`。
 *
 * 换对象存储（MinIO/S3）时：实现同一个 `StorageLike` 并替换 provider **即可**，调用方不动。
 * 读取改由 `FileServeController`（`JwtAuthGuard` + Range）代理；`main.ts` 已不再 `useStaticAssets`
 * 直接把目录暴露成 URL，对象存储下要改成代理/重定向（本轮不做：无 MinIO 等基础设施时写出的分支无法验收）。
 *
 * 安全：所有键经 `assertSafeStorageKey` 校验，`..` / 绝对路径 / UNC 一律 400，
 * 不把用户可控字符串直接拼进 `fs` 路径（历史上的典型越权读盘面）。
 */

export interface SaveOptions {
  /** 子目录（如 `signed` / `import-errors` / `2026-10`）；缺省为当前月份 `YYYY-MM` */
  sub?: string;
  /** 扩展名（含或不含点均可；缺省无扩展名） */
  ext?: string;
  /** 指定文件名（缺省用 `<时间戳>-<随机串><ext>`；仍会做键安全校验） */
  name?: string;
}

export interface SavedFile {
  /** 相对键（落库/传参用），如 `signed/1730-ab12.pdf` */
  key: string;
  /** 对外可访问 URL（本地实现 = 静态服务前缀） */
  url: string;
  size: number;
}

export interface StorageLike {
  save(buffer: Buffer, options?: SaveOptions): Promise<SavedFile>;
  read(key: string): Promise<Buffer>;
  exists(key: string): Promise<boolean>;
  remove(key: string): Promise<boolean>;
  publicUrl(key: string): string;
  absPath(key: string): string;
}

@Injectable()
export class StorageService implements StorageLike {
  private rootOverride?: string;

  /**
   * 存储根目录（`resolveUploadRoot()` 基于 `UPLOAD_DIR` 解析）。
   * **故意不做构造器注入**：根目录是环境派生的，构造器带参会迫使 Nest 去解析 `String` 依赖；
   * 需要指定目录的场景（单测、多租户隔离）用 `useRoot()`。
   */
  get root(): string {
    return this.rootOverride ?? resolveUploadRoot(process.env.UPLOAD_DIR);
  }

  /** 指定存储根目录（测试用；返回自身便于链式调用） */
  useRoot(dir: string): this {
    this.rootOverride = dir;
    return this;
  }

  /** 校验并规范化键；非法 → 400（而不是 500），便于前端定位到具体字段 */
  private safeKey(key: string): string {
    try {
      assertSafeStorageKey(key);
    } catch (e) {
      if (e instanceof StorageKeyError) throw new BadRequestException(e.message);
      throw e;
    }
    return normalizeStorageKey(key);
  }

  /** 相对键 → 绝对路径（先校验，再拼接） */
  absPath(key: string): string {
    return absPathOf(this.root, this.safeKey(key));
  }

  publicUrl(key: string): string {
    return publicUrlOf(normalizeStorageKey(key));
  }

  /**
   * 确保**存储根目录**存在并返回它（幂等）。
   * 供启动引导使用：`main.ts` 启动时必须先建好根目录（否则 `FileServeController` 读写直接报错）。
   * 有了它，服务端就再无 `StorageService` 之外的 fs 调用（由 `server/test/storageBoundary.spec.mts` 锁住）。
   */
  ensureRoot(): string {
    const dir = this.root;
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    return dir;
  }

  /**
   * 确保子目录存在并返回其绝对路径（**同步**，供 multer 的 destination 回调使用）。
   * 缺省即**默认上传目录** `<root>/<YYYY-MM>`（与 `save()` 的口径一致；需要存储根目录时用 `.root`）。
   */
  resolveDir(sub?: string): string {
    const clean = (sub ?? '').trim() || defaultSubDir();
    const dir = absPathOf(this.root, this.safeKey(clean));
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    return dir;
  }

  /** 生成文件名（**同步**，供 multer 的 filename 回调使用） */
  allocateName(ext?: string): string {
    return storageFileName(ext);
  }

  async save(buffer: Buffer, options: SaveOptions = {}): Promise<SavedFile> {
    const name = (options.name ?? '').trim() || storageFileName(options.ext);
    const sub = (options.sub ?? '').trim() || defaultSubDir();
    const key = this.safeKey(`${sub}/${name}`);
    const dir = this.resolveDir(sub);
    await fs.promises.writeFile(absPathOf(this.root, key), buffer);
    return { key, url: this.publicUrl(key), size: buffer?.length ?? 0 };
  }

  async read(key: string): Promise<Buffer> {
    const abs = this.absPath(key);
    if (!fs.existsSync(abs)) throw new BadRequestException('文件不存在或已被清理');
    return fs.promises.readFile(abs);
  }

  async exists(key: string): Promise<boolean> {
    return fs.existsSync(this.absPath(key));
  }

  async remove(key: string): Promise<boolean> {
    const abs = this.absPath(key);
    if (!fs.existsSync(abs)) return false;
    await fs.promises.unlink(abs);
    return true;
  }
}

/**
 * 换实现的方式（无需改调用方）：
 * 新建 `S3StorageService implements StorageLike`，把 `common.module.ts` 的
 * `providers: [StorageService]` 改成 `{ provide: StorageService, useClass: S3StorageService }` 即可。
 */
