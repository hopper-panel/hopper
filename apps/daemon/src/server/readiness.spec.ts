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
      asConfig({ readiness: { type: 'port', protocol: 'tcp', delayMs: 5000 } }),
    );

    expect(resolved).toEqual({ type: 'port', role: undefined, protocol: 'tcp', delayMs: 5000 });
  });

  it('names the variable holding the rcon password, never the password', () => {
    // The secret is a template variable resolved against the server's
    // environment at connection time. A readiness strategy carrying the
    // password itself would put it in every configuration payload the panel
    // sends and every log line that printed one.
    const resolved = resolveReadiness(
      asConfig({ readiness: { type: 'rcon', secretVariable: 'RCON_PASSWORD' } }),
    );

    expect(resolved).toEqual({ type: 'rcon', role: undefined, secretVariable: 'RCON_PASSWORD' });
  });
});

describe('announcesReady', () => {
  it('says no for every strategy that is not a log', () => {
    // A port probe and an immediate start are decided elsewhere; a console
    // line must never promote them by accident.
    for (const readiness of [
      { type: 'immediate' as const },
      { type: 'port' as const, protocol: 'tcp' as const, delayMs: 0 },
      { type: 'rcon' as const, secretVariable: 'RCON_PASSWORD' },
      { type: 'unsupported' as const, reason: 'x' },
    ]) {
      expect(announcesReady(readiness, 'Done (1.0s)!')).toBe(false);
    }
  });
});
