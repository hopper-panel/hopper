import { readinessSchema, type Readiness } from '@hopper/shared';
import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service.js';

/**
 * Normalises a template's images.
 *
 * The current format is an ordered array; the old object format is still read
 * so as not to break a template created before the change.
 */
export function parseImageOptions(raw: unknown): DockerImageOption[] {
  if (Array.isArray(raw)) {
    return raw
      .map((entry) => entry as { name?: unknown; image?: unknown })
      .filter(
        (entry): entry is DockerImageOption =>
          typeof entry?.name === 'string' && typeof entry.image === 'string',
      );
  }

  if (raw && typeof raw === 'object') {
    return Object.entries(raw as Record<string, unknown>)
      .filter((entry): entry is [string, string] => typeof entry[1] === 'string')
      .map(([name, image]) => ({ name, image }));
  }

  return [];
}

/**
 * Normalises a template's readiness strategy.
 *
 * The column is free-form JSON, so a value that does not match the contract is
 * possible and reads here as "nothing declared". The view does not try to tell
 * the two apart: the place that has to shout about an unreadable strategy is
 * `ServerConfigurationService`, where it actually changes what the daemon
 * waits for. This is a display of what the template says, not a diagnosis.
 */
export function parseReadiness(raw: unknown): Readiness | null {
  if (raw === null || raw === undefined) {
    return null;
  }

  const result = readinessSchema.safeParse(raw);

  return result.success ? result.data : null;
}

export interface TemplateVariableView {
  name: string;
  description: string;
  envVariable: string;
  defaultValue: string;
  userEditable: boolean;
  rules: string;
}

export interface DockerImageOption {
  /** Displayed label, e.g. "Java 21". */
  name: string;
  image: string;
}

export interface TemplateView {
  uuid: string;
  /**
   * The upsert key, and the three things the listing needs it for: telling two
   * templates of the same name apart, addressing one in a support thread, and
   * showing an author which of their keys are taken before they pick another.
   *
   * The catalogue page has rendered this field since it was written and it has
   * never once arrived — the page declared it on an interface of its own and
   * TypeScript checked the components against that declaration rather than
   * against this one. Same for `modifiedByAdmin` below, which is the whole
   * point of the badge beside the name: a template the operator has edited is
   * skipped by every later resynchronisation, and until now nothing anywhere
   * said which ones those were.
   */
  key: string;
  name: string;
  description: string;
  author: string;
  /** True once an administrator has edited it; catalogue syncs then skip it. */
  modifiedByAdmin: boolean;
  /**
   * How many servers were built from it.
   *
   * Shown so that the refusal is predictable rather than discovered: deleting a
   * template with servers on it is a `ConflictException`, and the count is the
   * only thing that tells an operator whether the button in front of them will
   * work.
   */
  serverCount: number;
  group: { uuid: string; name: string };
  /** Ordered: the first is the default. */
  dockerImages: DockerImageOption[];
  startup: string;
  /**
   * How a server built from this template announces it is ready, or `null`
   * when the template declares nothing and the daemon falls back to the
   * console pattern.
   *
   * Read-only, and exposed for one reason: a server that never leaves
   * `starting` is waiting for something, and until this was visible there was
   * no way to find out what — the strategy lived in a JSON column the
   * interface never showed.
   */
  readiness: Readiness | null;
  variables: TemplateVariableView[];
}

/**
 * Reading server templates.
 *
 * Deliberately read-only here: creating and editing templates is done through
 * the catalogue and the egg importer. The interface needs to list templates for
 * server creation to make sense.
 */
@Injectable()
export class TemplatesService {
  constructor(private readonly prisma: PrismaService) {}

  async listGroups(): Promise<
    { uuid: string; name: string; description: string; author: string; templateCount: number }[]
  > {
    const groups = await this.prisma.templateGroup.findMany({
      include: { _count: { select: { templates: true } } },
      orderBy: { name: 'asc' },
    });

    return groups.map((group) => ({
      uuid: group.uuid,
      name: group.name,
      description: group.description,
      // Additive: nothing reading this list before had the field, and the group
      // editor would otherwise have to fetch a group one at a time to show the
      // one column it is there to change.
      author: group.author,
      templateCount: group._count.templates,
    }));
  }

  async list(): Promise<TemplateView[]> {
    const templates = await this.prisma.template.findMany({
      include: { group: true, variables: true, _count: { select: { servers: true } } },
      orderBy: [{ group: { name: 'asc' } }, { name: 'asc' }],
    });

    return templates.map((template) => this.toView(template));
  }

  async findByUuid(uuid: string): Promise<TemplateView> {
    const template = await this.prisma.template.findUnique({
      where: { uuid },
      include: { group: true, variables: true, _count: { select: { servers: true } } },
    });

    if (!template) {
      throw new NotFoundException('Template not found.');
    }

    return this.toView(template);
  }

  /** Lookup by stable key, used after an import or a synchronisation. */
  async findByKey(key: string): Promise<TemplateView> {
    const template = await this.prisma.template.findUnique({
      where: { key },
      include: { group: true, variables: true, _count: { select: { servers: true } } },
    });

    if (!template) {
      throw new NotFoundException('Template not found.');
    }

    return this.toView(template);
  }

  private toView(template: {
    uuid: string;
    key: string;
    name: string;
    description: string;
    author: string;
    modifiedByAdmin: boolean;
    startup: string;
    dockerImages: unknown;
    readiness: unknown;
    group: { uuid: string; name: string };
    _count: { servers: number };
    variables: {
      name: string;
      description: string;
      envVariable: string;
      defaultValue: string;
      userViewable: boolean;
      userEditable: boolean;
      rules: string;
    }[];
  }): TemplateView {
    return {
      uuid: template.uuid,
      key: template.key,
      name: template.name,
      description: template.description,
      author: template.author,
      modifiedByAdmin: template.modifiedByAdmin,
      serverCount: template._count.servers,
      group: { uuid: template.group.uuid, name: template.group.name },
      dockerImages: parseImageOptions(template.dockerImages),
      startup: template.startup,
      readiness: parseReadiness(template.readiness),
      // A non-viewable variable is an implementation detail of the template
      // (internal path, build flag): exposing it would invite editing it.
      variables: template.variables
        .filter((variable) => variable.userViewable)
        .map((variable) => ({
          name: variable.name,
          description: variable.description,
          envVariable: variable.envVariable,
          defaultValue: variable.defaultValue,
          userEditable: variable.userEditable,
          rules: variable.rules,
        })),
    };
  }
}
