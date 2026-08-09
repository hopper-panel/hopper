import { Module } from '@nestjs/common';
import { NodesModule } from '../nodes/nodes.module.js';
import { TemplateEditorService } from './template-editor.service.js';
import { TemplateSyncService } from './template-sync.service.js';
import { TemplatesController } from './templates.controller.js';
import { TemplatesService } from './templates.service.js';

@Module({
  // For the editor alone: changing a template's stop has to be checked against
  // every node its servers already sit on, and that means a token decryption
  // and a capability probe per node.
  imports: [NodesModule],
  controllers: [TemplatesController],
  providers: [TemplatesService, TemplateEditorService, TemplateSyncService],
  exports: [TemplatesService, TemplateSyncService],
})
export class TemplatesModule {}
