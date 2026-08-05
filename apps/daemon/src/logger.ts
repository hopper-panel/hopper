import { pino, type Logger } from 'pino';

/**
 * Paths redacted from the logs.
 *
 * A daemon that logs a node token hands control of every server on the machine
 * to whoever reads `journalctl`. This list has to grow alongside the contract:
 * every new piece of sensitive data joins it.
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
    // pino-pretty is a development dependency only: in production the logs come
    // out as JSON, read by journald.
    transport:
      process.env.NODE_ENV !== 'production'
        ? { target: 'pino-pretty', options: { translateTime: 'HH:MM:ss', ignore: 'pid,hostname' } }
        : undefined,
  });
}

export type { Logger };
