import { serverConfigurationSchema, type ServerConfiguration } from '@hopper/shared';
import { describe, expect, it } from 'vitest';
import {
  buildContainerOptions,
  containerNameFor,
  cpuQuotaFor,
  memorySwapFor,
  portBindingsFor,
} from './container-config.js';

const GIB = 1024 ** 3;

function makeConfiguration(overrides: Record<string, unknown> = {}): ServerConfiguration {
  return serverConfigurationSchema.parse({
    uuid: '3f2504e0-4f89-41d3-9a0c-0305e82c3301',
    meta: { name: 'Survie' },
    invocation: 'java -Xmx{{SERVER_MEMORY}}M -jar {{SERVER_JARFILE}}',
    environment: { SERVER_JARFILE: 'server.jar' },
    allocations: { default: { ip: '0.0.0.0', port: 25565 } },
    build: { memoryBytes: 4 * GIB, swapBytes: 0, cpuPercent: 200, diskBytes: 10 * GIB },
    container: { image: 'ghcr.io/hopper-panel/java:21' },
    stop: { type: 'command', value: 'stop' },
    ...overrides,
  });
}

const OPTIONS = {
  volumePath: '/var/lib/hopper/volumes/3f2504e0-4f89-41d3-9a0c-0305e82c3301',
  networkName: 'hopper0',
  ownership: { uid: 988, gid: 988 },
  timezone: 'Europe/Paris',
};

describe('poids d’E/S', () => {
  // Sans BFQ, le noyau n'expose pas io.weight et le conteneur refuse de
  // démarrer avec une erreur OCI illisible. Le défaut doit donc être « ne rien
  // poser », et non « poser 500 ».
  it("n'est pas appliqué par défaut", () => {
    const options = buildContainerOptions({ configuration: makeConfiguration(), ...OPTIONS });
    expect(options.HostConfig?.BlkioWeight).toBeUndefined();
  });

  it('est appliqué quand l’hôte le supporte', () => {
    const options = buildContainerOptions({
      configuration: makeConfiguration(),
      ...OPTIONS,
      enableBlkioWeight: true,
    });

    expect(options.HostConfig?.BlkioWeight).toBe(500);
  });
});

describe('cpuQuotaFor', () => {
  it('convertit un pourcentage en quota cgroup', () => {
    expect(cpuQuotaFor(100)).toBe(100_000);
    expect(cpuQuotaFor(200)).toBe(200_000);
    expect(cpuQuotaFor(50)).toBe(50_000);
  });

  it('ne pose pas de quota quand le CPU est illimité', () => {
    expect(cpuQuotaFor(0)).toBeUndefined();
    expect(cpuQuotaFor(-1)).toBeUndefined();
  });
});

describe('memorySwapFor', () => {
  // Docker attend mémoire + swap, le panel raisonne en swap additionnel.
  // Confondre les deux donne un serveur qui swappe sans limite.
  it('additionne la mémoire et le swap', () => {
    expect(memorySwapFor(4 * GIB, 2 * GIB)).toBe(6 * GIB);
  });

  it('interdit le swap quand il vaut zéro', () => {
    expect(memorySwapFor(4 * GIB, 0)).toBe(4 * GIB);
  });

  it('rend le swap illimité pour -1', () => {
    expect(memorySwapFor(4 * GIB, -1)).toBe(-1);
  });

  it('ne pose rien quand la mémoire est illimitée', () => {
    expect(memorySwapFor(0, 0)).toBeUndefined();
  });
});

describe('portBindingsFor', () => {
  it('publie le port principal en TCP et en UDP', () => {
    const { exposed, bindings } = portBindingsFor(makeConfiguration());

    expect(Object.keys(exposed).sort()).toEqual(['25565/tcp', '25565/udp']);
    expect(bindings['25565/tcp']).toEqual([{ HostIp: '0.0.0.0', HostPort: '25565' }]);
  });

  it('publie aussi les ports supplémentaires', () => {
    const configuration = makeConfiguration({
      allocations: {
        default: { ip: '0.0.0.0', port: 25565 },
        additional: [{ ip: '0.0.0.0', port: 8123 }],
      },
    });

    expect(Object.keys(portBindingsFor(configuration).exposed).sort()).toEqual([
      '25565/tcp',
      '25565/udp',
      '8123/tcp',
      '8123/udp',
    ]);
  });
});

describe('buildContainerOptions', () => {
  const options = buildContainerOptions({ configuration: makeConfiguration(), ...OPTIONS });

  it('nomme le conteneur de façon prévisible', () => {
    expect(options.name).toBe(containerNameFor('3f2504e0-4f89-41d3-9a0c-0305e82c3301'));
    expect(options.name).toBe('hopper-3f2504e0-4f89-41d3-9a0c-0305e82c3301');
  });

  // Une chaîne serait exécutée par Docker via `/bin/sh -c`, ce qui
  // réintroduirait l'interprétation shell que buildInvocation évite.
  it('passe la commande en tableau, jamais en chaîne', () => {
    expect(Array.isArray(options.Cmd)).toBe(true);
    // 4 Gio de conteneur → 3276 Mio de tas : la marge laissée au hors-tas de la
    // JVM et au cache de pages évite que le noyau ne tue le serveur
    // (voir `heapBudgetMib`).
    expect(options.Cmd).toEqual(['java', '-Xmx3276M', '-jar', 'server.jar']);
  });

  it('monte le volume sur le répertoire de travail', () => {
    expect(options.HostConfig?.Binds).toEqual([`${OPTIONS.volumePath}:/home/container:rw`]);
    expect(options.WorkingDir).toBe('/home/container');
  });

  it('exécute le serveur sous un utilisateur non privilégié', () => {
    expect(options.User).toBe('988:988');
  });

  describe('durcissement', () => {
    it("n'est jamais privilégié", () => {
      expect(options.HostConfig?.Privileged).toBe(false);
    });

    it('abandonne toutes les capabilities', () => {
      expect(options.HostConfig?.CapDrop).toEqual(['ALL']);
    });

    it('interdit l’acquisition de nouveaux privilèges', () => {
      expect(options.HostConfig?.SecurityOpt).toContain('no-new-privileges');
    });

    it('borne le nombre de processus', () => {
      expect(options.HostConfig?.PidsLimit).toBe(512);
    });

    it('ne monte jamais le socket Docker', () => {
      const binds = options.HostConfig?.Binds ?? [];
      expect(binds.some((bind) => bind.includes('docker.sock'))).toBe(false);
    });

    it('ne laisse pas Docker redémarrer le conteneur tout seul', () => {
      expect(options.HostConfig?.RestartPolicy?.Name).toBe('no');
    });

    it('borne /tmp en mémoire', () => {
      expect(options.HostConfig?.Tmpfs?.['/tmp']).toContain('size=128m');
      expect(options.HostConfig?.Tmpfs?.['/tmp']).toContain('nosuid');
    });

    it('borne les journaux Docker', () => {
      const logConfig = options.HostConfig?.LogConfig as
        { Config?: Record<string, string> } | undefined;
      expect(logConfig?.Config?.['max-size']).toBe('5m');
    });
  });

  describe('limites de ressources', () => {
    it('applique la mémoire et le quota CPU', () => {
      expect(options.HostConfig?.Memory).toBe(4 * GIB);
      expect(options.HostConfig?.MemorySwap).toBe(4 * GIB);
      expect(options.HostConfig?.CpuQuota).toBe(200_000);
      expect(options.HostConfig?.CpuPeriod).toBe(100_000);
    });

    it('omet les limites quand elles valent zéro', () => {
      const unlimited = buildContainerOptions({
        configuration: makeConfiguration({
          build: { memoryBytes: 0, swapBytes: 0, cpuPercent: 0, diskBytes: 0 },
        }),
        ...OPTIONS,
      });

      expect(unlimited.HostConfig?.Memory).toBeUndefined();
      expect(unlimited.HostConfig?.CpuQuota).toBeUndefined();
      // La limite de processus, elle, reste toujours posée.
      expect(unlimited.HostConfig?.PidsLimit).toBe(512);
    });
  });

  it('étiquette le conteneur pour la réconciliation au démarrage', () => {
    expect(options.Labels?.['io.hopper.managed']).toBe('true');
    expect(options.Labels?.['io.hopper.server']).toBe('3f2504e0-4f89-41d3-9a0c-0305e82c3301');
  });

  it('ouvre un TTY et stdin pour la console', () => {
    expect(options.Tty).toBe(true);
    expect(options.OpenStdin).toBe(true);
  });

  it('injecte le fuseau horaire et les variables du template', () => {
    expect(options.Env).toContain('TZ=Europe/Paris');
    expect(options.Env).toContain('SERVER_JARFILE=server.jar');
    expect(options.Env).toContain('SERVER_PORT=25565');
  });
});
