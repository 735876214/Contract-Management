import { Controller, ForbiddenException, Get, Param, Req, Res, UseGuards } from '@nestjs/common';
import type { Request, Response } from 'express';
import { PrismaClient } from '@prisma/client';
import * as path from 'path';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { StorageService } from '../../common/services/storage.service';
import { ProjectAccessService } from '../../common/services/project-access.service';
import { JwtUser } from '../../common/decorators/user.decorator';
import { projectIdOfStorageKey } from '../../common/utils/storage-keys';
import { resolveLegacyKeyOwner } from './legacy-key-owner';

/**
 * 本地文件读取（替代原来的 `useStaticAssets('/api/files')`）。
 *
 * - 需要登录（Bearer 或 httpOnly Cookie；JwtStrategy 仅对 GET 接受 Cookie）。
 *   原静态服务是**完全公开**的，敏感证件/发票/合同只要 URL 泄露就能下载；
 * - **还须是文件所属项目的成员**（2026-11-19 审计 P1）：
 *   · 键里带 `p/<projectId>/` 前缀（新上传与项目级归档）→ 按 `projectMember` 复核；
 *   · 历史键（`signed/…`、`2026-10/…`，键里没有归属信息）→ 用 `resolveLegacyKeyOwner`
 *     反查数据库引用推出归属项目，同样按成员校验；查不到引用即认定为「归属不明」并拒绝。
 *     跑过 `server/scripts/storage-migrate.mjs` 后，项目内的历史键会变成 `p/<projectId>/…`；
 * - 保持对外 URL 形态 `/api/files/<相对键>` 不变，数据库/前端链接无需迁移；
 * - 支持单段 Range（206），保证 PDF/图片预览与大文件下载体验。
 */
@UseGuards(JwtAuthGuard)
@Controller('files')
export class FileServeController {
  constructor(
    private storage: StorageService,
    private projectAccess: ProjectAccessService,
    private prisma: PrismaClient,
  ) {}

  @Get(':key(*)')
  async serve(@Param('key') key: string, @Req() req: Request, @Res() res: Response) {
    await this.assertOwnership(key, req);
    const buffer = await this.storage.read(key);
    const total = buffer.length;
    res.setHeader('Content-Type', contentTypeOf(key));
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Cache-Control', 'private, max-age=0');
    /**
     * 防存储型 XSS 的最后一道闸（第 7 轮审计）：上传口已拦 .html/.svg/.js 等类型，
     * 但历史文件可能是在规则生效前存进来的；nosniff 让浏览器不再按内容猜类型，
     * 加上 default-src 'none' 即使被当页面渲染也执行不了任何脚本。
     */
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");

    const range = parseRange(req.headers.range, total);
    if (range === 'invalid') {
      res.status(416);
      res.setHeader('Content-Range', `bytes */${total}`);
      res.end();
      return;
    }
    if (range) {
      const { start, end } = range;
      res.status(206);
      res.setHeader('Content-Range', `bytes ${start}-${end}/${total}`);
      res.setHeader('Content-Length', String(end - start + 1));
      res.end(buffer.subarray(start, end + 1));
      return;
    }
    res.setHeader('Content-Length', String(total));
    res.end(buffer);
  }

  /**
   * 归属校验：
   * - `p/<projectId>/…` → 调用方必须是该项目成员（超管放行）；
   * - 历史键（无前缀）→ 反查数据库引用确定归属项目，再按成员校验；
   *   数据库里没有任何引用 ⇒ 归属不明，拒绝（不再「登录即可读」）。
   */
  private async assertOwnership(key: string, req: Request): Promise<void> {
    const user = req.user as JwtUser | undefined;
    const prefixedProjectId = projectIdOfStorageKey(key);
    if (prefixedProjectId) {
      await this.projectAccess.assertAccess(user?.userId, prefixedProjectId, user?.isSuperAdmin);
      return;
    }
    const owner = await resolveLegacyKeyOwner(this.prisma, key);
    if (!owner) {
      throw new ForbiddenException(
        '该文件为历史文件（键内无项目归属），无法确认访问权限；请联系管理员执行 server/scripts/storage-migrate.mjs 迁移后再访问',
      );
    }
    if (owner.projectId) {
      await this.projectAccess.assertAccess(user?.userId, owner.projectId, user?.isSuperAdmin);
    }
  }
}

const MIME: Record<string, string> = {
  '.pdf': 'application/pdf',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.csv': 'text/csv; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.zip': 'application/zip',
};

function contentTypeOf(key: string): string {
  return MIME[path.extname(String(key || '')).toLowerCase()] || 'application/octet-stream';
}

/** 解析单段 Range；多段/非法返回 invalid，未带 Range 返回 null */
function parseRange(header: string | undefined, total: number): { start: number; end: number } | 'invalid' | null {
  if (!header) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(String(header).trim());
  if (!m) return 'invalid';
  const [, s, e] = m;
  if (!s && !e) return 'invalid';
  let start: number;
  let end: number;
  if (!s) {
    // bytes=-N：最后 N 字节
    const n = Number(e);
    if (!Number.isFinite(n) || n <= 0) return 'invalid';
    start = Math.max(0, total - n);
    end = total - 1;
  } else {
    start = Number(s);
    end = e ? Number(e) : total - 1;
    if (!Number.isFinite(start) || !Number.isFinite(end) || start > end) return 'invalid';
    if (start >= total) return 'invalid';
    end = Math.min(end, total - 1);
  }
  return { start, end };
}
