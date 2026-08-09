import { TEMPLATE_CATALOG, type TemplateDefinition } from '@hopper/templates';
import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
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

    const data = templateColumns(definition, group.id);

    if (!existing) {
      await this.prisma.template.create({
        data: {
          ...data,
          key: definition.key,
          variables: {
            create: definition.variables.map((variable, index) =>
              templateVariableColumns(variable, index),
            ),
          },
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
        data: definition.variables.map((variable, index) => ({
          ...templateVariableColumns(variable, index),
          templateId: existing.id,
        })),
      }),
    ]);

    return 'updated';
  }
}

/**
 * A definition's columns, minus the ones only the caller knows.
 *
 * A free function, and exported, because the template editor writes the same
 * columns from the same shape and every one of the `DbNull` decisions below is
 * a rule about what a *template* means rather than about what a
 * synchronisation does. A second copy of them in the editor would be a second
 * answer: the seed already keeps a copy of this mapping, and
 * `template-sync.service.spec.ts` exists largely to catch the two drifting.
 */
export function templateColumns(
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
    // Same `Prisma.DbNull` reasoning as `readiness` below, and the stakes are
    // higher: a template that dropped its structured stop while the column
    // kept the old one would go on being stopped over a transport its author
    // has removed — over RCON to a port they no longer name, which fails and,
    // by design, refuses the stop outright.
    stop: definition.stop ?? Prisma.DbNull,
    // Plain `null` and not `DbNull`: an ordinary nullable column takes one,
    // and it says the same thing — this template names no timeout, so the
    // panel supplies the contract's default.
    stopTimeoutSeconds: definition.stopTimeoutSeconds ?? null,
    startupDetection: definition.startupDetection ?? null,
    // `Prisma.DbNull` and not `undefined`: on an update, an undefined field
    // means "leave the column alone", so a template that dropped its
    // readiness would keep the old strategy for ever with nothing in the
    // catalogue declaring it. Not a bare `null` either — Prisma refuses one
    // on a nullable Json column, since it cannot tell SQL NULL from the JSON
    // value `null`. SQL NULL is what every row predating the column holds,
    // and therefore what "declares nothing" has to mean.
    readiness: definition.readiness ?? Prisma.DbNull,
    configFiles: definition.configFiles,
    fileDenylist: definition.fileDenylist,
    installContainer: definition.installContainer,
    installEntrypoint: definition.installEntrypoint,
    installScript: definition.installScript,
    // The two install guards, and plain nulls for the same reason as
    // `stopTimeoutSeconds` above: ordinary nullable columns, on which null
    // says "this template names no figure" and the daemon supplies its own.
    // Written on every write rather than left undefined so that a template
    // which *drops* a figure has the row forget it too — a stale inactivity
    // window would go on stopping installations its author has decided are
    // allowed to take longer.
    installInactivityTimeoutMs: definition.installInactivityTimeoutMs ?? null,
    installRequiredDiskBytes: definition.installRequiredDiskBytes ?? null,
    importedFromEgg: definition.importedFromEgg ?? null,
  };
}

/**
 * A variable's columns, its place in the list included.
 *
 * `sort` comes from the position in the array rather than from the definition,
 * because no definition carries one: the order a template author wrote the
 * variables in *is* the order, and it is the only statement of intent there is.
 * Written here too and not only by the editor, so that a resynchronised
 * template and an edited one are ordered by the same column.
 */
export function templateVariableColumns(
  variable: TemplateDefinition['variables'][number],
  sort = 0,
) {
  return {
    name: variable.name,
    description: variable.description,
    envVariable: variable.envVariable,
    defaultValue: variable.defaultValue,
    userViewable: variable.userViewable,
    userEditable: variable.userEditable,
    rules: variable.rules,
    sort,
  };
}
