import { pino, type DestinationStream, type Logger } from 'pino';

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

/**
 * @param destination Where the lines go. Only tests pass one — they have to
 *   read what was written to prove the redaction actually happened, and a
 *   logger whose output nobody can see is a logger whose redaction nobody can
 *   check. A destination and a transport are mutually exclusive in pino, which
 *   is why supplying one turns the pretty-printer off.
 */
export function createLogger(debug: boolean, destination?: DestinationStream): Logger {
  const options = {
    level: debug ? 'debug' : 'info',
    redact: { paths: REDACTED_PATHS, censor: '[redacted]' },
  };

  if (destination) {
    return pino(options, destination);
  }

  return pino({
    ...options,
    // pino-pretty is a development dependency only: in production the logs come
    // out as JSON, read by journald.
    transport:
      process.env.NODE_ENV !== 'production'
        ? { target: 'pino-pretty', options: { translateTime: 'HH:MM:ss', ignore: 'pid,hostname' } }
        : undefined,
  });
}

export type { Logger };
