import {
  readinessSchema,
  serverConfigurationSchema,
  stopConfigurationSchema,
  type ConfigFile,
  type Readiness,
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
      throw new Error(`Server ${serverUuid} has no primary allocation: it cannot be started.`);
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
        // No `role` here even when the row carries one: the primary port is
        // named by being the primary, and the contract gives it no field to
        // hold a second name in. `AllocationsService` refuses to create the
        // situation in the first place.
        default: {
          ip: server.primaryAllocation.ip,
          port: server.primaryAllocation.port,
        },
        // The primary allocation also appears in `allocations`: it is dropped
        // so the same port is not published twice.
        additional: server.allocations
          .filter((allocation) => allocation.id !== server.primaryAllocationId)
          .map((allocation) => ({
            ip: allocation.ip,
            port: allocation.port,
            // Spread rather than `role: allocation.role ?? undefined`, so that
            // an unnamed port produces no key at all. The payload a server
            // with no named port sends has to be the one it has always sent,
            // down to the byte: a key holding `undefined` survives the parse
            // as a key, and anything comparing payloads to decide whether a
            // node needs resyncing would see every server on every node change
            // the day this shipped.
            ...(allocation.role ? { role: allocation.role } : {}),
          })),
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

      stop: parseStop(server.template.stop, server.template.stopCommand, server.uuid),
      // Absent means "this template said nothing", which the contract turns
      // into its own 30 — the figure every server has run on since the first
      // release, because until now no template could name another.
      stopTimeoutSeconds: server.template.stopTimeoutSeconds ?? undefined,
      startupDetection: server.template.startupDetection ?? undefined,
      // Both are sent, and the daemon prefers `readiness` when it is there.
      // `startupDetection` keeps travelling regardless: it is what the entire
      // shipped catalogue declares, and a node still running an older daemon
      // reads nothing else.
      readiness: parseReadiness(server.template.readiness, server.uuid, this.logger),
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
 * Decodes how a template says its servers are stopped.
 *
 * Two shapes, in order. The structured `stop` column wins when it is there; the
 * colon-encoded string is what the whole bundled catalogue, every imported
 * Pterodactyl egg and every row written before that column carry, and it goes
 * on being read exactly as it always was.
 *
 * **An unreadable structured stop refuses**, where the string below falls back
 * to SIGTERM. That asymmetry is deliberate and it is the point of this
 * function. The fallback down there is defensible for what it was written for:
 * a Bukkit server takes SIGTERM well, and a less graceful stop beat a server
 * nobody could launch. It is indefensible here. A template only fills this
 * column when the string could not express its stop, and the reason it could
 * not is almost always that the game answers on RCON and reads no standard
 * input — which is another way of saying its save is written on shutdown and
 * nowhere else. Inheriting the fallback would take the one template that
 * declared it needs a real shutdown and give it the signal-then-SIGKILL it was
 * declared to avoid, on every stop, with nothing anywhere saying so.
 *
 * So the server is refused instead, and refused where somebody is looking: this
 * runs on creation, on every configuration push and on a node's reconciliation,
 * and the last of those logs it with the server's uuid. A refused server is not
 * destroyed and its container is not touched — the daemon reports a server it
 * has that the panel did not describe, and never deletes one.
 *
 * The only way to reach that refusal is a hand-edited row or a dump restored
 * from a Hopper that spelled this differently: everything writing the column
 * validates first.
 */
export function parseStop(
  raw: unknown,
  stopCommand: string,
  serverUuid: string,
): StopConfiguration {
  if (raw === null || raw === undefined) {
    return parseStopCommand(stopCommand);
  }

  const result = stopConfigurationSchema.safeParse(raw);

  if (!result.success) {
    const issues = result.error.issues
      .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('; ');

    throw new Error(
      `Server ${serverUuid} has a template whose stop configuration cannot be read (${issues}). ` +
        'It is refused rather than stopped some other way: a template only sets this field ' +
        'because the plain stop command could not express its shutdown, and guessing here ' +
        'ends in a SIGKILL through whatever the game writes on exit. Fix the template, or ' +
        'clear the field to fall back to its stop command.',
    );
  }

  return result.data;
}

/**
 * Decodes a template's stop command, stored as `command:stop` or
 * `signal:SIGTERM`.
 *
 * An unknown value falls back to `SIGTERM` rather than failing the start: a
 * less graceful stop beats a server that cannot be launched at all.
 *
 * Left exactly as it was, fallback included. Every server in existence goes
 * through here, and the fallback is load-bearing for the ones that arrived
 * through an egg import: tightening it now would turn servers that start today
 * into servers that refuse to, over a value nobody has looked at in months. The
 * new path above is the one that refuses.
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
 * Decodes a template's readiness strategy.
 *
 * Stored as free-form JSON, because no column can hold a discriminated union,
 * so nothing guarantees the shape until it is read back. It is validated here
 * rather than left to the `serverConfigurationSchema.parse` that closes
 * `build`: that one rejects the whole object, and an unreadable strategy would
 * then make a server impossible to start that started perfectly well the day
 * before anything was written to this column.
 *
 * A value that does not parse is dropped and reported at error level — louder
 * than its neighbour below, because the consequence is worse than one ignored
 * configuration file. The daemon falls back to `startupDetection`, and a
 * template that chose a strategy in the first place did so because no console
 * line announces it, so there is nothing to fall back to: the server is called
 * running the moment its container is up. That is exactly the silent guess
 * this column exists to replace, and this log line is all an operator gets to
 * tell it apart from a server that really did start.
 */
export function parseReadiness(
  raw: unknown,
  serverUuid: string,
  logger: Logger,
): Readiness | undefined {
  // Declaring nothing is the ordinary case, not a failure: the whole bundled
  // catalogue still announces itself through `startupDetection` alone.
  if (raw === null || raw === undefined) {
    return undefined;
  }

  const result = readinessSchema.safeParse(raw);

  if (!result.success) {
    const issues = result.error.issues
      .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('; ');

    logger.error(
      `Readiness strategy ignored for server ${serverUuid} (${issues}). ` +
        'The daemon falls back to startupDetection, and to calling the server ' +
        'running as soon as its container is up if there is none.',
    );

    return undefined;
  }

  return result.data;
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
      logger.warn(`Configuration file ignored for server ${serverUuid}: invalid entry.`);
      continue;
    }

    parsed.push(candidate as ConfigFile);
  }

  return parsed;
}
