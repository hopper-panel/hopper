import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service.js';
import { NodeClientService } from '../nodes/node-client.service.js';
import { NodesService } from '../nodes/nodes.service.js';
import { ServerConfigurationService } from '../servers/server-configuration.service.js';
import { validateValue } from './variable-rules.js';

/**
 * Paramètres de démarrage d'un serveur.
 *
 * Trois éléments décident de ce qui s'exécute dans le conteneur : la commande
 * de lancement, l'image Docker, et les variables du template. Les deux derniers
 * sont modifiables ici ; la commande, elle, appartient au template et n'est
 * qu'affichée — la laisser éditer par l'utilisateur d'un serveur reviendrait à
 * lui donner le choix du binaire exécuté.
 *
 * Deux filtres, et non un seul :
 *
 *  - `userViewable` décide de ce qui est **rendu** ; une variable masquée
 *    contient souvent un secret et ne doit apparaître dans aucune réponse ;
 *  - `userEditable` décide de ce qui est **accepté** en écriture. Une variable
 *    non modifiable soumise est refusée plutôt qu'ignorée : l'ignorer
 *    laisserait croire que le changement a été pris en compte.
 */
@Injectable()
export class StartupService {
  private readonly logger = new Logger(StartupService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly configurations: ServerConfigurationService,
    private readonly nodes: NodesService,
    private readonly client: NodeClientService,
  ) {}

  async get(serverUuid: string) {
    const server = await this.requireServer(serverUuid);

    const variables = await this.prisma.templateVariable.findMany({
      where: { templateId: server.templateId },
      orderBy: { id: 'asc' },
    });

    const values = await this.prisma.serverVariable.findMany({
      where: { serverId: server.id },
    });

    // Indexé par nom de variable d'environnement, et non par identifiant de
    // variable de template : c'est ainsi que la valeur est stockée, pour qu'un
    // template modifié après coup ne casse pas les serveurs existants.
    const byEnv = new Map(values.map((value) => [value.envVariable, value.value]));

    return {
      /** Gabarit du template, variables non substituées : c'est ce qui sera exécuté. */
      startupCommand: server.startupCommand,
      dockerImage: server.dockerImage,
      dockerImages: readImages(server.template.dockerImages),
      variables: variables
        .filter((variable) => variable.userViewable)
        .map((variable) => ({
          envVariable: variable.envVariable,
          name: variable.name,
          description: variable.description,
          value: byEnv.get(variable.envVariable) ?? variable.defaultValue,
          defaultValue: variable.defaultValue,
          editable: variable.userEditable,
          rules: variable.rules,
        })),
    };
  }

  async update(
    serverUuid: string,
    input: { variables?: Record<string, string>; dockerImage?: string },
    granted: { canChangeImage: boolean },
  ) {
    const server = await this.requireServer(serverUuid);

    if (input.dockerImage !== undefined) {
      await this.applyImage(server, input.dockerImage, granted.canChangeImage);
    }

    if (input.variables !== undefined) {
      await this.applyVariables(server.id, server.templateId, input.variables);
    }

    await this.pushConfiguration(serverUuid, server.nodeId);

    return this.get(serverUuid);
  }

  private async applyImage(
    server: { id: number; template: { dockerImages: unknown } },
    image: string,
    allowed: boolean,
  ): Promise<void> {
    if (!allowed) {
      throw new BadRequestException(
        "Vous n'avez pas la permission de changer l'image Docker de ce serveur.",
      );
    }

    // L'image doit venir du template. Sans cette vérification, une valeur
    // libre ferait exécuter n'importe quelle image du registre — donc n'importe
    // quel programme — dans un conteneur monté sur le volume du serveur.
    const proposed = readImages(server.template.dockerImages);

    if (!proposed.some((candidate) => candidate.image === image)) {
      throw new BadRequestException("Cette image n'est pas proposée par le template du serveur.");
    }

    await this.prisma.server.update({ where: { id: server.id }, data: { dockerImage: image } });
  }

  private async applyVariables(
    serverId: number,
    templateId: number,
    submitted: Record<string, string>,
  ): Promise<void> {
    const variables = await this.prisma.templateVariable.findMany({ where: { templateId } });
    const byEnv = new Map(variables.map((variable) => [variable.envVariable, variable]));

    const errors: string[] = [];

    for (const [envVariable, value] of Object.entries(submitted)) {
      const variable = byEnv.get(envVariable);

      if (!variable) {
        errors.push(`${envVariable} : variable inconnue de ce template.`);
        continue;
      }

      // Refus explicite plutôt qu'omission silencieuse : une variable masquée
      // ou verrouillée soumise est soit une erreur de l'interface, soit une
      // tentative — dans les deux cas, le dire vaut mieux que l'ignorer.
      if (!variable.userEditable || !variable.userViewable) {
        errors.push(`${variable.name} : cette variable n'est pas modifiable.`);
        continue;
      }

      const violations = validateValue(value, variable.rules);

      if (violations.length > 0) {
        errors.push(`${variable.name} : ${violations.map((one) => one.message).join(' ')}`);
      }
    }

    if (errors.length > 0) {
      throw new BadRequestException(errors.join('\n'));
    }

    // Écriture seulement une fois **tout** validé : une saisie à moitié
    // appliquée laisserait un serveur dans un état que personne n'a demandé.
    for (const [envVariable, value] of Object.entries(submitted)) {
      await this.prisma.serverVariable.upsert({
        where: { serverId_envVariable: { serverId, envVariable } },
        create: { serverId, envVariable, value },
        update: { value },
      });
    }
  }

  /**
   * Renvoie la configuration au daemon.
   *
   * Un échec n'annule pas le changement : il est en base, et la réconciliation
   * du daemon le rattrapera. Le refuser parce que le node est momentanément
   * injoignable laisserait le panel et la machine désaccordés.
   */
  private async pushConfiguration(serverUuid: string, nodeId: number): Promise<void> {
    try {
      const node = await this.prisma.node.findUniqueOrThrow({
        where: { id: nodeId },
        select: { uuid: true },
      });

      const configuration = await this.configurations.build(serverUuid);
      const connection = await this.nodes.getConnection(node.uuid);

      await this.client.syncServer(connection, configuration);
    } catch (error: unknown) {
      this.logger.warn(
        `Synchronisation du serveur ${serverUuid} impossible, elle sera rattrapée au prochain ` +
          `démarrage du daemon : ${String(error)}`,
      );
    }
  }

  private async requireServer(uuid: string) {
    const server = await this.prisma.server.findUnique({
      where: { uuid },
      include: { template: { select: { dockerImages: true } } },
    });

    if (!server) {
      throw new NotFoundException('Serveur introuvable.');
    }

    return server;
  }
}

export interface DockerImage {
  name: string;
  image: string;
}

/**
 * Lit la liste d'images du template.
 *
 * Stockée en JSON : sa forme n'est pas garantie par la base, et un template
 * importé d'un egg mal formé ne doit pas faire échouer l'affichage de la page.
 */
function readImages(raw: unknown): DockerImage[] {
  if (!Array.isArray(raw)) {
    return [];
  }

  return raw.filter(
    (entry): entry is DockerImage =>
      typeof entry === 'object' &&
      entry !== null &&
      typeof (entry as DockerImage).name === 'string' &&
      typeof (entry as DockerImage).image === 'string',
  );
}
