import { randomUUID } from 'node:crypto';
import {
  BACKUP_ROUTES,
  type BackupReport,
  type CreateBackupRequest,
  type RestoreBackupRequest,
} from '@hopper/shared';
import {
  BadRequestException,
  ConflictException,
  HttpException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service.js';
import { NodeClientService } from '../nodes/node-client.service.js';
import { NodesService } from '../nodes/nodes.service.js';
import { planRetention } from './retention.js';

/**
 * Sauvegardes, vues du panel.
 *
 * Le panel tient le registre : c'est lui qui sait combien de sauvegardes un
 * serveur a le droit de garder, laquelle est verrouillée, et laquelle doit
 * disparaître quand la suivante arrive. Le daemon, lui, ne sait qu'archiver un
 * volume — il n'a aucune idée de ce qu'est une politique de rétention.
 *
 * L'enregistrement est créé **avant** d'appeler le node, jamais après. Si le
 * node est injoignable, on préfère une ligne marquée en échec à une archive
 * écrite sur disque dont le panel ignorerait l'existence : la première se voit
 * et se corrige, la seconde occupe le disque en silence.
 */
@Injectable()
export class BackupsService {
  private readonly logger = new Logger(BackupsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly nodes: NodesService,
    private readonly client: NodeClientService,
  ) {}

  async list(serverUuid: string) {
    const server = await this.requireServer(serverUuid);

    const backups = await this.prisma.backup.findMany({
      where: { serverId: server.id },
      orderBy: { createdAt: 'desc' },
    });

    return {
      data: backups.map(toPublicBackup),
      meta: { limit: server.backupLimit, used: backups.length },
    };
  }

  async findByUuid(serverUuid: string, backupUuid: string) {
    const server = await this.requireServer(serverUuid);
    const backup = await this.prisma.backup.findFirst({
      where: { uuid: backupUuid, serverId: server.id },
    });

    if (!backup) {
      throw new NotFoundException('Sauvegarde introuvable.');
    }

    return toPublicBackup(backup);
  }

  /**
   * Demande une nouvelle sauvegarde.
   *
   * Rend la main dès que le node a accepté : l'archivage se poursuit et le
   * verdict arrive par `POST /api/remote/backups/:uuid/status`.
   */
  async create(
    serverUuid: string,
    input: { name?: string; ignoredFiles?: string[]; locked?: boolean },
  ) {
    const server = await this.requireServer(serverUuid);

    if (server.backupLimit <= 0) {
      throw new BadRequestException('Les sauvegardes sont désactivées sur ce serveur.');
    }

    // Une sauvegarde déjà en cours n'est pas encore comptée dans la rétention :
    // en lancer deux en parallèle ferait dépasser le quota et saturerait le
    // disque du node.
    const inFlight = await this.prisma.backup.count({
      where: { serverId: server.id, successful: null },
    });

    if (inFlight > 0) {
      throw new ConflictException('Une sauvegarde est déjà en cours sur ce serveur.');
    }

    await this.enforceRetention(server.id, server.backupLimit);

    const uuid = randomUUID();
    const ignoredFiles = input.ignoredFiles ?? [];

    const backup = await this.prisma.backup.create({
      data: {
        uuid,
        serverId: server.id,
        name: input.name?.trim() || defaultBackupName(),
        ignoredFiles,
        locked: input.locked ?? false,
      },
    });

    const node = await this.nodes.getConnection(server.node.uuid);
    const request: CreateBackupRequest = { uuid, ignoredFiles };

    try {
      unwrapDaemonResponse(
        await this.client.proxy(node, BACKUP_ROUTES.backups(server.uuid), {
          method: 'POST',
          body: request,
          timeoutMs: 30_000,
        }),
      );
    } catch (error: unknown) {
      // La ligne est marquée en échec plutôt que supprimée : l'utilisateur doit
      // voir que sa sauvegarde a été tentée et pourquoi elle n'a pas abouti.
      await this.prisma.backup.update({
        where: { id: backup.id },
        data: {
          successful: false,
          errorDetail: 'Le node est injoignable.',
          completedAt: new Date(),
        },
      });

      throw error;
    }

    return toPublicBackup(backup);
  }

  /**
   * Enregistre le verdict rendu par le daemon.
   *
   * Appelé par la route distante, authentifiée par le jeton de node. Une
   * sauvegarde déjà close n'est pas réécrite : un rappel dupliqué — le daemon
   * réessaie — ne doit pas ressusciter une sauvegarde que la rétention a déjà
   * effacée.
   */
  async recordReport(backupUuid: string, report: BackupReport): Promise<void> {
    const backup = await this.prisma.backup.findUnique({ where: { uuid: backupUuid } });

    if (!backup) {
      this.logger.warn(`Rapport reçu pour une sauvegarde inconnue : ${backupUuid}`);
      return;
    }

    if (backup.successful !== null) {
      this.logger.warn(`Rapport ignoré : la sauvegarde ${backupUuid} est déjà close.`);
      return;
    }

    await this.prisma.backup.update({
      where: { id: backup.id },
      data: {
        successful: report.successful,
        sizeBytes: BigInt(report.sizeBytes),
        checksum: report.successful ? report.checksum : null,
        errorDetail: report.error ?? null,
        completedAt: new Date(),
      },
    });
  }

  async setLocked(serverUuid: string, backupUuid: string, locked: boolean) {
    const server = await this.requireServer(serverUuid);
    const backup = await this.prisma.backup.findFirst({
      where: { uuid: backupUuid, serverId: server.id },
    });

    if (!backup) {
      throw new NotFoundException('Sauvegarde introuvable.');
    }

    const updated = await this.prisma.backup.update({
      where: { id: backup.id },
      data: { locked },
    });

    return toPublicBackup(updated);
  }

  async delete(serverUuid: string, backupUuid: string): Promise<void> {
    const server = await this.requireServer(serverUuid);
    const backup = await this.prisma.backup.findFirst({
      where: { uuid: backupUuid, serverId: server.id },
    });

    if (!backup) {
      throw new NotFoundException('Sauvegarde introuvable.');
    }

    if (backup.locked) {
      throw new ConflictException(
        'Cette sauvegarde est verrouillée. Déverrouillez-la avant de la supprimer.',
      );
    }

    if (backup.successful === null) {
      throw new ConflictException('Cette sauvegarde est en cours.');
    }

    const node = await this.nodes.getConnection(server.node.uuid);

    // L'archive part avant la ligne : l'inverse laisserait un fichier orphelin
    // que plus rien ne référence, donc que personne ne supprimera jamais.
    unwrapDaemonResponse(
      await this.client.proxy(node, BACKUP_ROUTES.backup(server.uuid, backupUuid), {
        method: 'DELETE',
      }),
    );

    await this.prisma.backup.delete({ where: { id: backup.id } });
  }

  /**
   * Restaure une sauvegarde.
   *
   * Le serveur doit être arrêté ; le daemon refuse sinon. Le panel transmet
   * l'empreinte enregistrée, que le daemon vérifie avant d'écrire quoi que ce
   * soit — une archive corrompue ne doit pas laisser le volume à moitié écrasé.
   */
  async restore(serverUuid: string, backupUuid: string, input: RestoreBackupRequest) {
    const server = await this.requireServer(serverUuid);
    const backup = await this.prisma.backup.findFirst({
      where: { uuid: backupUuid, serverId: server.id },
    });

    if (!backup) {
      throw new NotFoundException('Sauvegarde introuvable.');
    }

    if (backup.successful !== true) {
      throw new ConflictException(
        "Cette sauvegarde n'a pas abouti : elle ne peut pas être restaurée.",
      );
    }

    const node = await this.nodes.getConnection(server.node.uuid);
    const query = backup.checksum ? `?checksum=${backup.checksum}` : '';

    const response = await this.client.proxy(
      node,
      `${BACKUP_ROUTES.backupRestore(server.uuid, backupUuid)}${query}`,
      {
        method: 'POST',
        body: input,
        // Extraire plusieurs gigaoctets prend du temps ; expirer ici laisserait
        // l'utilisateur croire à un échec alors que la restauration se poursuit.
        timeoutMs: 900_000,
      },
    );

    return unwrapDaemonResponse(response);
  }

  /**
   * Fait de la place avant une nouvelle sauvegarde.
   *
   * Les sauvegardes verrouillées ne comptent pas comme supprimables — c'est
   * tout leur intérêt — mais elles occupent bien un emplacement. Un serveur
   * dont toutes les sauvegardes sont verrouillées ne peut donc plus en créer,
   * et le message doit le dire clairement plutôt que d'échouer sur un quota.
   */
  /**
   * Fait de la place avant une nouvelle sauvegarde.
   *
   * La décision — que retirer, et faut-il refuser — vit dans `planRetention`,
   * qui ne touche à rien et se teste exhaustivement. Ici il ne reste que
   * l'exécution : c'est la seule partie du module qui détruit des données, et
   * la séparer est ce qui rend la règle vérifiable.
   */
  private async enforceRetention(serverId: number, limit: number): Promise<void> {
    const existing = await this.prisma.backup.findMany({
      where: { serverId },
      select: { id: true, uuid: true, locked: true, createdAt: true },
    });

    const plan = planRetention(existing, limit);

    if (plan.kind === 'blocked') {
      throw new ConflictException(
        `La limite de ${plan.limit} sauvegarde(s) est atteinte et ${plan.lockedCount} d'entre ` +
          'elles sont verrouillées. Déverrouillez-en une, ou supprimez-en une manuellement.',
      );
    }

    if (plan.remove.length === 0) {
      return;
    }

    const server = await this.prisma.server.findUniqueOrThrow({
      where: { id: serverId },
      include: { node: { select: { uuid: true } } },
    });
    const node = await this.nodes.getConnection(server.node.uuid);

    for (const backup of plan.remove) {
      // Un échec de suppression sur le node ne doit pas empêcher la nouvelle
      // sauvegarde : l'archive orpheline est tracée, et le disque du node reste
      // sous la surveillance de l'opérateur.
      await this.client
        .proxy(node, BACKUP_ROUTES.backup(server.uuid, backup.uuid), { method: 'DELETE' })
        .catch((error: unknown) => {
          this.logger.error(
            `Archive ${backup.uuid} non supprimée sur le node ${node.uuid} : ${String(error)}`,
          );
        });

      await this.prisma.backup.delete({ where: { uuid: backup.uuid } });
    }
  }

  private async requireServer(uuid: string) {
    const server = await this.prisma.server.findUnique({
      where: { uuid },
      include: { node: { select: { uuid: true } } },
    });

    if (!server) {
      throw new NotFoundException('Serveur introuvable.');
    }

    return server;
  }
}

interface BackupRow {
  uuid: string;
  name: string;
  driver: string;
  ignoredFiles: string[];
  sizeBytes: bigint;
  checksum: string | null;
  successful: boolean | null;
  errorDetail: string | null;
  locked: boolean;
  completedAt: Date | null;
  createdAt: Date;
}

function toPublicBackup(backup: BackupRow) {
  return {
    uuid: backup.uuid,
    name: backup.name,
    driver: backup.driver,
    ignoredFiles: backup.ignoredFiles,
    sizeBytes: backup.sizeBytes,
    checksum: backup.checksum,
    // `null` tant que le daemon n'a pas rendu son verdict : l'interface
    // distingue « en cours » de « échouée », ce qu'un booléen ne permettrait pas.
    successful: backup.successful,
    error: backup.errorDetail,
    locked: backup.locked,
    completedAt: backup.completedAt,
    createdAt: backup.createdAt,
  };
}

function defaultBackupName(): string {
  // Nom lisible et triable, dans le fuseau du panel : « Sauvegarde du
  // 2026-08-03 21:40 ». L'utilisateur reconnaît la sienne sans avoir à lire un
  // UUID.
  const now = new Date();
  const pad = (value: number) => String(value).padStart(2, '0');

  return (
    `Sauvegarde du ${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ` +
    `${pad(now.getHours())}:${pad(now.getMinutes())}`
  );
}

interface DaemonResponse {
  status: number;
  contentType: string | null;
  body: Buffer;
}

/**
 * Traduit la réponse brute du daemon en résultat ou en erreur HTTP.
 *
 * `proxy` rend un enveloppe `{ status, contentType, body }` : la retourner
 * telle quelle depuis un contrôleur Nest produisait un 201 contenant le
 * `Buffer` sérialisé du corps. Le client voyait donc « créé » là où le daemon
 * refusait — un refus qui ne refuse rien est pire qu'une erreur, puisqu'il
 * laisse croire que l'opération a eu lieu.
 */
function unwrapDaemonResponse(response: DaemonResponse): unknown {
  const text = response.body.toString('utf8');
  let parsed: unknown = undefined;

  if (text.length > 0 && response.contentType?.includes('application/json')) {
    try {
      parsed = JSON.parse(text);
    } catch {
      // Corps illisible : le statut reste la seule information fiable.
    }
  }

  if (response.status >= 400) {
    const message =
      (parsed as { error?: { message?: string } } | undefined)?.error?.message ??
      "Le node a refusé l'opération.";

    throw new HttpException(message, response.status);
  }

  return parsed;
}
