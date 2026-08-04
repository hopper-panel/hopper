import { Global, Module } from '@nestjs/common';
import { PrismaService } from './prisma.service.js';

/**
 * Global : le client Prisma est un singleton avec son propre pool de
 * connexions. L'injecter module par module multiplierait les pools.
 */
@Global()
@Module({
  providers: [PrismaService],
  exports: [PrismaService],
})
export class PrismaModule {}
