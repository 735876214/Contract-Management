import { BadRequestException, Controller, Post, UploadedFiles, UseGuards, UseInterceptors } from '@nestjs/common';
import { FilesInterceptor } from '@nestjs/platform-express';
import { memoryStorage } from 'multer';
import * as path from 'path';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { StorageService } from '../../common/services/storage.service';
import { isDangerousUploadName } from '../../common/utils/upload-rules';

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
  async upload(@UploadedFiles() files: Express.Multer.File[]) {
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
