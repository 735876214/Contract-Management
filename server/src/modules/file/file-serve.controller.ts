import { Controller, Get, Param, Req, Res, UseGuards } from '@nestjs/common';
import type { Request, Response } from 'express';
import * as path from 'path';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { StorageService } from '../../common/services/storage.service';

/**
 * 本地文件读取（替代原来的 `useStaticAssets('/api/files')`）。
 *
 * - 需要登录（Bearer 或 httpOnly Cookie；JwtStrategy 仅对 GET 接受 Cookie）。
 *   原静态服务是**完全公开**的，敏感证件/发票/合同只要 URL 泄露就能下载；
 * - 保持对外 URL 形态 `/api/files/<相对键>` 不变，数据库/前端链接无需迁移；
 * - 支持单段 Range（206），保证 PDF/图片预览与大文件下载体验。
 */
@UseGuards(JwtAuthGuard)
@Controller('files')
export class FileServeController {
  constructor(private storage: StorageService) {}

  @Get(':key(*)')
  async serve(@Param('key') key: string, @Req() req: Request, @Res() res: Response) {
    const buffer = await this.storage.read(key);
    const total = buffer.length;
    res.setHeader('Content-Type', contentTypeOf(key));
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Cache-Control', 'private, max-age=0');

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
