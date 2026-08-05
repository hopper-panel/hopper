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
 * Backups, as the panel sees them.
 *
 * The panel keeps the register: it is the one that knows how many backups a
 * server may keep, which is locked, and which has to go when the next one
 * arrives. The daemon only knows how to archive a volume — it has no idea what
 * a retention policy is.
 *
 * The record is created **before** calling the node, never after. If the node
 * is unreachable, a row marked failed beats an archive written to disk the
 * panel knows nothing about: the first is visible and fixable, the second takes
 * up disk in silence.
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
      throw new NotFoundException('Backup not found.');
    }

    return toPublicBackup(backup);
  }

  /**
   * Requests a new backup.
   *
   * Returns as soon as the node has accepted: archiving carries on and the
   * verdict arrives through `POST /api/remote/backups/:uuid/status`.
   */
  async create(
    serverUuid: string,
    input: { name?: string; ignoredFiles?: string[]; locked?: boolean },
  ) {
    const server = await this.requireServer(serverUuid);

    if (server.backupLimit <= 0) {
      throw new BadRequestException('Backups are disabled on this server.');
    }

    // A backup already running is not counted in retention yet: launching two
    // in parallel would overshoot the quota and fill the node's disk.
    const inFlight = await this.prisma.backup.count({
      where: { serverId: server.id, successful: null },
    });

    if (inFlight > 0) {
      throw new ConflictException('A backup is already running on this server.');
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
      // The row is marked failed rather than deleted: the user has to see that
      // their backup was attempted and why it did not complete.
      await this.prisma.backup.update({
        where: { id: backup.id },
        data: {
          successful: false,
          errorDetail: 'The node is unreachable.',
          completedAt: new Date(),
        },
      });

      throw error;
    }

    return toPublicBackup(backup);
  }

  /**
   * Records the verdict the daemon returned.
   *
   * Called by the remote route, authenticated by the node token. A backup
   * already closed is not rewritten: a duplicate callback — the daemon retries
   * — must not resurrect a backup retention has already erased.
   */
  async recordReport(backupUuid: string, report: BackupReport): Promise<void> {
    const backup = await this.prisma.backup.findUnique({ where: { uuid: backupUuid } });

    if (!backup) {
      this.logger.warn(`Report received for an unknown backup: ${backupUuid}`);
      return;
    }

    if (backup.successful !== null) {
      this.logger.warn(`Report ignored: backup ${backupUuid} is already closed.`);
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
      throw new NotFoundException('Backup not found.');
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
      throw new NotFoundException('Backup not found.');
    }

    if (backup.locked) {
      throw new ConflictException('This backup is locked. Unlock it before deleting it.');
    }

    if (backup.successful === null) {
      throw new ConflictException('This backup is still running.');
    }

    const node = await this.nodes.getConnection(server.node.uuid);

    // The archive goes before the row: the reverse would leave an orphan file
    // nothing references any more, so one nobody will ever delete.
    unwrapDaemonResponse(
      await this.client.proxy(node, BACKUP_ROUTES.backup(server.uuid, backupUuid), {
        method: 'DELETE',
      }),
    );

    await this.prisma.backup.delete({ where: { id: backup.id } });
  }

  /**
   * Restores a backup.
   *
   * The server has to be stopped; the daemon refuses otherwise. The panel
   * passes the recorded digest, which the daemon checks before writing
   * anything — a corrupt archive must not leave the volume half
   * overwritten.
   */
  async restore(serverUuid: string, backupUuid: string, input: RestoreBackupRequest) {
    const server = await this.requireServer(serverUuid);
    const backup = await this.prisma.backup.findFirst({
      where: { uuid: backupUuid, serverId: server.id },
    });

    if (!backup) {
      throw new NotFoundException('Backup not found.');
    }

    if (backup.successful !== true) {
      throw new ConflictException('This backup did not complete: it cannot be restored.');
    }

    const node = await this.nodes.getConnection(server.node.uuid);
    const query = backup.checksum ? `?checksum=${backup.checksum}` : '';

    const response = await this.client.proxy(
      node,
      `${BACKUP_ROUTES.backupRestore(server.uuid, backupUuid)}${query}`,
      {
        method: 'POST',
        body: input,
        // Extracting several gigabytes takes time; timing out here would let
        // the user believe it failed while the restore carries on.
        timeoutMs: 900_000,
      },
    );

    return unwrapDaemonResponse(response);
  }

  /**
   * Makes room before a new backup.
   *
   * Locked backups do not count as deletable — that is their whole point — but
   * they do occupy a slot. A server whose backups are all locked can therefore
   * create no more, and the message has to say so plainly rather than fail on a
   * quota.
   */
  /**
   * Makes room before a new backup.
   *
   * The decision — what to remove, and whether to refuse — lives in
   * `planRetention`, which touches nothing and can be tested exhaustively. Only
   * the execution remains here: it is the only part of the module that destroys
   * data, and separating it is what makes the rule checkable.
   */
  private async enforceRetention(serverId: number, limit: number): Promise<void> {
    const existing = await this.prisma.backup.findMany({
      where: { serverId },
      select: { id: true, uuid: true, locked: true, createdAt: true },
    });

    const plan = planRetention(existing, limit);

    if (plan.kind === 'blocked') {
      throw new ConflictException(
        `The limit of ${plan.limit} backup(s) is reached and ${plan.lockedCount} of them ` +
          'are locked. Unlock one, or delete one by hand.',
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
      // A failed deletion on the node must not block the new backup: the orphan
      // archive is logged, and the node's disk stays under the operator's
      // watch.
      await this.client
        .proxy(node, BACKUP_ROUTES.backup(server.uuid, backup.uuid), { method: 'DELETE' })
        .catch((error: unknown) => {
          this.logger.error(
            `Archive ${backup.uuid} not deleted on node ${node.uuid}: ${String(error)}`,
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
      throw new NotFoundException('Server not found.');
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
    // `null` until the daemon has returned its verdict: the interface tells
    // "running" from "failed", which a boolean would not allow.
    successful: backup.successful,
    error: backup.errorDetail,
    locked: backup.locked,
    completedAt: backup.completedAt,
    createdAt: backup.createdAt,
  };
}

function defaultBackupName(): string {
  // A readable, sortable name in the panel's time zone: "Backup of 2026-08-03
  // 21:40". The user recognises theirs without having to read a UUID.
  const now = new Date();
  const pad = (value: number) => String(value).padStart(2, '0');

  return (
    `Backup of ${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ` +
    `${pad(now.getHours())}:${pad(now.getMinutes())}`
  );
}

interface DaemonResponse {
  status: number;
  contentType: string | null;
  body: Buffer;
}

/**
 * Translates the daemon's raw answer into a result or an HTTP error.
 *
 * `proxy` returns an envelope `{ status, contentType, body }`: returning it as
 * is from a Nest controller produced a 201 containing the serialised `Buffer`
 * of the body. The client therefore saw "created" where the daemon refused — a
 * refusal that refuses nothing is worse than an error, since it suggests the
 * operation took place.
 */
function unwrapDaemonResponse(response: DaemonResponse): unknown {
  const text = response.body.toString('utf8');
  let parsed: unknown = undefined;

  if (text.length > 0 && response.contentType?.includes('application/json')) {
    try {
      parsed = JSON.parse(text);
    } catch {
      // Unreadable body: the status stays the only reliable information.
    }
  }

  if (response.status >= 400) {
    const message =
      (parsed as { error?: { message?: string } } | undefined)?.error?.message ??
      'The node refused the operation.';

    throw new HttpException(message, response.status);
  }

  return parsed;
}
