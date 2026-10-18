import { Controller, Post, UploadedFiles, UseGuards, UseInterceptors } from '@nestjs/common';
import { FilesInterceptor } from '@nestjs/platform-express';
import { diskStorage } from 'multer';
import * as path from 'path';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { StorageService } from '../../common/services/storage.service';

/**
 * 通用文件上传。
 *
 * 目录与命名规则**不再写在控制器里**，统一由 `StorageService` 决定：
 * 默认落到 `<UPLOAD_DIR>/<YYYY-MM>/<时间戳>-<随机串><ext>`，对外 URL 为 `/api/files/<相对键>`
 * （静态服务见 `main.ts` 的 `useStaticAssets`）。
 *
 * ⚠️ 这里是**模块级实例**而不是注入的 `this.storage`：`FilesInterceptor(...)` 的参数在**类定义期**求值，
 * 那时的 `this` 不是控制器实例（`this.storage` 会是 undefined）——这也是改造前这些回调只用模块级常量的原因。
 * `StorageService` 是无状态服务（根目录由环境派生、调用时才解析），故本地实例与容器内实例等价；
 * 将来换对象存储时，本控制器应改为 `memoryStorage()` 收进内存再 `storage.save(buffer)`。
 */
const diskStorageService = new StorageService();

@UseGuards(JwtAuthGuard)
@Controller('files')
export class FileController {
  @Post('upload')
  @UseInterceptors(
    FilesInterceptor('files', 10, {
      storage: diskStorage({
        destination: (req, file, cb) => {
          try {
            // 缺省即默认上传目录（<UPLOAD_DIR>/<YYYY-MM>），与 StorageService.save() 口径一致
            cb(null, diskStorageService.resolveDir());
          } catch (e) {
            cb(e as Error, '');
          }
        },
        filename: (req, file, cb) => cb(null, diskStorageService.allocateName(path.extname(file?.originalname || ''))),
      }),
    }),
  )
  upload(@UploadedFiles() files: any[]) {
    return (files || []).map((f) => {
      // multer 给的是绝对路径；相对键 = 相对存储根目录（统一以 `/` 分隔，避免 Windows 下写成反斜杠）
      const key = path.relative(diskStorageService.root, f.path).split(path.sep).join('/');
      return {
        fileName: f.originalname,
        // 公开 URL（展示用）与相对存储键（落库用）同时返回：
        // 前端曾把 url 原样存进 fileUrl，后端按相对键读盘时被安全校验拒绝（2026-10-18 修）。
        url: diskStorageService.publicUrl(key),
        key,
        size: f.size,
      };
    });
  }
}
