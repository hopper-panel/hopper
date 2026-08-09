import { Injectable, Logger } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service.js';

/**
 * Identifiers of the logged events.
 *
 * A constant rather than free-form strings: these values are filtered in the
 * interface and sometimes watched by a SIEM. A typo in an `event` would make
 * the action invisible to alerts without a single test failing.
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

  PASSKEY_REGISTERED: 'auth.passkey.registered',
  PASSKEY_REMOVED: 'auth.passkey.removed',
  PASSKEY_LOGIN: 'auth.passkey.login',
  /// A counter that went backwards: the credential exists twice, and one of
  /// the copies is not the user's. Separate from a failed login because it
  /// says something a wrong password never does.
  PASSKEY_CLONE_SUSPECTED: 'auth.passkey.clone-suspected',

  USER_CREATED: 'user.created',
  USER_UPDATED: 'user.updated',
  USER_DELETED: 'user.deleted',

  NODE_CREATED: 'node.created',
  NODE_UPDATED: 'node.updated',
  NODE_DELETED: 'node.deleted',
  NODE_TOKEN_ROTATED: 'node.token.rotated',

  // No `templateId` on `AuditLog`, and none added: the column exists for the
  // server an entry is *about*, which is what the per-server activity feed
  // filters on, and a template belongs to no server. The uuid and the key
  // travel in `metadata` instead — the key especially, since it is what a
  // deleted template can still be recognised by afterwards.
  TEMPLATE_CREATED: 'template.created',
  TEMPLATE_UPDATED: 'template.updated',
  TEMPLATE_DELETED: 'template.deleted',
  TEMPLATE_GROUP_CREATED: 'template-group.created',
  TEMPLATE_GROUP_UPDATED: 'template-group.updated',
  TEMPLATE_GROUP_DELETED: 'template-group.deleted',

  SERVER_CREATED: 'server.created',
  SERVER_UPDATED: 'server.updated',
  SERVER_DELETED: 'server.deleted',
  SERVER_SUSPENDED: 'server.suspended',
  SERVER_UNSUSPENDED: 'server.unsuspended',
  SERVER_REINSTALLED: 'server.reinstalled',
  SERVER_POWER: 'server.power',
  SERVER_COMMAND: 'server.command',
  SERVER_TRANSFERRED: 'server.transferred',

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

  SETTINGS_UPDATED: 'settings.updated',

  API_KEY_CREATED: 'api-key.created',
  API_KEY_DELETED: 'api-key.deleted',

  WEBHOOK_CREATED: 'webhook.created',
  WEBHOOK_UPDATED: 'webhook.updated',
  WEBHOOK_DELETED: 'webhook.deleted',

  SUBUSER_CREATED: 'subuser.created',
  SUBUSER_UPDATED: 'subuser.updated',
  SUBUSER_DELETED: 'subuser.deleted',

  // Recorded before the update starts, never after: the panel restarts in the
  // middle of one, and an entry written on the far side would never be written.
  PANEL_UPDATE_REQUESTED: 'panel.update.requested',
} as const;

export type AuditEvent = (typeof AUDIT_EVENTS)[keyof typeof AUDIT_EVENTS];

export interface AuditEntry {
  event: AuditEvent;
  /** Null for a system action: scheduler, daemon, background task. */
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
   * Records an audit entry.
   *
   * Deliberately tolerant: an audit write that fails must not fail the business
   * action it documents. A failed sign-in has to stay a failed sign-in, not a
   * 500. The error is logged so the problem stays visible.
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
      this.logger.error(`Could not write the audit entry (${entry.event}): ${String(error)}`);
    }
  }
}
