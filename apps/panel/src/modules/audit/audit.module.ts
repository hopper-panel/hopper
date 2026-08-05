import { Global, Module } from '@nestjs/common';
import { AuditService } from './audit.service.js';

/** Global: almost every module logs actions. */
@Global()
@Module({
  providers: [AuditService],
  exports: [AuditService],
})
export class AuditModule {}
