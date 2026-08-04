import { EggImportError, importPterodactylEgg } from '@hopper/templates';
import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
} from '@nestjs/common';
import { z } from 'zod';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe.js';
import { AdminOnly } from '../auth/decorators.js';
import { TemplateSyncService, type SyncOutcome } from './template-sync.service.js';
import { TemplatesService, type TemplateView } from './templates.service.js';

const importEggSchema = z.object({
  /** Contents of the egg file, as is. */
  egg: z.unknown(),
  /** Group it lands in. Created if it does not exist. */
  group: z.string().min(1).max(100),
});

type ImportEggDto = z.infer<typeof importEggSchema>;

/**
 * Administrators only: they alone create servers for now. When users can create
 * their own, this list will have to be filtered by what they are allowed —
 * hence the separate controller rather than an open route somebody would forget
 * to restrict.
 */
@Controller('api/admin/templates')
@AdminOnly()
export class TemplatesController {
  constructor(
    private readonly templates: TemplatesService,
    private readonly sync: TemplateSyncService,
  ) {}

  @Get('groups')
  listGroups() {
    return this.templates.listGroups();
  }

  @Get()
  list(): Promise<TemplateView[]> {
    return this.templates.list();
  }

  @Get(':uuid')
  find(@Param('uuid') uuid: string): Promise<TemplateView> {
    return this.templates.findByUuid(uuid);
  }

  /**
   * Reinstalls the catalogue shipped with Hopper.
   *
   * Useful after a panel update. Templates edited from the interface are kept
   * as they are.
   */
  @Post('sync')
  @HttpCode(HttpStatus.OK)
  syncCatalog(): Promise<SyncOutcome> {
    return this.sync.syncCatalog();
  }

  /**
   * Imports a Pterodactyl egg.
   *
   * Opens access to the hundreds of eggs maintained by the community, for games
   * and modpacks Hopper will never ship itself. The points needing a
   * read-through are returned with the result rather than discovered on the
   * first start.
   */
  @Post('import')
  @HttpCode(HttpStatus.CREATED)
  async importEgg(
    @Body(new ZodValidationPipe(importEggSchema)) body: ImportEggDto,
  ): Promise<{ template: TemplateView; warnings: string[] }> {
    try {
      const { template, warnings } = importPterodactylEgg(body.egg, { group: body.group });

      await this.sync.upsert(template);

      return { template: await this.templates.findByKey(template.key), warnings };
    } catch (error: unknown) {
      if (error instanceof EggImportError) {
        // The detail of the format problems is returned: without it, the
        // administrator has no way of knowing what to fix.
        throw new BadRequestException({ message: error.message, issues: error.issues });
      }

      throw error;
    }
  }
}
