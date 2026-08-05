import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module.js';
import { UpdatesController } from './updates.controller.js';
import { UpdatesService } from './updates.service.js';

@Module({
  imports: [AuditModule],
  controllers: [UpdatesController],
  providers: [UpdatesService],
})
export class UpdatesModule {}
