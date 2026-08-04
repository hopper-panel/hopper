import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service.js';

/**
 * Normalises a template's images.
 *
 * The current format is an ordered array; the old object format is still read
 * so as not to break a template created before the change.
 */
function parseImageOptions(raw: unknown): DockerImageOption[] {
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
  name: string;
  description: string;
  author: string;
  group: { uuid: string; name: string };
  /** Ordered: the first is the default. */
  dockerImages: DockerImageOption[];
  startup: string;
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
    { uuid: string; name: string; description: string; templateCount: number }[]
  > {
    const groups = await this.prisma.templateGroup.findMany({
      include: { _count: { select: { templates: true } } },
      orderBy: { name: 'asc' },
    });

    return groups.map((group) => ({
      uuid: group.uuid,
      name: group.name,
      description: group.description,
      templateCount: group._count.templates,
    }));
  }

  async list(): Promise<TemplateView[]> {
    const templates = await this.prisma.template.findMany({
      include: { group: true, variables: true },
      orderBy: [{ group: { name: 'asc' } }, { name: 'asc' }],
    });

    return templates.map((template) => this.toView(template));
  }

  async findByUuid(uuid: string): Promise<TemplateView> {
    const template = await this.prisma.template.findUnique({
      where: { uuid },
      include: { group: true, variables: true },
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
      include: { group: true, variables: true },
    });

    if (!template) {
      throw new NotFoundException('Template not found.');
    }

    return this.toView(template);
  }

  private toView(template: {
    uuid: string;
    name: string;
    description: string;
    author: string;
    startup: string;
    dockerImages: unknown;
    group: { uuid: string; name: string };
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
      name: template.name,
      description: template.description,
      author: template.author,
      group: { uuid: template.group.uuid, name: template.group.name },
      dockerImages: parseImageOptions(template.dockerImages),
      startup: template.startup,
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
