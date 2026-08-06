import { allocationForRole, type Allocation, type ServerConfiguration } from '@hopper/shared';

/**
 * Deciding when a started server is a running one.
 *
 * Two things live here, and both are pure so they can be tested without a
 * container: which strategy a configuration asks for — and, for the two that
 * knock on something, at which address — and whether a console line satisfies
 * it.
 *
 * The strategy is resolved when the configuration changes, not on every console
 * line — but more importantly it is resolved in *one* place. The old code
 * compiled a regular expression in the constructor and consulted it from two
 * unrelated branches, one of which silently meant "call it running now"; that
 * default was invisible and nobody had chosen it.
 */

/**
 * `timeoutMs` is null wherever no deadline was declared — a configuration that
 * predates `readiness`, or a template that named none. Those waits are
 * open-ended: they end when the server becomes ready or when the start ends
 * some other way, and never by themselves. A deadline is what a template opts
 * into to make a start capable of failing.
 */
export type ResolvedReadiness =
  | { type: 'log'; patterns: RegExp[]; timeoutMs: number | null }
  /**
   * Only ever `tcp`: a UDP declaration comes back as `unsupported`, see below.
   *
   * The address is resolved here rather than looked up at connection time, so
   * that a role naming no port on this server is refused before the container
   * is started rather than discovered by a wait that has nothing to knock on.
   */
  | {
      type: 'port';
      protocol: 'tcp';
      ip: string;
      port: number;
      delayMs: number;
      timeoutMs: number | null;
    }
  | { type: 'rcon'; ip: string; port: number; secretVariable: string; timeoutMs: number | null }
  | { type: 'immediate' }
  /**
   * A strategy this node cannot run.
   *
   * Not run, and not waited on either: the daemon calls the server running as
   * soon as its container is up. That is the wrong moment — the server may be
   * minutes away from taking a player — and it is still the better of the two
   * answers available. The alternative was to leave the state at `starting`
   * for ever, which shows a spinner over a server that is either dead or
   * perfectly fine, with nothing to tell the two apart and no state change to
   * notify anybody about.
   *
   * What makes the downgrade acceptable is that it is loud. Two lines go to
   * the server's console in the panel — what could not be checked, and that
   * the server is being called running regardless — and a `logger.warn` goes
   * to hopperd's own log for whoever is reading `journalctl` rather than the
   * interface. An operator who sees them knows the state means "container up",
   * not "playable", and can act on it; nobody can act on a spinner.
   */
  | { type: 'unsupported'; reason: string };

/**
 * What the configuration asks for, in the daemon's own terms.
 *
 * `readiness` wins when present. Otherwise `startupDetection` is read as a
 * single-pattern `log`, which is what every imported Pterodactyl egg carries
 * and what every shipped template still declares. Neither means `immediate`,
 * and that distinction is the point: a server with no way to announce itself
 * has to say so, rather than being called ready because nobody said otherwise.
 *
 * A deadline only ever comes from a template that asked for one. This is the
 * single place that turns "asked for nothing" into `null`, whether the nothing
 * arrived as a deprecated `startupDetection` or as a `readiness` with no
 * `timeoutMs`; everything downstream reads the field and does not care which
 * shape it came from.
 *
 * The allocations are read for the same reason: a `role` is resolved into an
 * address here, so the two waits knock on what they are handed and no longer
 * reach for the primary port behind the strategy's back. Naming nothing still
 * means the primary port, which is what every configuration written before
 * names existed asks for and has to go on meaning.
 */
export function resolveReadiness(
  configuration: Pick<ServerConfiguration, 'readiness' | 'startupDetection' | 'allocations'>,
  onInvalidPattern?: (pattern: string, error: unknown) => void,
): ResolvedReadiness {
  const declared = configuration.readiness;

  if (declared === undefined) {
    // The shape every imported Pterodactyl egg carries and every shipped
    // template still declares, read as a single-pattern `log` — and with no
    // deadline at all. These configurations were written when the daemon
    // waited for ever, and a modded pack that spends a quarter of an hour
    // loading its world would be stopped mid-start by a timeout its author
    // never chose. A deadline is something a template opts into by declaring
    // `readiness`.
    return compileLogPatterns(
      configuration.startupDetection ? [configuration.startupDetection] : [],
      null,
      onInvalidPattern,
    );
  }

  switch (declared.type) {
    case 'immediate':
      return { type: 'immediate' };

    case 'port': {
      // A TCP connect against a UDP game is not a weaker answer, it is a wrong
      // one: nothing is listening on the TCP port, so the probe fails for the
      // whole timeout while the server is up and taking players. So it is not
      // attempted — nor implemented as a real UDP probe, because a UDP socket
      // is connectionless and a closed port refuses nothing; the only evidence
      // is an ICMP message the kernel hands to a raw socket, which needs
      // CAP_NET_RAW, a capability hopperd drops on purpose.
      //
      // What the caller does with `unsupported` is say so and call the server
      // running anyway — see the type above for why that beats an eternal
      // `starting`. The alternatives named in the reason are the ones that do
      // work, because a refusal an operator cannot act on is just a hang with
      // an explanation.
      //
      // Checked before the role, because it is a property of the declaration
      // and not of the server: a UDP probe is refused whichever port it names.
      if (declared.protocol === 'udp') {
        return {
          type: 'unsupported',
          reason:
            'this node cannot probe a UDP port; use the log or rcon readiness strategy instead',
        };
      }

      const target = addressFor(configuration, declared.role);

      if ('refusal' in target) {
        return target.refusal;
      }

      return {
        type: 'port',
        protocol: 'tcp',
        ip: target.address.ip,
        port: target.address.port,
        delayMs: declared.delayMs,
        // Absent means open-ended, here as everywhere: the template declared
        // no deadline, so nothing may fail this start on time alone.
        timeoutMs: declared.timeoutMs ?? null,
      };
    }

    case 'rcon': {
      const target = addressFor(configuration, declared.role);

      if ('refusal' in target) {
        return target.refusal;
      }

      // The password is named, never carried: it is a template variable, and
      // the daemon resolves it against the server's environment at the moment
      // it connects. A readiness strategy holding a secret would be a secret
      // in every configuration payload and every log line that printed one.
      return {
        type: 'rcon',
        ip: target.address.ip,
        port: target.address.port,
        secretVariable: declared.secretVariable,
        timeoutMs: declared.timeoutMs ?? null,
      };
    }

    case 'log':
      return compileLogPatterns(declared.patterns, declared.timeoutMs ?? null, onInvalidPattern);
  }
}

/**
 * Which port a strategy knocks on — or a refusal, if it names one that is not
 * there.
 *
 * The refusal is the load-bearing half. Reading an unmatched role as "the
 * primary port then" is the failure this whole path exists to prevent: a
 * template declaring the one realistic use of the rcon strategy — RCON on its
 * own port, the game on another — would have the daemon speak the handshake at
 * the game port, get an error every two seconds, and at the deadline stop a
 * server that was up and serving players, reporting it to the operator as a
 * crash. Refusing costs that template its readiness check; guessing costs it
 * the server.
 *
 * A role that matches nothing is not a bug in the template either — it is a
 * template naming a port the operator never created — so the reason says which
 * name went unmatched and where to create it. And because the strategy is
 * re-resolved on every configuration sync, creating it in the panel fixes the
 * next start without anybody restarting hopperd.
 */
function addressFor(
  configuration: Pick<ServerConfiguration, 'allocations'>,
  role: string | undefined,
): { address: Allocation } | { refusal: ResolvedReadiness } {
  const address = allocationForRole(configuration.allocations, role);

  if (address) {
    return { address };
  }

  return {
    refusal: {
      type: 'unsupported',
      reason:
        `no port on this server is named "${role}", so there is nothing to check. ` +
        "Name one in the server's Network tab, or drop the name to use the primary port",
    },
  };
}

/**
 * Turns declared patterns into compiled ones, keeping whatever compiles.
 *
 * Shared by the two ways a `log` strategy can arrive — declared outright, or
 * inferred from the deprecated `startupDetection` — so that the two cannot
 * drift apart. The deadline is the caller's to decide, because only the caller
 * can see whether one was declared: the deprecated field can never carry one.
 */
function compileLogPatterns(
  sources: string[],
  timeoutMs: number | null,
  onInvalidPattern?: (pattern: string, error: unknown) => void,
): ResolvedReadiness {
  const patterns: RegExp[] = [];

  for (const source of sources) {
    try {
      patterns.push(new RegExp(source));
    } catch (error: unknown) {
      // One bad pattern does not discard the others. A template with two
      // markers, one of them malformed, still recognises the good one.
      onInvalidPattern?.(source, error);
    }
  }

  // No usable pattern is not the same as no pattern declared, but the daemon
  // can do nothing with either: the container running is the only signal left.
  return patterns.length > 0 ? { type: 'log', patterns, timeoutMs } : { type: 'immediate' };
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
