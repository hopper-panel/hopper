import { z } from 'zod';

/**
 * Events a notification can subscribe to.
 *
 * Deliberately few: the ones worth being woken up at night for. A complete log
 * of everything happening on a server already exists — that is the Activity
 * tab, and duplicating it as outbound requests would bring the recipient
 * nothing but noise.
 */
export const WEBHOOK_EVENTS = {
  SERVER_STARTED: 'server.started',
  SERVER_STOPPED: 'server.stopped',
  /** The server stopped without being asked to. */
  SERVER_CRASHED: 'server.crashed',
  BACKUP_COMPLETED: 'backup.completed',
  BACKUP_FAILED: 'backup.failed',
  INSTALL_COMPLETED: 'install.completed',
  INSTALL_FAILED: 'install.failed',
} as const;

export type WebhookEvent = (typeof WEBHOOK_EVENTS)[keyof typeof WEBHOOK_EVENTS];

export const webhookEventSchema = z.enum(WEBHOOK_EVENTS);

export const ALL_WEBHOOK_EVENTS: readonly WebhookEvent[] = Object.values(WEBHOOK_EVENTS);

/** Labels shown in the interface, and reused in the Discord message. */
export const WEBHOOK_EVENT_LABELS: Record<WebhookEvent, string> = {
  [WEBHOOK_EVENTS.SERVER_STARTED]: 'Server started',
  [WEBHOOK_EVENTS.SERVER_STOPPED]: 'Server stopped',
  [WEBHOOK_EVENTS.SERVER_CRASHED]: 'Server stopped on its own',
  [WEBHOOK_EVENTS.BACKUP_COMPLETED]: 'Backup finished',
  [WEBHOOK_EVENTS.BACKUP_FAILED]: 'Backup failed',
  [WEBHOOK_EVENTS.INSTALL_COMPLETED]: 'Installation finished',
  [WEBHOOK_EVENTS.INSTALL_FAILED]: 'Installation failed',
};

/** Colour of the Discord message's side bar, by severity. */
export const WEBHOOK_EVENT_COLORS: Record<WebhookEvent, number> = {
  [WEBHOOK_EVENTS.SERVER_STARTED]: 0x3fb950,
  [WEBHOOK_EVENTS.SERVER_STOPPED]: 0x8b949e,
  [WEBHOOK_EVENTS.SERVER_CRASHED]: 0xf85149,
  [WEBHOOK_EVENTS.BACKUP_COMPLETED]: 0x3fb950,
  [WEBHOOK_EVENTS.BACKUP_FAILED]: 0xf85149,
  [WEBHOOK_EVENTS.INSTALL_COMPLETED]: 0x3fb950,
  [WEBHOOK_EVENTS.INSTALL_FAILED]: 0xf85149,
};
