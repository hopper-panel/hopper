import { describe, expect, it, vi } from 'vitest';
import { announcesReady, resolveReadiness } from './readiness.js';

/**
 * When a started server becomes a running one.
 *
 * This was a single regular expression compiled in a constructor and read from
 * two unrelated branches, one of which quietly meant "call it running now".
 * That default was never chosen by anybody: a server whose pattern was
 * malformed, or whose template declared none, went online the moment its
 * container did — which is right for a workload with no notion of ready and
 * wrong for a Minecraft server still loading its world.
 */

const asConfig = (fields: Record<string, unknown>) => fields as never;

describe('resolveReadiness', () => {
  it('reads a legacy startupDetection as a single log pattern', () => {
    // Every imported Pterodactyl egg carries this shape and nothing else. An
    // import that stopped working the day the field moved would be a migration
    // imposed on people who never asked for one.
    const resolved = resolveReadiness(asConfig({ startupDetection: 'Done \\([0-9.]+s\\)!' }));

    expect(resolved.type).toBe('log');
    expect(announcesReady(resolved, '[10:00:00 INFO]: Done (12.4s)! For help, type "help"')).toBe(
      true,
    );
  });

  it('prefers readiness over the deprecated field when both are there', () => {
    const resolved = resolveReadiness(
      asConfig({
        startupDetection: 'never matched',
        readiness: { type: 'immediate' },
      }),
    );

    expect(resolved.type).toBe('immediate');
  });

  it('accepts several patterns, any one of which is enough', () => {
    // Different versions of the same server announce themselves differently,
    // and the egg importer had to throw all but the first away.
    const resolved = resolveReadiness(
      asConfig({ readiness: { type: 'log', patterns: ['Done \\(', 'Server started'] } }),
    );

    expect(announcesReady(resolved, 'Done (3.1s)!')).toBe(true);
    expect(announcesReady(resolved, '[Server thread] Server started on port 25565')).toBe(true);
    expect(announcesReady(resolved, 'Loading libraries, please wait...')).toBe(false);
  });

  it('keeps the good patterns when one of them is malformed', () => {
    // A template regex is data, not code. One bad entry must not discard the
    // one that works.
    const warn = vi.fn();
    const resolved = resolveReadiness(
      asConfig({ readiness: { type: 'log', patterns: ['[unclosed', 'Done \\('] } }),
      warn,
    );

    expect(warn).toHaveBeenCalledOnce();
    expect(announcesReady(resolved, 'Done (3.1s)!')).toBe(true);
  });

  it('falls back to immediate when no pattern survives', () => {
    const resolved = resolveReadiness(
      asConfig({ readiness: { type: 'log', patterns: ['[unclosed'] } }),
      () => undefined,
    );

    expect(resolved.type).toBe('immediate');
  });

  it('treats a template with nothing declared as immediate', () => {
    expect(resolveReadiness(asConfig({})).type).toBe('immediate');
  });

  it('carries the port strategy through with its own defaults', () => {
    const resolved = resolveReadiness(
      asConfig({
        readiness: { type: 'port', protocol: 'tcp', delayMs: 5000, timeoutMs: 600_000 },
      }),
    );

    expect(resolved).toEqual({
      type: 'port',
      protocol: 'tcp',
      delayMs: 5000,
      timeoutMs: 600_000,
    });
  });

  it('refuses a UDP port probe rather than knocking on TCP instead', () => {
    // A TCP connect against a UDP game is not a weaker answer, it is a wrong
    // one: nothing listens on the TCP port, so the probe fails for the whole
    // timeout while the server is up and taking players. There is no real UDP
    // probe to fall back on either — a closed connectionless port refuses
    // nothing, and the ICMP that says so needs a raw socket the daemon has no
    // capability for.
    const resolved = resolveReadiness(
      asConfig({ readiness: { type: 'port', protocol: 'udp', delayMs: 0, timeoutMs: 600_000 } }),
    );

    expect(resolved.type).toBe('unsupported');
  });

  it('names the strategies that do work when it refuses UDP', () => {
    // The refusal reaches the operator through the console, and "unsupported"
    // on its own leaves them with nothing to do about it.
    const resolved = resolveReadiness(
      asConfig({ readiness: { type: 'port', protocol: 'udp', delayMs: 0, timeoutMs: 600_000 } }),
    );

    const reason = resolved.type === 'unsupported' ? resolved.reason : '';

    expect(reason).toContain('log');
    expect(reason).toContain('rcon');
  });

  /**
   * `role` is in the contract and reads as though it works, but an allocation
   * carries no name to match it against. Ignoring it is the dangerous answer:
   * a template naming its RCON port would have the daemon knock on the game
   * port instead and, at the deadline, stop a server that was serving players
   * — reported to its operator as a crash.
   */
  it.each([
    ['port', { type: 'port' as const, role: 'rcon', protocol: 'tcp' as const, delayMs: 0 }],
    ['rcon', { type: 'rcon' as const, role: 'rcon', secretVariable: 'RCON_PASSWORD' }],
  ])(
    'refuses a %s strategy that names a port instead of ignoring the name',
    (_label, readiness) => {
      const resolved = resolveReadiness(asConfig({ readiness }));

      expect(resolved.type).toBe('unsupported');

      const reason = resolved.type === 'unsupported' ? resolved.reason : '';

      expect(reason).toContain('rcon');
      expect(reason).toContain('log');
    },
  );

  it('still resolves a port strategy that names no role', () => {
    const resolved = resolveReadiness(
      asConfig({ readiness: { type: 'port', protocol: 'tcp', delayMs: 0 } }),
    );

    expect(resolved.type).toBe('port');
  });

  it('names the variable holding the rcon password, never the password', () => {
    // The secret is a template variable resolved against the server's
    // environment at connection time. A readiness strategy carrying the
    // password itself would put it in every configuration payload the panel
    // sends and every log line that printed one.
    const resolved = resolveReadiness(
      asConfig({ readiness: { type: 'rcon', secretVariable: 'RCON_PASSWORD', timeoutMs: 60_000 } }),
    );

    expect(resolved).toEqual({
      type: 'rcon',
      secretVariable: 'RCON_PASSWORD',
      timeoutMs: 60_000,
    });
  });

  it('carries the declared deadline through for a log strategy', () => {
    const resolved = resolveReadiness(
      asConfig({ readiness: { type: 'log', patterns: ['Done \\('], timeoutMs: 90_000 } }),
    );

    expect(resolved).toEqual({ type: 'log', patterns: [/Done \(/], timeoutMs: 90_000 });
  });

  it('gives a legacy startupDetection no deadline at all', () => {
    // These configurations were written when the daemon waited for ever. A
    // modded pack that spends a quarter of an hour loading its world would be
    // stopped mid-start by a timeout nobody chose, which is a migration
    // imposed on every installation that never asked for one.
    const resolved = resolveReadiness(asConfig({ startupDetection: 'Done \\(' }));

    expect(resolved).toEqual({ type: 'log', patterns: [/Done \(/], timeoutMs: null });
  });

  it.each([
    [
      'log',
      { type: 'log', patterns: ['Done \\('] },
      { type: 'log', patterns: [/Done \(/], timeoutMs: null },
    ],
    [
      'port',
      { type: 'port', protocol: 'tcp', delayMs: 0 },
      { type: 'port', role: undefined, protocol: 'tcp', delayMs: 0, timeoutMs: null },
    ],
    [
      'rcon',
      { type: 'rcon', secretVariable: 'RCON_PASSWORD' },
      { type: 'rcon', role: undefined, secretVariable: 'RCON_PASSWORD', timeoutMs: null },
    ],
  ])('gives a %s strategy that names no deadline none at all', (_type, readiness, expected) => {
    // A deadline is what makes a start capable of failing: reaching it stops
    // the server and reports the stop as one nobody asked for. Only a template
    // that asked for that gets it, which is what keeps every egg imported
    // before deadlines existed behaving as it always has — an egg says nothing
    // whatever about how long its game takes to load.
    expect(resolveReadiness(asConfig({ readiness }))).toEqual(expected);
  });
});

describe('announcesReady', () => {
  it('says no for every strategy that is not a log', () => {
    // A port probe and an immediate start are decided elsewhere; a console
    // line must never promote them by accident.
    for (const readiness of [
      { type: 'immediate' as const },
      { type: 'port' as const, protocol: 'tcp' as const, delayMs: 0, timeoutMs: 600_000 },
      { type: 'rcon' as const, secretVariable: 'RCON_PASSWORD', timeoutMs: 600_000 },
      { type: 'unsupported' as const, reason: 'x' },
    ]) {
      expect(announcesReady(readiness, 'Done (1.0s)!')).toBe(false);
    }
  });
});
