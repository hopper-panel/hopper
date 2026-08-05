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
 * Installs and updates the templates shipped with Hopper.
 *
 * The template's key serves as its identity: renaming "Paper" does not create a
 * second one, and an existing server keeps pointing at the same template.
 *
 * A template **edited by an administrator is never overwritten**. That is the
 * delicate point: without this rule, a Hopper update would silently erase an
 * operator's customised Docker image or adjusted startup command, and their
 * servers would stop working with nothing to explain why.
 */
@Injectable()
export class TemplateSyncService {
  private readonly logger = new Logger(TemplateSyncService.name);

  constructor(private readonly prisma: PrismaService) {}

  /** Installs the bundled catalogue. Called by the seed and on update. */
  async syncCatalog(): Promise<SyncOutcome> {
    const outcome: SyncOutcome = { created: 0, updated: 0, skipped: 0 };

    for (const definition of TEMPLATE_CATALOG) {
      const result = await this.upsert(definition);
      outcome[result] += 1;
    }

    this.logger.log(
      `Catalogue synchronised: ${outcome.created} created, ${outcome.updated} updated, ${outcome.skipped} kept as they are.`,
    );

    return outcome;
  }

  /**
   * Inserts or updates a template.
   *
   * @returns `created`, `updated`, or `skipped` if the administrator edited
   *   it.
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
      this.logger.debug(`Template "${definition.name}" kept: it was edited from the panel.`);
      return 'skipped';
    }

    await this.prisma.$transaction([
      this.prisma.template.update({ where: { id: existing.id }, data }),
      // The variables are replaced wholesale: tracking additions, removals and
      // renames one by one for a template nobody has touched would cost more
      // code than it is worth.
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
