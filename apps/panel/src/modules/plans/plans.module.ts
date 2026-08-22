import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module.js';
import { ApplicationPlansController } from './application-plans.controller.js';
import { PlansController } from './plans.controller.js';
import { PlansService } from './plans.service.js';

/**
 * Sellable offers.
 *
 * Two controllers over one service, and the split is the whole point: the
 * administration writes the catalogue, the application API reads it. See
 * `plans.controller.ts` for why a billing system does not get to create one.
 */
@Module({
  imports: [AuditModule],
  controllers: [PlansController, ApplicationPlansController],
  providers: [PlansService],
  exports: [PlansService],
})
export class PlansModule {}
