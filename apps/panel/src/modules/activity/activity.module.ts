import { Module } from '@nestjs/common';
import { ActivityController } from './activity.controller.js';
import { ActivityRetentionService } from './retention.service.js';

/**
 * Audit log: read per server, and purged according to the retention set in the
 * administration.
 */
@Module({ controllers: [ActivityController], providers: [ActivityRetentionService] })
export class ActivityModule {}
