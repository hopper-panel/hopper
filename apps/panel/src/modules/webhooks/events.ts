import { z } from 'zod';

/**
 * Événements auxquels une notification peut s'abonner.
 *
 * Volontairement peu nombreux : ceux pour lesquels on veut être réveillé la
 * nuit. Un journal complet de tout ce qui se passe sur un serveur existe déjà —
 * c'est l'onglet Activité, et le dupliquer en requêtes sortantes n'apporterait
 * que du bruit chez le destinataire.
 */
export const WEBHOOK_EVENTS = {
  SERVER_STARTED: 'server.started',
  SERVER_STOPPED: 'server.stopped',
  /** Le serveur s'est arrêté sans qu'on le lui demande. */
  SERVER_CRASHED: 'server.crashed',
  BACKUP_COMPLETED: 'backup.completed',
  BACKUP_FAILED: 'backup.failed',
  INSTALL_COMPLETED: 'install.completed',
  INSTALL_FAILED: 'install.failed',
} as const;

export type WebhookEvent = (typeof WEBHOOK_EVENTS)[keyof typeof WEBHOOK_EVENTS];

export const webhookEventSchema = z.enum(WEBHOOK_EVENTS);

export const ALL_WEBHOOK_EVENTS: readonly WebhookEvent[] = Object.values(WEBHOOK_EVENTS);

/** Libellés affichés dans l'interface, et repris dans le message Discord. */
export const WEBHOOK_EVENT_LABELS: Record<WebhookEvent, string> = {
  [WEBHOOK_EVENTS.SERVER_STARTED]: 'Serveur démarré',
  [WEBHOOK_EVENTS.SERVER_STOPPED]: 'Serveur arrêté',
  [WEBHOOK_EVENTS.SERVER_CRASHED]: 'Serveur arrêté seul',
  [WEBHOOK_EVENTS.BACKUP_COMPLETED]: 'Sauvegarde terminée',
  [WEBHOOK_EVENTS.BACKUP_FAILED]: 'Sauvegarde échouée',
  [WEBHOOK_EVENTS.INSTALL_COMPLETED]: 'Installation terminée',
  [WEBHOOK_EVENTS.INSTALL_FAILED]: 'Installation échouée',
};

/** Couleur de la barre latérale du message Discord, par gravité. */
export const WEBHOOK_EVENT_COLORS: Record<WebhookEvent, number> = {
  [WEBHOOK_EVENTS.SERVER_STARTED]: 0x3fb950,
  [WEBHOOK_EVENTS.SERVER_STOPPED]: 0x8b949e,
  [WEBHOOK_EVENTS.SERVER_CRASHED]: 0xf85149,
  [WEBHOOK_EVENTS.BACKUP_COMPLETED]: 0x3fb950,
  [WEBHOOK_EVENTS.BACKUP_FAILED]: 0xf85149,
  [WEBHOOK_EVENTS.INSTALL_COMPLETED]: 0x3fb950,
  [WEBHOOK_EVENTS.INSTALL_FAILED]: 0xf85149,
};
