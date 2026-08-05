import { describe, expect, it } from 'vitest';
import { createLogger } from './logger.js';

/**
 * Redaction, checked against the logger that actually runs.
 *
 * A daemon that logs a node token hands control of every server on the machine
 * to whoever can read `journalctl`. The list of redacted paths is the only
 * thing standing between an error object and that outcome, and it is enforced
 * entirely by pino — so a pino upgrade can quietly take it away without a
 * single type breaking. Nothing tested this until pino went from 9 to 10.
 *
 * These read the JSON the logger emits, not the arguments it was handed.
 */

function capture(): { lines: string[]; write(chunk: string): void } {
  const lines: string[] = [];

  return {
    lines,
    write(chunk: string) {
      lines.push(chunk);
    },
  };
}

function logOnce(payload: Record<string, unknown>): Record<string, unknown> {
  const destination = capture();

  createLogger(false, destination).info(payload, 'test');

  expect(destination.lines).toHaveLength(1);

  return JSON.parse(destination.lines[0]!) as Record<string, unknown>;
}

describe('createLogger', () => {
  it('redacts a node token', () => {
    const line = logOnce({ tokenSecret: 'hpk_the-real-secret' });

    expect(line.tokenSecret).toBe('[redacted]');
    expect(JSON.stringify(line)).not.toContain('hpk_the-real-secret');
  });

  it('redacts the panel signing key, nested', () => {
    const line = logOnce({ panel: { url: 'https://panel.example', jwtSecret: 'signing-key' } });

    expect((line.panel as Record<string, unknown>).jwtSecret).toBe('[redacted]');
    // The rest of the object survives: redaction that swallowed the context
    // would make the log useless and push someone to turn it off.
    expect((line.panel as Record<string, unknown>).url).toBe('https://panel.example');
  });

  it('redacts an Authorization header wherever it sits', () => {
    const line = logOnce({
      req: { headers: { authorization: 'Bearer abc.def', 'user-agent': 'curl/8' } },
    });

    const request = line.req as { headers: Record<string, unknown> };

    expect(request.headers.authorization).toBe('[redacted]');
    expect(request.headers['user-agent']).toBe('curl/8');
  });

  it('redacts a token one level down through the wildcard', () => {
    // `*.tokenSecret` is what catches a secret arriving inside whatever object
    // the caller happened to name.
    const line = logOnce({ node: { tokenSecret: 'hpk_inside' } });

    expect((line.node as Record<string, unknown>).tokenSecret).toBe('[redacted]');
    expect(JSON.stringify(line)).not.toContain('hpk_inside');
  });

  it('says nothing at debug level unless asked', () => {
    const destination = capture();

    createLogger(false, destination).debug({ tokenSecret: 'never-written' }, 'noisy');

    // A line that is never emitted cannot leak, but the point here is the
    // level: a daemon left at debug in production logs far more than this test
    // covers, which is why it is not the default.
    expect(destination.lines).toHaveLength(0);
  });
});
