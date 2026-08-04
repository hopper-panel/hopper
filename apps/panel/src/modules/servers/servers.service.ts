import { PERMISSIONS, type PowerAction } from '@hopper/shared';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import {
  paginate,
  skipFor,
  type Paginated,
  type PaginationQuery,
} from '../../common/pagination.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { AUDIT_EVENTS, AuditService } from '../audit/audit.service.js';
import type { RequestContext } from '../auth/auth.service.js';
import { NodeClientService } from '../nodes/node-client.service.js';
import { NodesService } from '../nodes/nodes.service.js';
import { checkCapacity } from './capacity.js';
import { ServerConfigurationService } from './server-configuration.service.js';
import type { CreateServerDto, UpdateServerBuildDto, UpdateServerDto } from './servers.dto.js';

export interface ServerListItem {
  uuid: string;
  name: string;
  description: string;
  status: string;
  memoryBytes: bigint;
  diskBytes: bigint;
  cpuPercent: number;
  node: { uuid: string; name: string; fqdn: string };
  template: { uuid: string; name: string };
  primaryAllocation: { ip: string; port: number; alias: string | null } | null;
  isOwner: boolean;
  createdAt: Date;
}

/**
 * Extrait les images d'un template, dans leur ordre de déclaration.
 *
 * Tolère l'ancien format objet `{ "Java 21": "…" }` : un template importé
 * avant le changement de format ne doit pas rendre ses serveurs impossibles à
 * créer. L'ordre y est en revanche celui que `jsonb` a bien voulu conserver.
 */
export function parseDockerImages(raw: Prisma.JsonValue): string[] {
  if (Array.isArray(raw)) {
    return raw
      .map((entry) => (entry as { image?: unknown })?.image)
      .filter((image): image is string => typeof image === 'string' && image.length > 0);
  }

  if (raw && typeof raw === 'object') {
    return Object.values(raw).filter(
      (image): image is string => typeof image === 'string' && image.length > 0,
    );
  }

  return [];
}

@Injectable()
export class ServersService {
  private readonly logger = new Logger(ServersService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly configurations: ServerConfigurationService,
    private readonly nodes: NodesService,
    private readonly client: NodeClientService,
  ) {}

  /**
   * Serveurs visibles par un utilisateur.
   *
   * Un administrateur ne voit *pas* tous les serveurs ici : cette liste est
   * celle de son espace personnel. La vue exhaustive est une route
   * d'administration distincte, pour que « mes serveurs » reste lisible sur une
   * instance qui en héberge deux cents.
   */
  async listForUser(userId: number, query: PaginationQuery): Promise<Paginated<ServerListItem>> {
    const where: Prisma.ServerWhereInput = {
      AND: [
        { OR: [{ ownerId: userId }, { subusers: { some: { userId } } }] },
        searchClause(query.search),
      ],
    };

    return this.queryServers(where, query, userId);
  }

  /** Vue exhaustive, réservée aux administrateurs. */
  async listAll(query: PaginationQuery, viewerId: number): Promise<Paginated<ServerListItem>> {
    return this.queryServers(searchClause(query.search), query, viewerId);
  }

  async findByUuid(uuid: string, viewerId: number): Promise<ServerListItem> {
    const server = await this.prisma.server.findUnique({
      where: { uuid },
      include: this.listInclude(),
    });

    if (!server) {
      throw new NotFoundException('Serveur introuvable.');
    }

    return this.toListItem(server, viewerId);
  }

  // -------------------------------------------------------------------------
  // Création
  // -------------------------------------------------------------------------

  /**
   * Crée l'enregistrement d'un serveur.
   *
   * À ce stade, rien n'est demandé au daemon : le serveur reste `INSTALLING`
   * jusqu'à ce que le runtime Docker prenne le relais (phase 2). La séparation
   * est volontaire — la validation métier et la comptabilité des ressources
   * doivent être correctes avant qu'un conteneur n'existe.
   */
  async create(
    dto: CreateServerDto,
    actorId: number,
    context: RequestContext,
  ): Promise<ServerListItem> {
    const [owner, node, template] = await Promise.all([
      this.prisma.user.findUnique({ where: { uuid: dto.ownerUuid }, select: { id: true } }),
      this.prisma.node.findUnique({ where: { uuid: dto.nodeUuid } }),
      this.prisma.template.findUnique({
        where: { uuid: dto.templateUuid },
        include: { variables: true },
      }),
    ]);

    if (!owner) throw new BadRequestException('Propriétaire introuvable.');
    if (!node) throw new BadRequestException('Node introuvable.');
    if (!template) throw new BadRequestException('Template introuvable.');

    if (node.maintenance) {
      throw new ConflictException(
        'Ce node est en maintenance : aucun nouveau serveur ne peut y être créé.',
      );
    }

    const allocation = await this.prisma.allocation.findFirst({
      where: { id: dto.allocationId, nodeId: node.id },
    });

    if (!allocation) {
      throw new BadRequestException("Cette allocation n'existe pas sur ce node.");
    }

    if (allocation.serverId !== null) {
      throw new ConflictException(`Le port ${allocation.port} est déjà attribué à un serveur.`);
    }

    await this.assertNodeHasCapacity(node, BigInt(dto.memoryBytes), BigInt(dto.diskBytes));

    const dockerImage = this.resolveDockerImage(template.dockerImages, dto.dockerImage);
    const variables = this.resolveVariables(template.variables, dto.variables);

    const server = await this.prisma.$transaction(async (tx) => {
      const created = await tx.server.create({
        data: {
          name: dto.name,
          description: dto.description,
          ownerId: owner.id,
          nodeId: node.id,
          templateId: template.id,
          status: 'INSTALLING',
          memoryBytes: BigInt(dto.memoryBytes),
          diskBytes: BigInt(dto.diskBytes),
          swapBytes: BigInt(dto.swapBytes),
          cpuPercent: dto.cpuPercent,
          cpuSet: dto.cpuSet,
          ioWeight: dto.ioWeight,
          pidsLimit: dto.pidsLimit,
          oomKillDisabled: dto.oomKillDisabled,
          backupLimit: dto.backupLimit,
          allocationLimit: dto.allocationLimit,
          databaseLimit: dto.databaseLimit,
          dockerImage,
          // Copié depuis le template : modifier le template plus tard ne doit
          // pas changer la commande de démarrage d'un serveur existant sans
          // que personne ne l'ait demandé.
          startupCommand: template.startup,
          primaryAllocationId: allocation.id,
          variables: {
            create: Object.entries(variables).map(([envVariable, value]) => ({
              envVariable,
              value,
            })),
          },
        },
      });

      // Le port doit pointer vers le serveur des deux côtés : `primaryAllocationId`
      // pour le port principal, `serverId` pour qu'il apparaisse comme occupé.
      await tx.allocation.update({
        where: { id: allocation.id },
        data: { serverId: created.id },
      });

      return created;
    });

    // Le daemon est prévenu après la transaction : il ne doit pas y avoir de
    // conteneur pour un serveur qui n'existe pas en base.
    try {
      const configuration = await this.configurations.build(server.uuid);
      const connection = await this.nodes.getConnection(node.uuid);

      await this.client.createServer(connection, configuration, dto.startOnCompletion);
    } catch (error: unknown) {
      // La création est atomique du point de vue de l'utilisateur : un node
      // injoignable ne doit pas laisser un serveur fantôme en base, avec son
      // port immobilisé et aucun conteneur derrière.
      this.logger.error(
        `Création refusée par le node ${node.name}, retrait de ${server.uuid} : ${String(error)}`,
      );
      await this.prisma.server.delete({ where: { id: server.id } }).catch(() => undefined);
      throw error;
    }

    await this.audit.record({
      event: AUDIT_EVENTS.SERVER_CREATED,
      actorId,
      serverId: server.id,
      ip: context.ip,
      userAgent: context.userAgent,
      metadata: { name: server.name, node: node.name, template: template.name },
    });

    return this.findByUuid(server.uuid, actorId);
  }

  /**
   * Renvoie au daemon la configuration à jour d'un serveur.
   *
   * Tolérante à l'échec : un node hors ligne ne doit pas empêcher de renommer
   * un serveur ou d'ajuster ses limites dans le panel. La réconciliation au
   * démarrage du daemon rattrapera l'écart.
   */
  private async pushConfiguration(serverUuid: string, nodeUuid: string): Promise<void> {
    try {
      const configuration = await this.configurations.build(serverUuid);
      const connection = await this.nodes.getConnection(nodeUuid);

      await this.client.syncServer(connection, configuration);
    } catch (error: unknown) {
      this.logger.warn(
        `Synchronisation du serveur ${serverUuid} impossible, elle sera rattrapée au prochain démarrage du daemon : ${String(error)}`,
      );
    }
  }

  /**
   * Applique une action de puissance via le daemon.
   *
   * La permission requise dépend de l'action, et `kill` relève de l'arrêt : un
   * sous-utilisateur autorisé à arrêter un serveur peut le tuer, mais celui qui
   * ne peut que le démarrer ne le peut pas. Confondre les deux donnerait à un
   * modérateur le pouvoir de couper le serveur en pleine écriture du monde.
   */
  async power(
    uuid: string,
    action: PowerAction,
    server: { id: number; nodeId: number; permissions: string[]; isOwner: boolean },
    actorId: number,
    context: RequestContext,
  ): Promise<void> {
    const required = POWER_PERMISSIONS[action];

    if (!server.isOwner && !server.permissions.includes(required)) {
      throw new ForbiddenException(`Permission « ${required} » requise pour cette action.`);
    }

    const record = await this.prisma.server.findUniqueOrThrow({
      where: { uuid },
      include: { node: { select: { uuid: true } } },
    });

    // Un serveur suspendu, en cours d'installation ou de suppression n'a pas de
    // conteneur exploitable : le démarrer produirait une erreur du daemon bien
    // moins parlante que ce refus.
    if (record.status !== 'READY') {
      throw new ConflictException(
        `Ce serveur n'est pas disponible (état : ${record.status.toLowerCase()}).`,
      );
    }

    const connection = await this.nodes.getConnection(record.node.uuid);
    await this.client.powerServer(connection, uuid, action);

    await this.audit.record({
      event: AUDIT_EVENTS.SERVER_POWER,
      actorId,
      serverId: record.id,
      ip: context.ip,
      userAgent: context.userAgent,
      metadata: { action },
    });
  }

  async update(
    uuid: string,
    dto: UpdateServerDto,
    actorId: number,
    context: RequestContext,
  ): Promise<ServerListItem> {
    const server = await this.prisma.server.findUnique({
      where: { uuid },
      select: { id: true, node: { select: { uuid: true } } },
    });

    if (!server) {
      throw new NotFoundException('Serveur introuvable.');
    }

    await this.prisma.server.update({
      where: { id: server.id },
      data: { name: dto.name, description: dto.description },
    });

    await this.pushConfiguration(uuid, server.node.uuid);

    await this.audit.record({
      event: AUDIT_EVENTS.SERVER_UPDATED,
      actorId,
      serverId: server.id,
      ip: context.ip,
      userAgent: context.userAgent,
      metadata: { changed: Object.keys(dto) },
    });

    return this.findByUuid(uuid, actorId);
  }

  /**
   * Modifie les limites de ressources.
   *
   * `requiresRebuild` est positionné : les limites d'un conteneur Docker ne se
   * changent pas à chaud de façon fiable. Le daemon recréera le conteneur au
   * prochain démarrage, sans toucher au volume de données.
   */
  async updateBuild(
    uuid: string,
    dto: UpdateServerBuildDto,
    actorId: number,
    context: RequestContext,
  ): Promise<ServerListItem> {
    const server = await this.prisma.server.findUnique({
      where: { uuid },
      include: { node: true },
    });

    if (!server) {
      throw new NotFoundException('Serveur introuvable.');
    }

    if (dto.memoryBytes !== undefined || dto.diskBytes !== undefined) {
      await this.assertNodeHasCapacity(
        server.node,
        BigInt(dto.memoryBytes ?? server.memoryBytes),
        BigInt(dto.diskBytes ?? server.diskBytes),
        server.id,
      );
    }

    await this.prisma.server.update({
      where: { id: server.id },
      data: {
        memoryBytes: dto.memoryBytes === undefined ? undefined : BigInt(dto.memoryBytes),
        diskBytes: dto.diskBytes === undefined ? undefined : BigInt(dto.diskBytes),
        swapBytes: dto.swapBytes === undefined ? undefined : BigInt(dto.swapBytes),
        cpuPercent: dto.cpuPercent,
        cpuSet: dto.cpuSet,
        ioWeight: dto.ioWeight,
        pidsLimit: dto.pidsLimit,
        oomKillDisabled: dto.oomKillDisabled,
        backupLimit: dto.backupLimit,
        allocationLimit: dto.allocationLimit,
        databaseLimit: dto.databaseLimit,
        requiresRebuild: true,
      },
    });

    await this.audit.record({
      event: AUDIT_EVENTS.SERVER_UPDATED,
      actorId,
      serverId: server.id,
      ip: context.ip,
      userAgent: context.userAgent,
      metadata: { changed: Object.keys(dto), requiresRebuild: true },
    });

    return this.findByUuid(uuid, actorId);
  }

  async setSuspended(
    uuid: string,
    suspended: boolean,
    actorId: number,
    context: RequestContext,
  ): Promise<ServerListItem> {
    const server = await this.prisma.server.findUnique({
      where: { uuid },
      select: { id: true, node: { select: { uuid: true } } },
    });

    if (!server) {
      throw new NotFoundException('Serveur introuvable.');
    }

    await this.prisma.server.update({
      where: { id: server.id },
      data: { status: suspended ? 'SUSPENDED' : 'READY' },
    });

    // Le daemon doit apprendre la suspension : c'est lui qui refuse le
    // démarrage et coupe l'accès SFTP.
    await this.pushConfiguration(uuid, server.node.uuid);

    await this.audit.record({
      event: suspended ? AUDIT_EVENTS.SERVER_SUSPENDED : AUDIT_EVENTS.SERVER_UNSUSPENDED,
      actorId,
      serverId: server.id,
      ip: context.ip,
      userAgent: context.userAgent,
    });

    return this.findByUuid(uuid, actorId);
  }

  async remove(uuid: string, actorId: number, context: RequestContext): Promise<void> {
    const server = await this.prisma.server.findUnique({
      where: { uuid },
      select: { id: true, name: true, node: { select: { uuid: true } } },
    });

    if (!server) {
      throw new NotFoundException('Serveur introuvable.');
    }

    // Le conteneur et le volume partent d'abord : supprimer la ligne en base
    // avant laisserait un conteneur que plus rien ne référence, et dont
    // personne ne saurait à qui il appartenait.
    try {
      const connection = await this.nodes.getConnection(server.node.uuid);
      await this.client.deleteServer(connection, uuid, true);
    } catch (error: unknown) {
      this.logger.error(`Suppression refusée par le node pour ${uuid} : ${String(error)}`);
      throw error;
    }

    // L'entrée d'audit est écrite AVANT la suppression, et sans `serverId` :
    // la cascade effacerait sinon la trace de l'action au moment même où elle
    // devient la plus utile.
    await this.audit.record({
      event: AUDIT_EVENTS.SERVER_DELETED,
      actorId,
      ip: context.ip,
      userAgent: context.userAgent,
      metadata: { serverUuid: uuid, name: server.name },
    });

    // Les allocations sont libérées par `onDelete: SetNull`, pas supprimées :
    // ce sont des ports du node, ils restent disponibles pour un autre serveur.
    await this.prisma.server.delete({ where: { id: server.id } });
  }

  // -------------------------------------------------------------------------
  // Interne
  // -------------------------------------------------------------------------

  private async assertNodeHasCapacity(
    node: {
      id: number;
      memoryBytes: bigint;
      diskBytes: bigint;
      memoryOverallocation: number;
      diskOverallocation: number;
    },
    memoryBytes: bigint,
    diskBytes: bigint,
    excludeServerId?: number,
  ): Promise<void> {
    const totals = await this.prisma.server.aggregate({
      where: { nodeId: node.id, id: excludeServerId ? { not: excludeServerId } : undefined },
      _sum: { memoryBytes: true, diskBytes: true },
    });

    const memory = checkCapacity(
      {
        declared: node.memoryBytes,
        allocated: totals._sum.memoryBytes ?? 0n,
        requested: memoryBytes,
        overallocation: node.memoryOverallocation,
      },
      'Mémoire',
    );

    if (!memory.allowed) {
      throw new ConflictException(memory.reason);
    }

    const disk = checkCapacity(
      {
        declared: node.diskBytes,
        allocated: totals._sum.diskBytes ?? 0n,
        requested: diskBytes,
        overallocation: node.diskOverallocation,
      },
      'Disque',
    );

    if (!disk.allowed) {
      throw new ConflictException(disk.reason);
    }
  }

  /**
   * Choisit l'image Docker, en refusant celles absentes du template.
   *
   * Le template les déclare dans un tableau ordonné : la première est le
   * défaut. Un objet JSON ne conviendrait pas — `jsonb` en réordonne les clés,
   * et « la première image » désignerait alors une entrée imprévisible.
   */
  private resolveDockerImage(dockerImages: Prisma.JsonValue, requested?: string): string {
    const available = parseDockerImages(dockerImages);

    if (available.length === 0) {
      throw new BadRequestException('Ce template ne déclare aucune image Docker.');
    }

    if (!requested) {
      return available[0]!;
    }

    // Une image arbitraire serait une exécution de code choisie par
    // l'utilisateur sur la machine hôte : seules celles du template passent.
    if (!available.includes(requested)) {
      throw new BadRequestException(
        `Image Docker non proposée par ce template. Valeurs acceptées : ${available.join(', ')}.`,
      );
    }

    return requested;
  }

  /**
   * Construit les variables du serveur à partir du template.
   *
   * Une variable non modifiable garde sa valeur par défaut, même si le client
   * en envoie une autre : ces variables entrent dans la commande de démarrage,
   * et les laisser franchir la validation reviendrait à confier le contenu de
   * la ligne de commande à l'utilisateur.
   */
  private resolveVariables(
    templateVariables: { envVariable: string; defaultValue: string; userEditable: boolean }[],
    provided: Record<string, string>,
  ): Record<string, string> {
    const resolved: Record<string, string> = {};

    for (const variable of templateVariables) {
      const candidate = provided[variable.envVariable];
      resolved[variable.envVariable] =
        variable.userEditable && candidate !== undefined ? candidate : variable.defaultValue;
    }

    return resolved;
  }

  private listInclude() {
    return {
      node: { select: { uuid: true, name: true, fqdn: true } },
      template: { select: { uuid: true, name: true } },
      primaryAllocation: { select: { ip: true, port: true, alias: true } },
    } satisfies Prisma.ServerInclude;
  }

  private async queryServers(
    where: Prisma.ServerWhereInput,
    query: PaginationQuery,
    viewerId: number,
  ): Promise<Paginated<ServerListItem>> {
    const [servers, total] = await this.prisma.$transaction([
      this.prisma.server.findMany({
        where,
        include: this.listInclude(),
        orderBy: { createdAt: 'desc' },
        skip: skipFor(query),
        take: query.perPage,
      }),
      this.prisma.server.count({ where }),
    ]);

    return paginate(
      servers.map((server) => this.toListItem(server, viewerId)),
      total,
      query,
    );
  }

  private toListItem(
    server: Prisma.ServerGetPayload<{
      include: {
        node: { select: { uuid: true; name: true; fqdn: true } };
        template: { select: { uuid: true; name: true } };
        primaryAllocation: { select: { ip: true; port: true; alias: true } };
      };
    }>,
    viewerId: number,
  ): ServerListItem {
    return {
      uuid: server.uuid,
      name: server.name,
      description: server.description,
      status: server.status,
      memoryBytes: server.memoryBytes,
      diskBytes: server.diskBytes,
      cpuPercent: server.cpuPercent,
      node: server.node,
      template: server.template,
      primaryAllocation: server.primaryAllocation,
      isOwner: server.ownerId === viewerId,
      createdAt: server.createdAt,
    };
  }
}

/**
 * Permission exigée par action de puissance.
 *
 * `kill` partage la permission d'arrêt : c'est un arrêt, en plus brutal. Lui
 * donner sa propre permission créerait un droit que personne ne penserait à
 * retirer.
 */
const POWER_PERMISSIONS: Record<PowerAction, string> = {
  start: PERMISSIONS.CONTROL_START,
  stop: PERMISSIONS.CONTROL_STOP,
  restart: PERMISSIONS.CONTROL_RESTART,
  kill: PERMISSIONS.CONTROL_STOP,
};

/**
 * Critère de recherche d'un serveur.
 *
 * Trois façons de désigner un serveur, parce que ce sont les trois qu'on a
 * sous la main : son **nom** quand on le connaît, son **identifiant** quand on
 * l'a relevé dans un journal, et son **port** quand on ne dispose que de
 * l'adresse donnée aux joueurs.
 *
 * Partagé entre la liste personnelle et la vue d'administration : la première
 * ne cherchait que par nom, si bien que coller un UUID dans la recherche ne
 * rendait rien — alors que le champ annonçait le contraire.
 */
function searchClause(search: string | undefined): Prisma.ServerWhereInput {
  const term = search?.trim();

  if (!term) {
    return {};
  }

  const port = Number.parseInt(term, 10);

  return {
    OR: [
      { name: { contains: term, mode: 'insensitive' } },
      { uuid: { equals: term } },
      ...(Number.isInteger(port) && port > 0 && port <= 65535
        ? [{ allocations: { some: { port } } } satisfies Prisma.ServerWhereInput]
        : []),
    ],
  };
}
