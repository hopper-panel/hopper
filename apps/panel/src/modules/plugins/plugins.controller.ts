import { DAEMON_FILE_ROUTES, PERMISSIONS } from '@hopper/shared';
import { BadRequestException, Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { AuditService, AUDIT_EVENTS } from '../audit/audit.service.js';
import { RequireServerPermission } from '../auth/decorators.js';
import {
  CurrentServer,
  CurrentUser,
  type RequestServer,
  type RequestUser,
} from '../auth/request-user.js';
import { NodeClientService } from '../nodes/node-client.service.js';
import { NodesService } from '../nodes/nodes.service.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { ModrinthService, type PluginSearchPage, type PluginVersion } from './modrinth.service.js';

/**
 * What a template can load, by its key.
 *
 * `vanilla` is absent on purpose, and that absence is the feature: a vanilla
 * server reads neither `plugins/` nor `mods/`. Without this the panel happily
 * installed a Fabric mod onto one — the file landed in the right folder for
 * Fabric, on a server with no loader to read it, and nothing anywhere said so.
 */
const LOADER_FOR_TEMPLATE: Record<string, string> = {
  paper: 'paper',
  purpur: 'purpur',
  fabric: 'fabric',
  neoforge: 'neoforge',
  velocity: 'velocity',
  bungeecord: 'bungeecord',
};

/** Where a loader expects its additions to live. */
const DIRECTORY_FOR_LOADER: Record<string, string> = {
  paper: 'plugins',
  purpur: 'plugins',
  spigot: 'plugins',
  bukkit: 'plugins',
  bungeecord: 'plugins',
  velocity: 'plugins',
  waterfall: 'plugins',
  fabric: 'mods',
  forge: 'mods',
  neoforge: 'mods',
  quilt: 'mods',
};

/**
 * Installing from the catalogue.
 *
 * The panel resolves a version into a file, and the daemon downloads it. The
 * file never crosses the panel: a modpack of several hundred megabytes would
 * otherwise pass through it in full, for every user installing one at once, and
 * the panel has no business holding a server's files even briefly.
 *
 * Which also means the URL the daemon receives comes from a request. The daemon
 * refuses any host outside its own list rather than trust this — see its fetch
 * route.
 */
@Controller('api/servers/:serverId/plugins')
export class PluginsController {
  constructor(
    private readonly modrinth: ModrinthService,
    private readonly prisma: PrismaService,
    private readonly nodes: NodesService,
    private readonly client: NodeClientService,
    private readonly audit: AuditService,
  ) {}

  @Get('search')
  @RequireServerPermission(PERMISSIONS.FILE_READ)
  async search(
    @CurrentServer() server: RequestServer,
    @Query('query') query?: string,
    @Query('gameVersion') gameVersion?: string,
    @Query('page') page?: string,
  ): Promise<PluginSearchPage> {
    // The loader is the server's, never the caller's. Searching without it
    // returns whatever the catalogue ranks highest — which is how a Fabric mod
    // ends up offered for a Paper server, installed into the folder that is
    // right for Fabric, and never loaded.
    const loader = await this.loaderFor(server);

    // A page that does not parse is page one, not an error: the number comes
    // from a link, and an operator who lands on a broken one wants the
    // catalogue rather than a stack trace.
    const requested = Number.parseInt(page ?? '1', 10);

    return this.modrinth.search(
      query ?? '',
      loader,
      gameVersion,
      Number.isFinite(requested) && requested > 0 ? requested : 1,
    );
  }

  @Get(':projectId/versions')
  @RequireServerPermission(PERMISSIONS.FILE_READ)
  async versions(
    @Param('projectId') projectId: string,
    @CurrentServer() server: RequestServer,
    @Query('gameVersion') gameVersion?: string,
  ): Promise<PluginVersion[]> {
    return this.modrinth.versions(projectId, await this.loaderFor(server), gameVersion);
  }

  /**
   * Installs one version into the server.
   *
   * `file.create` rather than a permission of its own: this writes a file into
   * the volume, which is exactly what the file manager's upload does. A
   * separate permission would let someone hold one and not the other, for no
   * difference an operator could act on.
   */
  @Post('install')
  @RequireServerPermission(PERMISSIONS.FILE_CREATE)
  async install(
    @Param('serverId') serverId: string,
    @Body() body: { versionId?: string },
    @CurrentServer() server: RequestServer,
    @CurrentUser() user: RequestUser,
  ): Promise<unknown> {
    if (!body.versionId) {
      throw new BadRequestException('A version to install is required.');
    }

    const loader = await this.loaderFor(server);
    const version = await this.modrinth.version(body.versionId);

    // Checked again at install: the search is filtered, but the version id
    // arrives in a request and a filtered list is not a guarantee.
    if (!version.loaders.some((candidate) => candidate.toLowerCase() === loader)) {
      throw new BadRequestException(
        `This version targets ${version.loaders.join(', ')}, and this server runs ${loader}. It would be installed and never loaded.`,
      );
    }

    const directory = this.directoryFor(version.loaders);

    const node = await this.prisma.node.findUniqueOrThrow({
      where: { id: server.nodeId },
      select: { uuid: true },
    });

    const connection = await this.nodes.getConnection(node.uuid);
    const response = await this.client.proxy(connection, DAEMON_FILE_ROUTES.fetch(serverId), {
      method: 'POST',
      body: {
        url: version.file.url,
        directory,
        name: version.file.filename,
        // Passed on when the catalogue published one. The daemon verifies it
        // and removes the file when it does not match — a project whose files
        // were replaced upstream should not install silently.
        ...(version.file.sha512 ? { sha512: version.file.sha512 } : {}),
      },
      timeoutMs: 300_000,
    });

    if (response.status >= 400) {
      // Relayed rather than flattened: the daemon says whether it was the disk
      // limit, a refused host or a checksum, and each sends the operator
      // somewhere different.
      throw new BadRequestException(response.body.toString('utf8'));
    }

    await this.audit.record({
      actorId: user.id,
      serverId: server.id,
      event: AUDIT_EVENTS.SERVER_UPDATED,
      metadata: {
        action: 'plugin.install',
        file: `${directory}/${version.file.filename}`,
        version: version.versionNumber,
      },
    });

    return { installed: `${directory}/${version.file.filename}` };
  }

  /**
   * What this server can load, from its template.
   *
   * A template with no loader — vanilla — is refused outright rather than
   * offered a catalogue it cannot use. Saying so beats installing a file that
   * disappears into a folder nothing reads.
   */
  private async loaderFor(server: RequestServer): Promise<string> {
    const record = await this.prisma.server.findUniqueOrThrow({
      where: { id: server.id },
      select: { template: { select: { key: true, name: true } } },
    });

    const loader = LOADER_FOR_TEMPLATE[record.template.key];

    if (!loader) {
      throw new BadRequestException(
        `${record.template.name} loads neither plugins nor mods. Recreate the server on Paper, Purpur, Fabric or NeoForge to install any.`,
      );
    }

    return loader;
  }

  /**
   * Where the file goes.
   *
   * Decided from the version's own loaders rather than asked of the caller: a
   * plugin dropped in `mods/` on a Paper server is not loaded and says nothing
   * about why, which is a support ticket rather than an error.
   */
  private directoryFor(loaders: string[]): string {
    for (const loader of loaders) {
      const directory = DIRECTORY_FOR_LOADER[loader.toLowerCase()];

      if (directory) {
        return directory;
      }
    }

    throw new BadRequestException(
      `This version targets ${loaders.join(', ') || 'no known loader'}, which Hopper does not know where to install.`,
    );
  }
}
