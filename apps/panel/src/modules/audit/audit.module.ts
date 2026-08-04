import { Global, Module } from '@nestjs/common';
import { AuditService } from './audit.service.js';

/** Global : presque tous les modules journalisent des actions. */
@Global()
@Module({
  providers: [AuditService],
  exports: [AuditService],
})
export class AuditModule {}
