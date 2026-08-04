import {
  serverConfigurationSchema,
  type ConfigFile,
  type ServerConfiguration,
  type StopConfiguration,
} from '@hopper/shared';
import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service.js';

/**
 * Translates a server from the database into the shared contract.
 *
 * This is the only boundary between the panel's data model and what the daemon
 * understands. The daemon never touches the database: everything it needs to
 * start, stop, watch or reinstall a server has to travel through this object.
 *
 * The output is validated by the Zod schema before being sent. An
 * inconsistency — an empty Docker image, an out-of-range port — has to fail
 * here, on the side that knows what to say about it, rather than reach the
 * daemon as a container that cannot be created.
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
        `Server ${serverUuid} has no primary allocation: it cannot be started.`,
      );
    }

    const environment = Object.fromEntries(
      server.variables.map((variable) => [variable.envVariable, variable.value]),
    );

    const configuration = {
      uuid: server.uuid,
      meta: { name: server.name, description: server.description },
      // A suspended server is still described to the daemon: it has to know it
      // exists in order to refuse the start and cut its SFTP access.
      suspended: server.status === 'SUSPENDED',
      invocation: server.startupCommand,
      environment,

      allocations: {
        default: {
          ip: server.primaryAllocation.ip,
          port: server.primaryAllocation.port,
        },
        // The primary allocation also appears in `allocations`: it is dropped
        // so the same port is not published twice.
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

  /** Builds the configuration of every server on a node. */
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
        // A malformed server must not prevent the others from being
        // reconciled: the daemon would then come back with no servers at all.
        this.logger.error(
          `Could not build the configuration for server ${server.uuid}: ${String(error)}`,
        );
      }
    }

    return configurations;
  }
}

/**
 * Decodes a template's stop command, stored as `command:stop` or
 * `signal:SIGTERM`.
 *
 * An unknown value falls back to `SIGTERM` rather than failing the start: a
 * less graceful stop beats a server that cannot be launched at all.
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
 * Decodes a template's configuration files.
 *
 * They are stored as free-form JSON: a template imported from a malformed
 * Pterodactyl egg must not make the server impossible to start. An invalid
 * entry is dropped and reported.
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
        `Configuration file ignored for server ${serverUuid}: invalid entry.`,
      );
      continue;
    }

    parsed.push(candidate as ConfigFile);
  }

  return parsed;
}
