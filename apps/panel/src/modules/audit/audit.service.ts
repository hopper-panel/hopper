import { Injectable, Logger } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service.js';

/**
 * Identifiants d'événements journalisés.
 *
 * Une constante plutôt que des chaînes libres : ces valeurs sont filtrées dans
 * l'interface et parfois surveillées par un SIEM. Une faute de frappe dans un
 * `event` rendrait l'action invisible aux alertes sans qu'aucun test n'échoue.
 */
export const AUDIT_EVENTS = {
  LOGIN_SUCCESS: 'auth.login.success',
  LOGIN_FAILED: 'auth.login.failed',
  LOGIN_BLOCKED: 'auth.login.blocked',
  LOGOUT: 'auth.logout',
  TOKEN_REUSE_DETECTED: 'auth.token.reuse-detected',
  PASSWORD_CHANGED: 'auth.password.changed',
  TWO_FACTOR_ENABLED: 'auth.2fa.enabled',
  TWO_FACTOR_DISABLED: 'auth.2fa.disabled',
  TWO_FACTOR_FAILED: 'auth.2fa.failed',
  RECOVERY_CODE_USED: 'auth.2fa.recovery-code-used',

  USER_CREATED: 'user.created',
  USER_UPDATED: 'user.updated',
  USER_DELETED: 'user.deleted',

  NODE_CREATED: 'node.created',
  NODE_UPDATED: 'node.updated',
  NODE_DELETED: 'node.deleted',
  NODE_TOKEN_ROTATED: 'node.token.rotated',

  SERVER_CREATED: 'server.created',
  SERVER_UPDATED: 'server.updated',
  SERVER_DELETED: 'server.deleted',
  SERVER_SUSPENDED: 'server.suspended',
  SERVER_UNSUSPENDED: 'server.unsuspended',
  SERVER_REINSTALLED: 'server.reinstalled',
  SERVER_POWER: 'server.power',
  SERVER_COMMAND: 'server.command',

  BACKUP_CREATED: 'backup.created',
  BACKUP_DELETED: 'backup.deleted',
  BACKUP_RESTORED: 'backup.restored',
  BACKUP_LOCKED: 'backup.locked',

  DATABASE_CREATED: 'database.created',
  DATABASE_UPDATED: 'database.updated',
  DATABASE_DELETED: 'database.deleted',

  SCHEDULE_CREATED: 'schedule.created',
  SCHEDULE_UPDATED: 'schedule.updated',
  SCHEDULE_DELETED: 'schedule.deleted',
  SCHEDULE_RUN: 'schedule.run',

  SUBUSER_CREATED: 'subuser.created',
  SUBUSER_UPDATED: 'subuser.updated',
  SUBUSER_DELETED: 'subuser.deleted',
} as const;

export type AuditEvent = (typeof AUDIT_EVENTS)[keyof typeof AUDIT_EVENTS];

export interface AuditEntry {
  event: AuditEvent;
  /** Null pour une action du système : planificateur, daemon, tâche de fond. */
  actorId?: number | null;
  serverId?: number | null;
  ip?: string | null;
  userAgent?: string | null;
  metadata?: Prisma.InputJsonValue;
}

@Injectable()
export class AuditService {
  private readonly logger = new Logger(AuditService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Enregistre une entrée d'audit.
   *
   * Volontairement tolérante : une écriture d'audit qui échoue ne doit pas
   * faire échouer l'action métier qu'elle documente. Un échec de connexion doit
   * rester un échec de connexion, pas une 500. L'erreur est journalisée pour
   * que le problème reste visible.
   */
  async record(entry: AuditEntry): Promise<void> {
    try {
      await this.prisma.auditLog.create({
        data: {
          event: entry.event,
          actorId: entry.actorId ?? null,
          serverId: entry.serverId ?? null,
          ip: entry.ip ?? null,
          userAgent: entry.userAgent?.slice(0, 500) ?? null,
          metadata: entry.metadata ?? {},
        },
      });
    } catch (error: unknown) {
      this.logger.error(`Écriture d'audit impossible (${entry.event}) : ${String(error)}`);
    }
  }
}
