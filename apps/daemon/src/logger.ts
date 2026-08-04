import { pino, type Logger } from 'pino';

/**
 * Chemins masqués dans les journaux.
 *
 * Un daemon qui journalise un jeton de node donne le contrôle de tous les
 * serveurs de la machine à quiconque lit `journalctl`. Cette liste doit grandir
 * en même temps que le contrat : toute nouvelle donnée sensible s'y ajoute.
 */
const REDACTED_PATHS = [
  'tokenSecret',
  'panel.jwtSecret',
  'password',
  'token',
  'req.headers.authorization',
  'req.headers.cookie',
  'headers.authorization',
  '*.tokenSecret',
  '*.password',
];

export function createLogger(debug: boolean): Logger {
  return pino({
    level: debug ? 'debug' : 'info',
    redact: { paths: REDACTED_PATHS, censor: '[redacted]' },
    // pino-pretty n'est une dépendance que de développement : en production les
    // journaux sortent en JSON, lus par journald.
    transport:
      process.env.NODE_ENV !== 'production'
        ? { target: 'pino-pretty', options: { translateTime: 'HH:MM:ss', ignore: 'pid,hostname' } }
        : undefined,
  });
}

export type { Logger };
