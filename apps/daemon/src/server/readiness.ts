import type { Readiness, ServerConfiguration } from '@hopper/shared';

/**
 * Deciding when a started server is a running one.
 *
 * Two things live here, and both are pure so they can be tested without a
 * container: which strategy a configuration asks for, and whether a console
 * line satisfies it.
 *
 * The strategy is resolved once, at construction, rather than read on every
 * line — but more importantly it is resolved in *one* place. The old code
 * compiled a regular expression in the constructor and consulted it from two
 * unrelated branches, one of which silently meant "call it running now"; that
 * default was invisible and nobody had chosen it.
 */

export type ResolvedReadiness =
  | { type: 'log'; patterns: RegExp[] }
  | { type: 'port'; role?: string; protocol: 'tcp' | 'udp'; delayMs: number }
  | { type: 'immediate' }
  /** A strategy the daemon cannot run. Refused out loud, never downgraded. */
  | { type: 'unsupported'; reason: string };

/**
 * What the configuration asks for, in the daemon's own terms.
 *
 * `readiness` wins when present. Otherwise `startupDetection` is read as a
 * single-pattern `log`, which is what every imported Pterodactyl egg carries
 * and what every shipped template still declares. Neither means `immediate`,
 * and that distinction is the point: a server with no way to announce itself
 * has to say so, rather than being called ready because nobody said otherwise.
 */
export function resolveReadiness(
  configuration: Pick<ServerConfiguration, 'readiness' | 'startupDetection'>,
  onInvalidPattern?: (pattern: string, error: unknown) => void,
): ResolvedReadiness {
  const declared: Readiness = configuration.readiness ?? {
    type: 'log',
    patterns: configuration.startupDetection ? [configuration.startupDetection] : [],
  };

  switch (declared.type) {
    case 'immediate':
      return { type: 'immediate' };

    case 'port':
      return {
        type: 'port',
        role: declared.role,
        protocol: declared.protocol,
        delayMs: declared.delayMs,
      };

    case 'rcon':
      // Declared in the contract, unimplemented in the daemon. Falling back to
      // `immediate` would call every server ready the moment its container
      // starts, which is exactly the wrong answer for the games that need
      // this strategy in the first place.
      return { type: 'unsupported', reason: 'rcon readiness is not implemented yet' };

    case 'log': {
      const patterns: RegExp[] = [];

      for (const source of declared.patterns) {
        try {
          patterns.push(new RegExp(source));
        } catch (error: unknown) {
          // One bad pattern does not discard the others. A template with two
          // markers, one of them malformed, still recognises the good one.
          onInvalidPattern?.(source, error);
        }
      }

      // No usable pattern is not the same as no pattern declared, but the
      // daemon can do nothing with either: the container running is the only
      // signal left.
      return patterns.length > 0 ? { type: 'log', patterns } : { type: 'immediate' };
    }
  }
}

/**
 * Whether this console line means the server is up.
 *
 * Any one pattern matching is enough — they are alternatives, not steps.
 * Different versions of the same server announce themselves differently, and
 * a template that lists both should not have to guess which one it will get.
 */
export function announcesReady(readiness: ResolvedReadiness, line: string): boolean {
  return readiness.type === 'log' && readiness.patterns.some((pattern) => pattern.test(line));
}
