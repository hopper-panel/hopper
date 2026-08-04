import { z } from 'zod';

/**
 * Permissions grantable to a subuser on one server.
 *
 * Format is `<domain>.<action>`. Server owners and panel administrators hold
 * them all implicitly — they are stored only for subusers.
 *
 * This file is the source of truth: the panel checks them on the API side, the
 * daemon receives them in the console JWT and applies them per operation
 * (WebSocket, files, SFTP). Never add a permission on one side only.
 */
export const PERMISSIONS = {
  /** See the console and the server name. Implicit for every subuser. */
  WEBSOCKET_CONNECT: 'websocket.connect',

  CONTROL_CONSOLE: 'control.console',
  CONTROL_START: 'control.start',
  CONTROL_STOP: 'control.stop',
  CONTROL_RESTART: 'control.restart',

  USER_CREATE: 'user.create',
  USER_READ: 'user.read',
  USER_UPDATE: 'user.update',
  USER_DELETE: 'user.delete',

  FILE_READ: 'file.read',
  /** Read file contents, not just list the directory. */
  FILE_READ_CONTENT: 'file.read-content',
  FILE_CREATE: 'file.create',
  FILE_UPDATE: 'file.update',
  FILE_DELETE: 'file.delete',
  FILE_ARCHIVE: 'file.archive',
  FILE_SFTP: 'file.sftp',

  BACKUP_CREATE: 'backup.create',
  BACKUP_READ: 'backup.read',
  BACKUP_DELETE: 'backup.delete',
  BACKUP_DOWNLOAD: 'backup.download',
  BACKUP_RESTORE: 'backup.restore',

  DATABASE_READ: 'database.read',
  DATABASE_CREATE: 'database.create',
  DATABASE_UPDATE: 'database.update',
  DATABASE_DELETE: 'database.delete',

  ALLOCATION_READ: 'allocation.read',
  ALLOCATION_CREATE: 'allocation.create',
  ALLOCATION_UPDATE: 'allocation.update',
  ALLOCATION_DELETE: 'allocation.delete',

  STARTUP_READ: 'startup.read',
  STARTUP_UPDATE: 'startup.update',
  STARTUP_DOCKER_IMAGE: 'startup.docker-image',

  SCHEDULE_CREATE: 'schedule.create',
  SCHEDULE_READ: 'schedule.read',
  SCHEDULE_UPDATE: 'schedule.update',
  SCHEDULE_DELETE: 'schedule.delete',

  WEBHOOK_READ: 'webhook.read',
  WEBHOOK_CREATE: 'webhook.create',
  WEBHOOK_UPDATE: 'webhook.update',
  WEBHOOK_DELETE: 'webhook.delete',

  SETTINGS_RENAME: 'settings.rename',
  SETTINGS_REINSTALL: 'settings.reinstall',

  ACTIVITY_READ: 'activity.read',
} as const;

export type Permission = (typeof PERMISSIONS)[keyof typeof PERMISSIONS];

/** Zod schema derived from the constant above: one list to maintain. */
export const permissionSchema = z.enum(PERMISSIONS);

export const ALL_PERMISSIONS: readonly Permission[] = Object.values(PERMISSIONS);

/**
 * Reverse map: permission string to the name of its constant.
 *
 * The interface keys its texts by that name — `perm.CONTROL_START.label` —
 * because a key built from the value would read `perm.control.start.label`,
 * where the dots of the value and those of the key namespace run together.
 */
export const PERMISSION_NAMES = Object.fromEntries(
  Object.entries(PERMISSIONS).map(([name, value]) => [value, name]),
) as Record<Permission, string>;

const PERMISSION_SET = new Set<string>(ALL_PERMISSIONS);

/** Granted to every subuser as soon as they are added to a server. */
export const IMPLICIT_PERMISSIONS: readonly Permission[] = [PERMISSIONS.WEBSOCKET_CONNECT];

export function isPermission(value: string): value is Permission {
  return PERMISSION_SET.has(value);
}

/**
 * Drops unknown values from a permission list.
 *
 * Useful after a database read: a permission removed from the code in a later
 * version must not break loading a subuser.
 */
export function sanitizePermissions(values: readonly string[]): Permission[] {
  return values.filter(isPermission);
}

/**
 * Display groups, in render order.
 *
 * Only the grouping lives here: labels and descriptions are interface text and
 * belong to the message catalogues, under `permGroup.<key>.label` and
 * `permGroup.<key>.desc`. A group listed here without its texts falls back to
 * English, which is visible; a group missing here would hide its permissions
 * entirely, which is not.
 */
export const PERMISSION_GROUPS: Record<string, { permissions: Permission[] }> = {
  control: {
    permissions: [
      PERMISSIONS.CONTROL_CONSOLE,
      PERMISSIONS.CONTROL_START,
      PERMISSIONS.CONTROL_STOP,
      PERMISSIONS.CONTROL_RESTART,
    ],
  },
  user: {
    permissions: [
      PERMISSIONS.USER_READ,
      PERMISSIONS.USER_CREATE,
      PERMISSIONS.USER_UPDATE,
      PERMISSIONS.USER_DELETE,
    ],
  },
  file: {
    permissions: [
      PERMISSIONS.FILE_READ,
      PERMISSIONS.FILE_READ_CONTENT,
      PERMISSIONS.FILE_CREATE,
      PERMISSIONS.FILE_UPDATE,
      PERMISSIONS.FILE_DELETE,
      PERMISSIONS.FILE_ARCHIVE,
      PERMISSIONS.FILE_SFTP,
    ],
  },
  backup: {
    permissions: [
      PERMISSIONS.BACKUP_READ,
      PERMISSIONS.BACKUP_CREATE,
      PERMISSIONS.BACKUP_DELETE,
      PERMISSIONS.BACKUP_DOWNLOAD,
      PERMISSIONS.BACKUP_RESTORE,
    ],
  },
  database: {
    permissions: [
      PERMISSIONS.DATABASE_READ,
      PERMISSIONS.DATABASE_CREATE,
      PERMISSIONS.DATABASE_UPDATE,
      PERMISSIONS.DATABASE_DELETE,
    ],
  },
  allocation: {
    permissions: [
      PERMISSIONS.ALLOCATION_READ,
      PERMISSIONS.ALLOCATION_CREATE,
      PERMISSIONS.ALLOCATION_UPDATE,
      PERMISSIONS.ALLOCATION_DELETE,
    ],
  },
  startup: {
    permissions: [
      PERMISSIONS.STARTUP_READ,
      PERMISSIONS.STARTUP_UPDATE,
      PERMISSIONS.STARTUP_DOCKER_IMAGE,
    ],
  },
  schedule: {
    permissions: [
      PERMISSIONS.SCHEDULE_READ,
      PERMISSIONS.SCHEDULE_CREATE,
      PERMISSIONS.SCHEDULE_UPDATE,
      PERMISSIONS.SCHEDULE_DELETE,
    ],
  },
  webhook: {
    permissions: [
      PERMISSIONS.WEBHOOK_READ,
      PERMISSIONS.WEBHOOK_CREATE,
      PERMISSIONS.WEBHOOK_UPDATE,
      PERMISSIONS.WEBHOOK_DELETE,
    ],
  },
  settings: {
    permissions: [
      PERMISSIONS.SETTINGS_RENAME,
      PERMISSIONS.SETTINGS_REINSTALL,
      PERMISSIONS.ACTIVITY_READ,
    ],
  },
};

/**
 * Dangerous permissions: they let a subuser obtain code execution on the server
 * or destroy its data. The interface has to flag them visually at the moment
 * they are granted.
 */
export const DANGEROUS_PERMISSIONS: readonly Permission[] = [
  PERMISSIONS.CONTROL_CONSOLE,
  PERMISSIONS.FILE_CREATE,
  PERMISSIONS.FILE_UPDATE,
  PERMISSIONS.FILE_DELETE,
  PERMISSIONS.FILE_SFTP,
  PERMISSIONS.BACKUP_RESTORE,
  PERMISSIONS.STARTUP_UPDATE,
  PERMISSIONS.STARTUP_DOCKER_IMAGE,
  PERMISSIONS.SETTINGS_REINSTALL,
  // Seeing a database means seeing its password, so reading and writing all of
  // its contents.
  PERMISSIONS.DATABASE_READ,
  PERMISSIONS.DATABASE_DELETE,
];
