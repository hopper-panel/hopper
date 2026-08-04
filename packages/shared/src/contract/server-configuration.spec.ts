import { describe, expect, it } from 'vitest';
import { serverConfigurationSchema } from './server-configuration.js';

const MINIMAL = {
  uuid: '3f2504e0-4f89-41d3-9a0c-0305e82c3301',
  meta: { name: 'Survie' },
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
  it('applique les valeurs par défaut sur une configuration minimale', () => {
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

  // Sans limite de PID, un plugin malveillant peut forker jusqu'à figer l'hôte.
  it('impose une limite de processus par défaut', () => {
    expect(serverConfigurationSchema.parse(MINIMAL).build.pidsLimit).toBe(512);
  });

  it('refuse une limite de processus nulle', () => {
    const config = { ...MINIMAL, build: { ...MINIMAL.build, pidsLimit: 0 } };
    expect(serverConfigurationSchema.safeParse(config).success).toBe(false);
  });

  it.each([0, 65536, -1, 1.5])('refuse le port %s', (port) => {
    const config = { ...MINIMAL, allocations: { default: { ip: '0.0.0.0', port } } };
    expect(serverConfigurationSchema.safeParse(config).success).toBe(false);
  });

  it('refuse une commande de démarrage vide', () => {
    expect(serverConfigurationSchema.safeParse({ ...MINIMAL, invocation: '' }).success).toBe(false);
  });

  it('refuse un signal d’arrêt inconnu', () => {
    const config = { ...MINIMAL, stop: { type: 'signal', value: 'SIGUSR1' } };
    expect(serverConfigurationSchema.safeParse(config).success).toBe(false);
  });

  it('accepte un arrêt par signal', () => {
    const config = { ...MINIMAL, stop: { type: 'signal', value: 'SIGTERM' } };
    expect(serverConfigurationSchema.parse(config).stop).toEqual({
      type: 'signal',
      value: 'SIGTERM',
    });
  });

  it('refuse un UUID mal formé', () => {
    expect(serverConfigurationSchema.safeParse({ ...MINIMAL, uuid: 'survie-1' }).success).toBe(
      false,
    );
  });
});
