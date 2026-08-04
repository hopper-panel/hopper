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
  /** Contenu du fichier egg, tel quel. */
  egg: z.unknown(),
  /** Groupe d'accueil. Créé s'il n'existe pas. */
  group: z.string().min(1).max(100),
});

type ImportEggDto = z.infer<typeof importEggSchema>;

/**
 * Réservé aux administrateurs : seuls eux créent des serveurs pour l'instant.
 * Quand les utilisateurs pourront en créer eux-mêmes, cette liste devra être
 * filtrée par ce qui leur est autorisé — d'où le contrôleur distinct plutôt
 * qu'une route ouverte qu'on oublierait de restreindre.
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
   * Réinstalle le catalogue livré avec Hopper.
   *
   * Utile après une mise à jour du panel. Les templates modifiés depuis
   * l'interface sont conservés tels quels.
   */
  @Post('sync')
  @HttpCode(HttpStatus.OK)
  syncCatalog(): Promise<SyncOutcome> {
    return this.sync.syncCatalog();
  }

  /**
   * Importe un « egg » Pterodactyl.
   *
   * Ouvre l'accès aux centaines d'eggs maintenus par la communauté, pour des
   * jeux et des modpacks que Hopper ne livrera jamais lui-même. Les points
   * demandant une relecture sont renvoyés avec le résultat plutôt que d'être
   * découverts au premier démarrage.
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
        // Le détail des problèmes de format est renvoyé : sans lui,
        // l'administrateur n'a aucun moyen de savoir quoi corriger.
        throw new BadRequestException({ message: error.message, issues: error.issues });
      }

      throw error;
    }
  }
}
