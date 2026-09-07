import { Global, Module } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';

@Global()
@Module({
  providers: [
    {
      provide: PrismaClient,
      useFactory: () => new PrismaClient({ log: ['error', 'warn'] }),
    },
  ],
  exports: [PrismaClient],
})
export class PrismaModule {}
