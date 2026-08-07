import { describe, expect, it } from 'vitest';
import { templateDefinitionSchema } from './definition.js';

/**
 * What a template is allowed to say about readiness.
 *
 * The field arrived long after the shape it belongs to, on top of a catalogue
 * and hundreds of imported eggs that declare a console pattern and nothing
 * else. So the two things worth pinning down are that the new field accepts
 * the strategies the daemon can act on, and that requiring nothing of the
 * templates written before it existed is still true.
 */

const MINIMAL = {
  key: 'test-template',
  group: 'Tests',
  name: 'Test',
  dockerImages: [{ name: 'Java 21', image: 'eclipse-temurin:21-jre-noble' }],
  startup: 'java -jar server.jar',
  installScript: 'set -e\necho ok',
};

describe('templateDefinitionSchema readiness', () => {
  it('accepts a template that declares nothing', () => {
    // The whole shipped catalogue is in this case. A required field would have
    // invalidated every one of them to express something none of them needed.
    const parsed = templateDefinitionSchema.parse(MINIMAL);

    expect(parsed.readiness).toBeUndefined();
  });

  it('keeps startupDetection alongside a readiness strategy', () => {
    // Both travel to the daemon. The deprecated one is what a node running an
    // older daemon reads, and dropping it here would break that node the day
    // its template gained a strategy it cannot understand.
    const parsed = templateDefinitionSchema.parse({
      ...MINIMAL,
      startupDetection: '\\)! For help, type "help"',
      readiness: { type: 'log', patterns: ['Done \\(', 'Server started'] },
    });

    expect(parsed.startupDetection).toBe('\\)! For help, type "help"');
    // And no deadline appears from nowhere. Reaching one stops the server, so
    // a template that named none must not acquire one on the way through this
    // schema — that would be a start that can fail, handed to a catalogue and
    // to hundreds of imported eggs whose authors never asked for it.
    expect(parsed.readiness).toEqual({
      type: 'log',
      patterns: ['Done \\(', 'Server started'],
    });
  });

  it('accepts several patterns, which the deprecated field could not hold', () => {
    const parsed = templateDefinitionSchema.parse({
      ...MINIMAL,
      readiness: { type: 'log', patterns: ['Done \\(', 'Server started'] },
    });

    expect(parsed.readiness).toMatchObject({ patterns: ['Done \\(', 'Server started'] });
  });

  it('fills in the defaults of a port strategy, deadline excepted', () => {
    // A template that names a port and nothing else means TCP, straight away —
    // and waits as long as it takes. The deadline is the one field with no
    // default, because it is the one whose absence cannot hurt anybody and
    // whose presence stops a server.
    const parsed = templateDefinitionSchema.parse({
      ...MINIMAL,
      readiness: { type: 'port' },
    });

    expect(parsed.readiness).toEqual({
      type: 'port',
      protocol: 'tcp',
      delayMs: 0,
    });
  });

  it('keeps a deadline the template chose', () => {
    const parsed = templateDefinitionSchema.parse({
      ...MINIMAL,
      readiness: { type: 'log', patterns: ['Hosting game at'], timeoutMs: 300_000 },
    });

    expect(parsed.readiness).toMatchObject({ timeoutMs: 300_000 });
  });

  it('accepts immediate, which has to be chosen rather than fallen into', () => {
    const parsed = templateDefinitionSchema.parse({
      ...MINIMAL,
      readiness: { type: 'immediate' },
    });

    expect(parsed.readiness).toEqual({ type: 'immediate' });
  });

  it('names the RCON password rather than carrying it', () => {
    const parsed = templateDefinitionSchema.parse({
      ...MINIMAL,
      readiness: { type: 'rcon', secretVariable: 'RCON_PASSWORD' },
    });

    expect(parsed.readiness).toMatchObject({ secretVariable: 'RCON_PASSWORD' });
  });

  it('refuses a strategy nobody implements', () => {
    // A template asking for something the daemon cannot run has to fail here,
    // where the mistake is, and not turn into a server that never starts.
    expect(() =>
      templateDefinitionSchema.parse({ ...MINIMAL, readiness: { type: 'query' } }),
    ).toThrow();
  });

  it('refuses a log strategy with no pattern at all', () => {
    // An empty list is not a strategy, it is a silent "call it running now"
    // wearing the shape of one.
    expect(() =>
      templateDefinitionSchema.parse({ ...MINIMAL, readiness: { type: 'log', patterns: [] } }),
    ).toThrow();
  });
});

/**
 * What a template is allowed to say about stopping.
 *
 * The same arrival problem as readiness, one field later: `stopCommand` is a
 * colon-encoded pair carried by the whole catalogue and every imported egg, and
 * it cannot express a stop with three parts. So the structured field has to be
 * additive in the strictest sense — a template that says nothing about it must
 * parse to exactly what it parsed to before the field existed.
 */
describe('templateDefinitionSchema stop', () => {
  it('leaves a template that declares nothing exactly as it was', () => {
    const parsed = templateDefinitionSchema.parse(MINIMAL);

    expect(parsed.stop).toBeUndefined();
    expect(parsed.stopTimeoutSeconds).toBeUndefined();
    // And still falls back on the pair it always had.
    expect(parsed.stopCommand).toBe('command:stop');
  });

  it('accepts an RCON stop beside the string it falls back to', () => {
    // Both travel. The string is what the panel reads if the structured field
    // is ever cleared, and it is all an older daemon could ever have used.
    const parsed = templateDefinitionSchema.parse({
      ...MINIMAL,
      stopCommand: 'command:quit',
      stop: { type: 'rcon', command: 'quit', role: 'rcon', secretVariable: 'RCON_PASSWORD' },
    });

    expect(parsed.stopCommand).toBe('command:quit');
    expect(parsed.stop).toEqual({
      type: 'rcon',
      command: 'quit',
      role: 'rcon',
      secretVariable: 'RCON_PASSWORD',
    });
  });

  it('refuses an RCON stop with nothing to send or nowhere to get the password', () => {
    // Both would parse into a stop that reaches the server and does nothing,
    // followed by the SIGKILL this transport exists to avoid.
    expect(() =>
      templateDefinitionSchema.parse({
        ...MINIMAL,
        stop: { type: 'rcon', secretVariable: 'RCON_PASSWORD' },
      }),
    ).toThrow();
    expect(() =>
      templateDefinitionSchema.parse({ ...MINIMAL, stop: { type: 'rcon', command: 'quit' } }),
    ).toThrow();
  });

  it('keeps a stop timeout the template chose', () => {
    // The gap this closes: `stopTimeoutSeconds` has been in the contract since
    // the first release with a default of 30 and no way for a template to name
    // anything else, so every server ever created ran on a Bukkit figure.
    expect(
      templateDefinitionSchema.parse({ ...MINIMAL, stopTimeoutSeconds: 240 }).stopTimeoutSeconds,
    ).toBe(240);
  });

  it('refuses a stop timeout the contract would not accept', () => {
    // The same bounds as the contract's own field, checked here so the mistake
    // fails on the template that made it rather than on the server built from
    // it months later.
    expect(() => templateDefinitionSchema.parse({ ...MINIMAL, stopTimeoutSeconds: 0 })).toThrow();
    expect(() => templateDefinitionSchema.parse({ ...MINIMAL, stopTimeoutSeconds: 601 })).toThrow();
  });
});

/**
 * What a template is allowed to say about its own installation.
 *
 * The same additive rule as the two above, and it matters more here than
 * anywhere: an installation is the one operation a server cannot retry
 * automatically, so a field that changes what a silent template means would
 * turn working installs into failed ones on a catalogue nobody edited.
 */
describe('templateDefinitionSchema install guards', () => {
  it('leaves a template that declares neither exactly as it was', () => {
    const parsed = templateDefinitionSchema.parse(MINIMAL);

    // Undefined, not a figure: "this template did not say", which the daemon
    // answers with its own generous window and its own floor of free space.
    expect(parsed.installInactivityTimeoutMs).toBeUndefined();
    expect(parsed.installRequiredDiskBytes).toBeUndefined();
  });

  it('keeps the figures a template chooses', () => {
    const parsed = templateDefinitionSchema.parse({
      ...MINIMAL,
      installInactivityTimeoutMs: 900_000,
      installRequiredDiskBytes: 40 * 1024 ** 3,
    });

    expect(parsed.installInactivityTimeoutMs).toBe(900_000);
    expect(parsed.installRequiredDiskBytes).toBe(42_949_672_960);
  });

  it('refuses figures the contract would not accept', () => {
    // The same bounds as the contract's own fields, checked here so the mistake
    // fails on the template that made it rather than on a node months later —
    // where the symptom is an installation that stops itself for no reason a
    // console line can explain.
    expect(() =>
      templateDefinitionSchema.parse({ ...MINIMAL, installInactivityTimeoutMs: 0 }),
    ).toThrow();
    expect(() =>
      templateDefinitionSchema.parse({ ...MINIMAL, installInactivityTimeoutMs: 7 * 3_600_000 }),
    ).toThrow();
    expect(() =>
      templateDefinitionSchema.parse({ ...MINIMAL, installRequiredDiskBytes: -1 }),
    ).toThrow();
  });
});
