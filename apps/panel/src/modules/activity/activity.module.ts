import { Module } from '@nestjs/common';
import { ActivityController } from './activity.controller.js';
import { ActivityRetentionService } from './retention.service.js';

/**
 * Journal d'audit : lecture par serveur, et purge selon la rétention réglée
 * dans l'administration.
 */
@Module({ controllers: [ActivityController], providers: [ActivityRetentionService] })
export class ActivityModule {}
