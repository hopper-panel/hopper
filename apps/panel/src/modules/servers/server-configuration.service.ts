import {
  serverConfigurationSchema,
  type ConfigFile,
  type ServerConfiguration,
  type StopConfiguration,
} from '@hopper/shared';
import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service.js';

/**
 * Traduit un serveur de la base vers le contrat partagé.
 *
 * C'est la seule frontière entre le modèle de données du panel et ce que le
 * daemon comprend. Le daemon n'accède jamais à la base : tout ce dont il a
 * besoin pour démarrer, arrêter, surveiller ou réinstaller un serveur doit
 * transiter par cet objet.
 *
 * La sortie est validée par le schéma Zod avant d'être envoyée. Une
 * incohérence — une image Docker vide, un port hors plage — doit échouer ici,
 * du côté qui sait quoi en dire, plutôt que d'arriver au daemon sous forme de
 * conteneur impossible à créer.
 */
@Injectable()
export class ServerConfigurationService {
  private readonly logger = new Logger(ServerConfigurationService.name);

  constructor(private readonly prisma: PrismaService) {}

  async build(serverUuid: string): Promise<ServerConfiguration> {
    const server = await this.prisma.server.findUniqueOrThrow({
      where: { uuid: serverUuid },
      include: {
        template: true,
        variables: true,
        primaryAllocation: true,
        allocations: true,
      },
    });

    if (!server.primaryAllocation) {
      throw new Error(
        `Le serveur ${serverUuid} n'a pas d'allocation principale : il ne peut pas être démarré.`,
      );
    }

    const environment = Object.fromEntries(
      server.variables.map((variable) => [variable.envVariable, variable.value]),
    );

    const configuration = {
      uuid: server.uuid,
      meta: { name: server.name, description: server.description },
      // Un serveur suspendu reste décrit au daemon : il doit connaître son
      // existence pour refuser de le démarrer et pour couper son accès SFTP.
      suspended: server.status === 'SUSPENDED',
      invocation: server.startupCommand,
      environment,

      allocations: {
        default: {
          ip: server.primaryAllocation.ip,
          port: server.primaryAllocation.port,
        },
        // L'allocation principale figure aussi dans `allocations` : on l'écarte
        // pour ne pas publier deux fois le même port.
        additional: server.allocations
          .filter((allocation) => allocation.id !== server.primaryAllocationId)
          .map((allocation) => ({ ip: allocation.ip, port: allocation.port })),
      },

      build: {
        memoryBytes: Number(server.memoryBytes),
        swapBytes: Number(server.swapBytes),
        cpuPercent: server.cpuPercent,
        cpuSet: server.cpuSet,
        ioWeight: server.ioWeight,
        diskBytes: Number(server.diskBytes),
        pidsLimit: server.pidsLimit,
        oomKillDisabled: server.oomKillDisabled,
      },

      container: {
        image: server.dockerImage,
        requiresRebuild: server.requiresRebuild,
      },

      stop: parseStopCommand(server.template.stopCommand),
      startupDetection: server.template.startupDetection ?? undefined,
      configFiles: parseConfigFiles(server.template.configFiles, server.uuid, this.logger),
      fileDenylist: server.template.fileDenylist,

      install: {
        containerImage: server.template.installContainer,
        entrypoint: server.template.installEntrypoint,
        script: server.template.installScript,
      },
    };

    return serverConfigurationSchema.parse(configuration);
  }

  /** Construit la configuration de tous les serveurs d'un node. */
  async buildForNode(nodeId: number): Promise<ServerConfiguration[]> {
    const servers = await this.prisma.server.findMany({
      where: { nodeId },
      select: { uuid: true },
      orderBy: { id: 'asc' },
    });

    const configurations: ServerConfiguration[] = [];

    for (const server of servers) {
      try {
        configurations.push(await this.build(server.uuid));
      } catch (error: unknown) {
        // Un serveur mal formé ne doit pas empêcher les autres d'être
        // réconciliés : le daemon repartirait alors sans aucun serveur.
        this.logger.error(
          `Configuration impossible pour le serveur ${server.uuid} : ${String(error)}`,
        );
      }
    }

    return configurations;
  }
}

/**
 * Décode la commande d'arrêt d'un template, stockée sous forme
 * `command:stop` ou `signal:SIGTERM`.
 *
 * Une valeur inconnue retombe sur `SIGTERM` plutôt que de faire échouer le
 * démarrage : mieux vaut un arrêt moins gracieux qu'un serveur qu'on ne peut
 * plus lancer du tout.
 */
export function parseStopCommand(raw: string): StopConfiguration {
  const separator = raw.indexOf(':');
  const type = separator === -1 ? '' : raw.slice(0, separator);
  const value = separator === -1 ? raw : raw.slice(separator + 1);

  if (type === 'command' && value.length > 0) {
    return { type: 'command', value };
  }

  if (type === 'signal' && (value === 'SIGTERM' || value === 'SIGINT' || value === 'SIGKILL')) {
    return { type: 'signal', value };
  }

  return { type: 'signal', value: 'SIGTERM' };
}

/**
 * Décode les fichiers de configuration d'un template.
 *
 * Ils sont stockés en JSON libre : un template importé depuis un « egg »
 * Pterodactyl mal formé ne doit pas rendre le serveur impossible à démarrer.
 * Une entrée invalide est écartée et signalée.
 */
function parseConfigFiles(raw: unknown, serverUuid: string, logger: Logger): ConfigFile[] {
  if (!Array.isArray(raw)) {
    return [];
  }

  const parsed: ConfigFile[] = [];

  for (const entry of raw) {
    const candidate = entry as Partial<ConfigFile>;

    if (
      typeof candidate?.file !== 'string' ||
      typeof candidate.parser !== 'string' ||
      !Array.isArray(candidate.replacements)
    ) {
      logger.warn(
        `Fichier de configuration ignoré pour le serveur ${serverUuid} : entrée invalide.`,
      );
      continue;
    }

    parsed.push(candidate as ConfigFile);
  }

  return parsed;
}
