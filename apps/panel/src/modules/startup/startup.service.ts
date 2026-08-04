import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service.js';
import { NodeClientService } from '../nodes/node-client.service.js';
import { NodesService } from '../nodes/nodes.service.js';
import { ServerConfigurationService } from '../servers/server-configuration.service.js';
import { validateValue } from './variable-rules.js';

/**
 * A server's startup settings.
 *
 * Three things decide what runs inside the container: the launch command, the
 * Docker image, and the template's variables. The last two are editable here;
 * the command belongs to the template and is only displayed — letting a
 * server's user edit it would amount to handing them the choice of binary.
 *
 * Two filters, not one:
 *
 *  - `userViewable` decides what is **returned**; a hidden variable often holds
 *    a secret and must appear in no response;
 *  - `userEditable` decides what is **accepted** on write. A non-editable
 *    variable that is submitted is refused rather than ignored: ignoring it
 *    would suggest the change had been taken into account.
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

    // Keyed by environment variable name, not by template variable id: that is
    // how the value is stored, so that a template edited afterwards does not
    // break the existing servers.
    const byEnv = new Map(values.map((value) => [value.envVariable, value.value]));

    return {
      /** The template's own line, variables unsubstituted: this is what will run. */
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

    // The image has to come from the template. Without this check, a free-form
    // value would run any image from the registry — so any program — in a
    // container mounted on the server's volume.
    const proposed = readImages(server.template.dockerImages);

    if (!proposed.some((candidate) => candidate.image === image)) {
      throw new BadRequestException("This image is not offered by the server's template.");
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
        errors.push(`${envVariable}: unknown variable for this template.`);
        continue;
      }

      // An explicit refusal rather than a silent omission: a hidden or locked
      // variable that is submitted is either an interface bug or an attempt —
      // in both cases, saying so beats ignoring it.
      if (!variable.userEditable || !variable.userViewable) {
        errors.push(`${variable.name}: this variable is not editable.`);
        continue;
      }

      const violations = validateValue(value, variable.rules);

      if (violations.length > 0) {
        errors.push(`${variable.name}: ${violations.map((one) => one.message).join(' ')}`);
      }
    }

    if (errors.length > 0) {
      throw new BadRequestException(errors.join('\n'));
    }

    // Writing only once **everything** has been validated: a half-applied form
    // would leave a server in a state nobody asked for.
    for (const [envVariable, value] of Object.entries(submitted)) {
      await this.prisma.serverVariable.upsert({
        where: { serverId_envVariable: { serverId, envVariable } },
        create: { serverId, envVariable, value },
        update: { value },
      });
    }
  }

  /**
   * Sends the configuration back to the daemon.
   *
   * A failure does not undo the change: it is in the database, and the daemon's
   * reconciliation will catch up. Refusing it because the node is momentarily
   * unreachable would leave the panel and the machine out of tune.
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
        `Could not sync server ${serverUuid}; it will be caught up the next time ` +
          `the daemon starts: ${String(error)}`,
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
 * Reads the template's image list.
 *
 * Stored as JSON: its shape is not guaranteed by the database, and a template
 * imported from a malformed egg must not break the rendering of the page.
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
