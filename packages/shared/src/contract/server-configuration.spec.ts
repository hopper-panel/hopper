import { describe, expect, it } from 'vitest';
import {
  allocationForRole,
  serverAllocationsSchema,
  serverConfigurationSchema,
} from './server-configuration.js';

const MINIMAL = {
  uuid: '3f2504e0-4f89-41d3-9a0c-0305e82c3301',
  meta: { name: 'Survival' },
  invocation: 'java -Xmx{{SERVER_MEMORY}}M -jar {{SERVER_JARFILE}}',
  allocations: { default: { ip: '0.0.0.0', port: 25565 } },
  build: {
    memoryBytes: 4 * 1024 ** 3,
    swapBytes: 0,
    cpuPercent: 200,
    diskBytes: 10 * 1024 ** 3,
  },
  container: { image: 'eclipse-temurin:21-jre-noble' },
  stop: { type: 'command', value: 'stop' },
};

describe('serverConfigurationSchema', () => {
  it('applies the defaults on a minimal configuration', () => {
    const parsed = serverConfigurationSchema.parse(MINIMAL);

    expect(parsed.suspended).toBe(false);
    expect(parsed.meta.description).toBe('');
    expect(parsed.allocations.additional).toEqual([]);
    expect(parsed.configFiles).toEqual([]);
    expect(parsed.fileDenylist).toEqual([]);
    expect(parsed.stopTimeoutSeconds).toBe(30);
    expect(parsed.build.ioWeight).toBe(500);
    expect(parsed.build.oomKillDisabled).toBe(false);
  });

  // With no PID limit, a hostile plugin can fork until the host seizes up.
  it('imposes a process limit by default', () => {
    expect(serverConfigurationSchema.parse(MINIMAL).build.pidsLimit).toBe(512);
  });

  it('refuses a zero process limit', () => {
    const config = { ...MINIMAL, build: { ...MINIMAL.build, pidsLimit: 0 } };
    expect(serverConfigurationSchema.safeParse(config).success).toBe(false);
  });

  it.each([0, 65536, -1, 1.5])('rejects port %s', (port) => {
    const config = { ...MINIMAL, allocations: { default: { ip: '0.0.0.0', port } } };
    expect(serverConfigurationSchema.safeParse(config).success).toBe(false);
  });

  it('refuses an empty startup command', () => {
    expect(serverConfigurationSchema.safeParse({ ...MINIMAL, invocation: '' }).success).toBe(false);
  });

  it('refuses an unknown stop signal', () => {
    const config = { ...MINIMAL, stop: { type: 'signal', value: 'SIGUSR1' } };
    expect(serverConfigurationSchema.safeParse(config).success).toBe(false);
  });

  it('accepts a stop by signal', () => {
    const config = { ...MINIMAL, stop: { type: 'signal', value: 'SIGTERM' } };
    expect(serverConfigurationSchema.parse(config).stop).toEqual({
      type: 'signal',
      value: 'SIGTERM',
    });
  });

  it('refuses a malformed UUID', () => {
    expect(serverConfigurationSchema.safeParse({ ...MINIMAL, uuid: 'survival-1' }).success).toBe(
      false,
    );
  });
});

/**
 * How long the daemon believes a start that never announced itself.
 *
 * The daemon hardcoded ten minutes and gave up in a console line, leaving the
 * server in `starting` for ever. The figure moved into the template because it
 * is a property of the workload — a modded pack loading three hundred mods
 * needs minutes, a dedicated server binding a port needs seconds — and it has
 * no default at all, because giving up now *stops the server*. Declaring a
 * deadline is how a template opts into a start that can fail; declaring none
 * keeps the open-ended wait every server had before this field existed.
 */
describe('readiness deadlines', () => {
  const withReadiness = (readiness: unknown) =>
    serverConfigurationSchema.parse({ ...MINIMAL, readiness }).readiness;

  it.each([
    ['log', { type: 'log', patterns: ['Done \\('] }],
    ['port', { type: 'port' }],
    ['rcon', { type: 'rcon', secretVariable: 'RCON_PASSWORD' }],
  ])('leaves a %s strategy that asked for no deadline without one', (_type, readiness) => {
    // A default here would not be a default: it would be a stop, applied to
    // every template and every already-imported Pterodactyl egg whose author
    // chose no such thing. The other fields still take theirs — a protocol or
    // a delay left out changes nothing about whether the start can fail.
    const parsed = withReadiness(readiness) as Record<string, unknown>;

    expect(parsed.timeoutMs).toBeUndefined();
  });

  it('still fills in the defaults that are not deadlines', () => {
    // Only the deadline lost its default. A protocol or a delay left unsaid
    // changes nothing about whether the start can fail, so the daemon should
    // not have to guess them from an absent key.
    expect(withReadiness({ type: 'port' })).toEqual({
      type: 'port',
      protocol: 'tcp',
      delayMs: 0,
    });
  });

  it('keeps a deadline the template asked for', () => {
    expect(withReadiness({ type: 'port', timeoutMs: 45_000 })).toMatchObject({ timeoutMs: 45_000 });
  });

  // Zero would fail every start on the spot, and a negative figure would mean
  // a deadline already in the past before the container is even created.
  it.each([0, -1, 1.5])('refuses a deadline of %s', (timeoutMs) => {
    expect(
      serverConfigurationSchema.safeParse({ ...MINIMAL, readiness: { type: 'port', timeoutMs } })
        .success,
    ).toBe(false);
  });

  it('refuses a deadline longer than an hour', () => {
    // Past that it is not a deadline any more: the server is back to sitting
    // in `starting` while somebody waits for a spinner to mean something.
    expect(
      serverConfigurationSchema.safeParse({
        ...MINIMAL,
        readiness: { type: 'port', timeoutMs: 3_600_001 },
      }).success,
    ).toBe(false);
  });

  it('asks nothing of an immediate strategy, which waits for nothing', () => {
    expect(withReadiness({ type: 'immediate' })).toEqual({ type: 'immediate' });
  });

  it('still accepts a configuration carrying only the deprecated field', () => {
    // Every shipped template and every imported egg declares this and nothing
    // else. The daemon reads it as a `log` with no deadline.
    const parsed = serverConfigurationSchema.parse({
      ...MINIMAL,
      startupDetection: '\\)! For help, type "help"',
    });

    expect(parsed.startupDetection).toBe('\\)! For help, type "help"');
    expect(parsed.readiness).toBeUndefined();
  });
});

/**
 * A port that has a name.
 *
 * `readiness.role` shipped in two releases meaning nothing: an allocation was
 * `{ip, port}`, so the daemon refused any strategy naming one rather than
 * knock on the game port and stop a healthy server at its deadline. This is
 * the field that makes the name resolvable, and the shape it is allowed to
 * take is the whole of its reliability — it is typed once by whoever names the
 * port and once by whoever writes the template, months apart.
 */
describe('allocation names', () => {
  const withAllocations = (allocations: unknown) =>
    serverConfigurationSchema.safeParse({ ...MINIMAL, allocations });

  it('accepts a named additional port', () => {
    const parsed = withAllocations({
      default: { ip: '0.0.0.0', port: 25565 },
      additional: [{ ip: '0.0.0.0', port: 25575, role: 'rcon' }],
    });

    expect(parsed.success && parsed.data.allocations.additional[0]?.role).toBe('rcon');
  });

  it('leaves an unnamed port with no name at all', () => {
    // Not `null`, not an empty string: absent. Every allocation on every
    // existing installation is this one, and its payload has to be the payload
    // it has always been.
    const parsed = serverConfigurationSchema.parse({
      ...MINIMAL,
      allocations: {
        default: { ip: '0.0.0.0', port: 25565 },
        additional: [{ ip: '0.0.0.0', port: 8123 }],
      },
    });

    expect(JSON.stringify(parsed.allocations.additional)).toBe('[{"ip":"0.0.0.0","port":8123}]');
  });

  it('gives the primary port nowhere to keep a name', () => {
    // One port, one way to name it. The primary is named by being the primary
    // — it is what a strategy naming nothing resolves to — and a second name
    // for it would follow the primary around the moment somebody moved it.
    const parsed = withAllocations({
      default: { ip: '0.0.0.0', port: 25565, role: 'game' },
      additional: [],
    });

    expect(parsed.success && 'role' in parsed.data.allocations.default).toBe(false);
  });

  it.each([
    ['RCON', 'uppercase, when the match is exact'],
    ['voice.udp', 'a dot, which would split {{server.allocations.<role>.port}}'],
    ['rcon-port', 'a separator, which invents a second spelling of one intent'],
    ['rcon_port', 'the other separator, for the same reason'],
    ['2nd', 'a leading digit, in something that becomes a variable name'],
    ['', 'nothing at all'],
    ['a'.repeat(25), 'more characters than anybody will retype correctly'],
  ])('refuses %s — %s', (role) => {
    expect(
      withAllocations({
        default: { ip: '0.0.0.0', port: 25565 },
        additional: [{ ip: '0.0.0.0', port: 25575, role }],
      }).success,
    ).toBe(false);
  });

  it('refuses the same shape on a readiness strategy', () => {
    // The strategy and the allocation are the two ends of one match. A role
    // the panel would refuse to store but a template could declare is a name
    // that can only ever go unmatched.
    expect(
      serverConfigurationSchema.safeParse({
        ...MINIMAL,
        readiness: { type: 'rcon', role: 'RCON', secretVariable: 'RCON_PASSWORD' },
      }).success,
    ).toBe(false);
  });
});

/**
 * Which port a role means.
 *
 * One function, because two lookups written separately would eventually
 * disagree about the fallback — and the disagreement would surface as a daemon
 * probing one port while the server was configured to listen on another.
 */
describe('allocationForRole', () => {
  const ALLOCATIONS = serverAllocationsSchema.parse({
    default: { ip: '0.0.0.0', port: 25565 },
    additional: [
      { ip: '0.0.0.0', port: 25575, role: 'rcon' },
      { ip: '0.0.0.0', port: 8123 },
    ],
  });

  it('reads no name as the primary port', () => {
    // What every configuration written before names existed asks for.
    expect(allocationForRole(ALLOCATIONS, undefined)).toEqual({ ip: '0.0.0.0', port: 25565 });
  });

  it('finds the port carrying the name', () => {
    expect(allocationForRole(ALLOCATIONS, 'rcon')?.port).toBe(25575);
  });

  it('answers nothing for a name no port carries', () => {
    // Nothing, and deliberately not the primary port: the caller has to be
    // able to refuse. Falling back here is precisely the failure the daemon's
    // refusal exists to prevent.
    expect(allocationForRole(ALLOCATIONS, 'query')).toBeUndefined();
  });
});
