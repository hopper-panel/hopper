import { TEMPLATE_CATALOG, type TemplateDefinition } from '@hopper/templates';
import { Injectable, Logger } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service.js';

export interface SyncOutcome {
  created: number;
  updated: number;
  skipped: number;
}

/**
 * Installe et met à jour les templates livrés avec Hopper.
 *
 * La clé du template sert d'identité : renommer « Paper » n'en crée pas un
 * second, et un serveur existant continue de pointer sur le même.
 *
 * Un template **modifié par un administrateur n'est jamais écrasé**. C'est le
 * point délicat : sans cette règle, une mise à jour de Hopper effacerait
 * silencieusement l'image Docker personnalisée ou la commande de démarrage
 * ajustée d'un opérateur, et ses serveurs cesseraient de fonctionner sans que
 * rien n'explique pourquoi.
 */
@Injectable()
export class TemplateSyncService {
  private readonly logger = new Logger(TemplateSyncService.name);

  constructor(private readonly prisma: PrismaService) {}

  /** Installe le catalogue embarqué. Appelé par le seed et à la mise à jour. */
  async syncCatalog(): Promise<SyncOutcome> {
    const outcome: SyncOutcome = { created: 0, updated: 0, skipped: 0 };

    for (const definition of TEMPLATE_CATALOG) {
      const result = await this.upsert(definition);
      outcome[result] += 1;
    }

    this.logger.log(
      `Catalogue synchronisé : ${outcome.created} créé(s), ${outcome.updated} mis à jour, ${outcome.skipped} conservé(s) tel(s) quel(s).`,
    );

    return outcome;
  }

  /**
   * Insère ou met à jour un template.
   *
   * @returns `created`, `updated`, ou `skipped` si l'administrateur l'a modifié.
   */
  async upsert(definition: TemplateDefinition): Promise<'created' | 'updated' | 'skipped'> {
    const group = await this.prisma.templateGroup.upsert({
      where: { name: definition.group },
      update: {},
      create: { name: definition.group },
    });

    const existing = await this.prisma.template.findFirst({
      where: { key: definition.key },
      select: { id: true, modifiedByAdmin: true },
    });

    const data = this.toPrismaData(definition, group.id);

    if (!existing) {
      await this.prisma.template.create({
        data: {
          ...data,
          key: definition.key,
          variables: { create: definition.variables.map(toVariableData) },
        },
      });

      return 'created';
    }

    if (existing.modifiedByAdmin) {
      this.logger.debug(
        `Template « ${definition.name} » conservé : il a été modifié depuis le panel.`,
      );
      return 'skipped';
    }

    await this.prisma.$transaction([
      this.prisma.template.update({ where: { id: existing.id }, data }),
      // Les variables sont remplacées en bloc : suivre les ajouts, retraits et
      // renommages une à une pour un template que personne n'a touché
      // coûterait plus de code qu'il n'en vaut la peine.
      this.prisma.templateVariable.deleteMany({ where: { templateId: existing.id } }),
      this.prisma.templateVariable.createMany({
        data: definition.variables.map((variable) => ({
          ...toVariableData(variable),
          templateId: existing.id,
        })),
      }),
    ]);

    return 'updated';
  }

  private toPrismaData(
    definition: TemplateDefinition,
    groupId: number,
  ): Omit<Prisma.TemplateUncheckedCreateInput, 'key' | 'variables'> {
    return {
      groupId,
      name: definition.name,
      description: definition.description,
      author: definition.author,
      dockerImages: definition.dockerImages,
      startup: definition.startup,
      stopCommand: definition.stopCommand,
      startupDetection: definition.startupDetection ?? null,
      configFiles: definition.configFiles,
      fileDenylist: definition.fileDenylist,
      installContainer: definition.installContainer,
      installEntrypoint: definition.installEntrypoint,
      installScript: definition.installScript,
      importedFromEgg: definition.importedFromEgg ?? null,
    };
  }
}

function toVariableData(variable: TemplateDefinition['variables'][number]) {
  return {
    name: variable.name,
    description: variable.description,
    envVariable: variable.envVariable,
    defaultValue: variable.defaultValue,
    userViewable: variable.userViewable,
    userEditable: variable.userEditable,
    rules: variable.rules,
  };
}
