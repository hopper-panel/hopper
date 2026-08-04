import { Module } from '@nestjs/common';
import { TemplateSyncService } from './template-sync.service.js';
import { TemplatesController } from './templates.controller.js';
import { TemplatesService } from './templates.service.js';

@Module({
  controllers: [TemplatesController],
  providers: [TemplatesService, TemplateSyncService],
  exports: [TemplatesService, TemplateSyncService],
})
export class TemplatesModule {}
