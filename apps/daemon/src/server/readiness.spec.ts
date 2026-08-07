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

/**
 * A server with a game port and a second one named `rcon`.
 *
 * Every strategy that knocks on something is now resolved against these, so a
 * test that left them out would be exercising a configuration no daemon is
 * ever handed. `rcon` on its own port with the game on another is not an
 * exotic case: it is the ordinary shape of every server that speaks RCON, and
 * the reason ports have names at all.
 */
const ALLOCATIONS = {
  default: { ip: '0.0.0.0', port: 25565 },
  additional: [{ ip: '0.0.0.0', port: 25575, role: 'rcon' }],
};

const asConfig = (fields: Record<string, unknown>) =>
  ({ allocations: ALLOCATIONS, ...fields }) as never;

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
      ip: '0.0.0.0',
      port: 25565,
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
   * A named port is knocked on, at last.
   *
   * `role` was in the contract for two releases and did nothing an operator
   * could use: an allocation was `{ip, port}` with no name to match against,
   * so a strategy naming one was refused outright. Refusing was the right
   * answer to have and the wrong one to keep — it left the single realistic
   * use of the rcon strategy, RCON on its own port and the game on another,
   * with no readiness check at all.
   */
  it.each([
    ['port', { type: 'port' as const, role: 'rcon', protocol: 'tcp' as const, delayMs: 0 }],
    ['rcon', { type: 'rcon' as const, role: 'rcon', secretVariable: 'RCON_PASSWORD' }],
  ])('resolves the %s strategy against the port the role names', (_label, readiness) => {
    const resolved = resolveReadiness(asConfig({ readiness }));

    expect(resolved).toMatchObject({ ip: '0.0.0.0', port: 25575 });
  });

  it.each([
    ['port', { type: 'port' as const, protocol: 'tcp' as const, delayMs: 0 }],
    ['rcon', { type: 'rcon' as const, secretVariable: 'RCON_PASSWORD' }],
  ])('sends a %s strategy naming no role to the primary port', (_label, readiness) => {
    // What every configuration written before names existed asks for, and it
    // has to go on meaning exactly what it always did.
    const resolved = resolveReadiness(asConfig({ readiness }));

    expect(resolved).toMatchObject({ ip: '0.0.0.0', port: 25565 });
  });

  /**
   * The refusal that survives, and has to.
   *
   * A role matching nothing is a template naming a port the operator never
   * created. Reading it as "the primary one then" is the exact failure the old
   * blanket refusal existed to prevent: the daemon would speak the RCON
   * handshake at the game port, fail every two seconds, and at the deadline
   * stop a server that was up and serving players — reported to its operator
   * as a crash.
   */
  it.each([
    ['port', { type: 'port' as const, role: 'query', protocol: 'tcp' as const, delayMs: 0 }],
    ['rcon', { type: 'rcon' as const, role: 'query', secretVariable: 'RCON_PASSWORD' }],
  ])('refuses a %s strategy naming a port this server has not got', (_label, readiness) => {
    const resolved = resolveReadiness(asConfig({ readiness }));

    expect(resolved.type).toBe('unsupported');

    const reason = resolved.type === 'unsupported' ? resolved.reason : '';

    // Named, and pointed at the one place the operator can fix it. A refusal
    // they cannot act on is a hang with an explanation.
    expect(reason).toContain('query');
    expect(reason).toContain('Network');
  });

  it('never matches a role against the primary port', () => {
    // The primary port is reachable by naming nothing, and the contract gives
    // it no field to hold a second name in. A role resolving to it would give
    // one port two names — and the day an operator moved the primary, the name
    // would quietly follow it to a different port.
    const resolved = resolveReadiness(
      asConfig({
        allocations: { default: { ip: '0.0.0.0', port: 25565 }, additional: [] },
        readiness: { type: 'port', role: 'game', protocol: 'tcp', delayMs: 0 },
      }),
    );

    expect(resolved.type).toBe('unsupported');
  });

  it('refuses a UDP probe whichever port it names', () => {
    // The protocol describes the declaration, the role describes the server:
    // a UDP probe is impossible here regardless of which port it points at, so
    // it is refused first and the reason names the strategies that do work.
    const resolved = resolveReadiness(
      asConfig({ readiness: { type: 'port', role: 'rcon', protocol: 'udp', delayMs: 0 } }),
    );

    expect(resolved.type).toBe('unsupported');
    expect(resolved.type === 'unsupported' ? resolved.reason : '').toContain('UDP');
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
      ip: '0.0.0.0',
      port: 25565,
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
      { type: 'port', protocol: 'tcp', ip: '0.0.0.0', port: 25565, delayMs: 0, timeoutMs: null },
    ],
    [
      'rcon',
      { type: 'rcon', secretVariable: 'RCON_PASSWORD' },
      {
        type: 'rcon',
        ip: '0.0.0.0',
        port: 25565,
        secretVariable: 'RCON_PASSWORD',
        timeoutMs: null,
      },
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
      {
        type: 'port' as const,
        protocol: 'tcp' as const,
        ip: '0.0.0.0',
        port: 25565,
        delayMs: 0,
        timeoutMs: 600_000,
      },
      {
        type: 'rcon' as const,
        ip: '0.0.0.0',
        port: 25575,
        secretVariable: 'RCON_PASSWORD',
        timeoutMs: 600_000,
      },
      { type: 'unsupported' as const, reason: 'x' },
    ]) {
      expect(announcesReady(readiness, 'Done (1.0s)!')).toBe(false);
    }
  });
});
