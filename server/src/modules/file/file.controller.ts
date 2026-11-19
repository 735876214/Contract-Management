import { BadRequestException, Controller, Post, Req, UploadedFiles, UseGuards, UseInterceptors } from '@nestjs/common';
import { FilesInterceptor } from '@nestjs/platform-express';
import { memoryStorage } from 'multer';
import * as path from 'path';
import type { Request } from 'express';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { StorageService } from '../../common/services/storage.service';
import { isDangerousUploadName } from '../../common/utils/upload-rules';
import { projectScopedSub } from '../../common/utils/storage-keys';

/**
 * 通用文件上传。
 *
 * 目录与命名规则**不在控制器里**：统一由 `StorageService.save()` 决定
 * （默认 `<UPLOAD_DIR>/<YYYY-MM>/<时间戳>-<随机串><ext>`，对外 URL 为 `/api/files/<相对键>`）。
 *
 * 安全：
 * - Multer 用内存存储，限制 10 个文件 × 50MB（与 nginx `client_max_body_size 50m` 一致）；
 * - 拒绝 `.html/.svg/.js/.exe` 等可执行/可脚本类型（静态服务是公开的，避免存储型 XSS）；
 * - 文件落盘仍只经 `StorageService`，模块内不再自行拼目录/文件名。
 *
 * **归属（2026-11-19 审计 P1）**：键里带上项目上下文（`p/<projectId>/<YYYY-MM>/…`），
 * 下载时 `FileServeController` 才能复核调用方是否为该项目成员。此前键里没有任何归属信息，
 * 任何登录用户拿到键就能跨项目下载别人的合同签章件/发票/证件。
 * 请求没带项目上下文时退回旧的平铺键（历史行为），不阻断上传。
 */
@UseGuards(JwtAuthGuard)
@Controller('files')
export class FileController {
  constructor(private storage: StorageService) {}

  @Post('upload')
  @UseInterceptors(
    FilesInterceptor('files', 10, {
      storage: memoryStorage(),
      limits: { fileSize: 50 * 1024 * 1024, files: 10 },
      fileFilter: (_req, file, cb) => {
        if (isDangerousUploadName(file?.originalname)) {
          cb(new BadRequestException(`不允许上传该类型文件：${file.originalname}`), false);
          return;
        }
        cb(null, true);
      },
    }),
  )
  async upload(@UploadedFiles() files: Express.Multer.File[], @Req() req: Request) {
    /**
     * 项目上下文只从 header / query 取（与 `JwtAuthGuard` 同口径，**绝不读 body**：
     * 守卫跑在 multer 之前，multipart 的 body 那时还是空的）。
     */
    const raw = (req as any).projectId || req.headers['x-project-id'] || (req.query?.projectId as string);
    const projectId = raw ? String(raw) : '';
    const sub = projectId ? projectScopedSub(projectId) : undefined;
    /**
     * 单请求总量兜底（第 7 轮审计）：multer 的 `limits` 是**逐文件** 50MB × 10 个，
     * 也就是一次请求最多能塞 500MB 进内存（memoryStorage），并发几发就能把进程打爆。
     * 这里按「一次请求合计 50MB」收紧，与 nginx `client_max_body_size 50m` 对齐。
     */
    const list = files || [];
    const totalBytes = list.reduce((s, f) => s + (f?.size || 0), 0);
    if (totalBytes > 50 * 1024 * 1024) {
      throw new BadRequestException('单次上传的文件合计不能超过 50MB，请分批上传');
    }
    if (list.some((f) => !f?.size)) {
      throw new BadRequestException('上传的文件不能为空');
    }
    return Promise.all(
      list.map(async (f) => {
        const saved = await this.storage.save(f.buffer, {
          ext: path.extname(f.originalname || ''),
          ...(sub ? { sub } : {}),
        });
        return {
          fileName: f.originalname,
          // 公开 URL（展示用）与相对存储键（落库用）同时返回
          url: saved.url,
          key: saved.key,
          size: saved.size,
        };
      }),
    );
  }
}
