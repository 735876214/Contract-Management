import { Controller, Post, UploadedFiles, UseGuards, UseInterceptors } from '@nestjs/common';
import { FilesInterceptor } from '@nestjs/platform-express';
import { diskStorage } from 'multer';
import * as path from 'path';
import * as fs from 'fs';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';

const UPLOAD_DIR = process.env.UPLOAD_DIR || './uploads';

@UseGuards(JwtAuthGuard)
@Controller('files')
export class FileController {
  @Post('upload')
  @UseInterceptors(
    FilesInterceptor('files', 10, {
      storage: diskStorage({
        destination: (req, file, cb) => {
          const dir = path.isAbsolute(UPLOAD_DIR) ? UPLOAD_DIR : path.join(process.cwd(), UPLOAD_DIR);
          const sub = path.join(dir, new Date().toISOString().slice(0, 7));
          if (!fs.existsSync(sub)) fs.mkdirSync(sub, { recursive: true });
          cb(null, sub);
        },
        filename: (req, file, cb) => {
          const ext = path.extname(file.originalname);
          const name = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}${ext}`;
          cb(null, name);
        },
      }),
    }),
  )
  upload(@UploadedFiles() files: any[]) {
    return (files || []).map((f) => ({
      fileName: f.originalname,
      url: `/api/files/${f.path.split(path.sep).slice(-2).join('/')}`,
      size: f.size,
    }));
  }
}
