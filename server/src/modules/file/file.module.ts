import { Module } from '@nestjs/common';
import { FileController } from './file.controller';
import { FileServeController } from './file-serve.controller';

@Module({
  controllers: [FileController, FileServeController],
})
export class FileModule {}
