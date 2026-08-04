import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service.js';

/**
 * Normalise les images d'un template.
 *
 * Le format courant est un tableau ordonné ; l'ancien format objet reste lu
 * pour ne pas casser un template créé avant le changement.
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
  /** Libellé affiché, ex. « Java 21 ». */
  name: string;
  image: string;
}

export interface TemplateView {
  uuid: string;
  name: string;
  description: string;
  author: string;
  group: { uuid: string; name: string };
  /** Ordonnées : la première est le défaut. */
  dockerImages: DockerImageOption[];
  startup: string;
  variables: TemplateVariableView[];
}

/**
 * Lecture des templates de serveurs.
 *
 * Volontairement en lecture seule à ce stade : la création, l'édition et
 * l'import d'« eggs » Pterodactyl arrivent en phase 3. L'interface a besoin dès
 * maintenant de lister les templates pour que la création d'un serveur ait un
 * sens.
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
      throw new NotFoundException('Template introuvable.');
    }

    return this.toView(template);
  }

  /** Recherche par clé stable, utilisée après un import ou une synchronisation. */
  async findByKey(key: string): Promise<TemplateView> {
    const template = await this.prisma.template.findUnique({
      where: { key },
      include: { group: true, variables: true },
    });

    if (!template) {
      throw new NotFoundException('Template introuvable.');
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
      // Une variable non visible est un détail d'implémentation du template
      // (chemin interne, drapeau de build) : l'exposer inviterait à la modifier.
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
