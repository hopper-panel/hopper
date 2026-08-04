import { describe, expect, it } from 'vitest';
import { serverConfigurationSchema } from './server-configuration.js';

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
  container: { image: 'ghcr.io/hopper-panel/java:21' },
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
