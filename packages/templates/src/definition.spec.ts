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
