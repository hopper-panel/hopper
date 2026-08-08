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
    meta: { name: 'Survival' },
    invocation: 'java -Xmx{{SERVER_MEMORY}}M -jar {{SERVER_JARFILE}}',
    environment: { SERVER_JARFILE: 'server.jar' },
    allocations: { default: { ip: '0.0.0.0', port: 25565 } },
    build: { memoryBytes: 4 * GIB, swapBytes: 0, cpuPercent: 200, diskBytes: 10 * GIB },
    container: { image: 'eclipse-temurin:21-jre-noble' },
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

describe('I/O weight', () => {
  // Without BFQ the kernel does not expose io.weight and the container
  // refuses to start with an unreadable OCI error. The default therefore has to
  // be "set nothing", not "set 500".
  it('is not applied by default', () => {
    const options = buildContainerOptions({ configuration: makeConfiguration(), ...OPTIONS });
    expect(options.HostConfig?.BlkioWeight).toBeUndefined();
  });

  it('is applied when the host supports it', () => {
    const options = buildContainerOptions({
      configuration: makeConfiguration(),
      ...OPTIONS,
      enableBlkioWeight: true,
    });

    expect(options.HostConfig?.BlkioWeight).toBe(500);
  });
});

describe('cpuQuotaFor', () => {
  it('converts a percentage into a cgroup quota', () => {
    expect(cpuQuotaFor(100)).toBe(100_000);
    expect(cpuQuotaFor(200)).toBe(200_000);
    expect(cpuQuotaFor(50)).toBe(50_000);
  });

  it('sets no quota when the CPU is unlimited', () => {
    expect(cpuQuotaFor(0)).toBeUndefined();
    expect(cpuQuotaFor(-1)).toBeUndefined();
  });
});

describe('memorySwapFor', () => {
  // Docker expects memory + swap, the panel thinks in additional swap.
  // Confusing the two gives a server that swaps without limit.
  it('adds the memory and the swap together', () => {
    expect(memorySwapFor(4 * GIB, 2 * GIB)).toBe(6 * GIB);
  });

  it('forbids swap when it is zero', () => {
    expect(memorySwapFor(4 * GIB, 0)).toBe(4 * GIB);
  });

  it('makes swap unlimited for -1', () => {
    expect(memorySwapFor(4 * GIB, -1)).toBe(-1);
  });

  it('sets nothing when the memory is unlimited', () => {
    expect(memorySwapFor(0, 0)).toBeUndefined();
  });
});

describe('portBindingsFor', () => {
  it('publishes the primary port in TCP and UDP', () => {
    const { exposed, bindings } = portBindingsFor(makeConfiguration());

    expect(Object.keys(exposed).sort()).toEqual(['25565/tcp', '25565/udp']);
    expect(bindings['25565/tcp']).toEqual([{ HostIp: '0.0.0.0', HostPort: '25565' }]);
  });

  it('publishes the additional ports too', () => {
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

  it('names the container predictably', () => {
    expect(options.name).toBe(containerNameFor('3f2504e0-4f89-41d3-9a0c-0305e82c3301'));
    expect(options.name).toBe('hopper-3f2504e0-4f89-41d3-9a0c-0305e82c3301');
  });

  // A string would be run by Docker through `/bin/sh -c`, which would
  // reintroduce the shell interpretation buildInvocation avoids.
  it('passes the command as an array, never as a string', () => {
    expect(Array.isArray(options.Cmd)).toBe(true);
    // A 4 GiB container → a 3276 MiB heap: the headroom left to the JVM's
    // off-heap and to the page cache stops the kernel from killing the server
    // (see `heapBudgetMib`).
    expect(options.Cmd).toEqual(['java', '-Xmx3276M', '-jar', 'server.jar']);
  });

  it('mounts the volume on the working directory', () => {
    expect(options.HostConfig?.Binds).toEqual([`${OPTIONS.volumePath}:/home/container:rw`]);
    expect(options.WorkingDir).toBe('/home/container');
  });

  it('runs the server as an unprivileged user', () => {
    expect(options.User).toBe('988:988');
  });

  // The JVM must never be PID 1. A PID 1 does not adopt orphan processes, so
  // every subprocess a plugin spawns and abandons stays a zombie until
  // `PidsLimit` is reached and the server can no longer create a thread — a
  // symptom that appears hours later and looks nothing like its cause.
  //
  // This used to come from a tini baked into an image built in this repository.
  // Docker supplies the same binary, which is what made that image unnecessary.
  it('asks Docker for an init process', () => {
    expect(options.HostConfig?.Init).toBe(true);
  });

  describe('hardening', () => {
    it('is never privileged', () => {
      expect(options.HostConfig?.Privileged).toBe(false);
    });

    it('drops every capability', () => {
      expect(options.HostConfig?.CapDrop).toEqual(['ALL']);
    });

    it('forbids acquiring new privileges', () => {
      expect(options.HostConfig?.SecurityOpt).toContain('no-new-privileges');
    });

    it('bounds the number of processes', () => {
      expect(options.HostConfig?.PidsLimit).toBe(512);
    });

    it('never mounts the Docker socket', () => {
      const binds = options.HostConfig?.Binds ?? [];
      expect(binds.some((bind) => bind.includes('docker.sock'))).toBe(false);
    });

    /**
     * The half of "isolated except its allocated ports" that lives here.
     *
     * The other half is the network's own `enable_icc=false`, checked in
     * `client.spec.ts`, and it protects nothing at all if the container is not
     * on that network to begin with: Docker's default is `bridge`, where every
     * container sees every other whatever `hopper0` was created with. Every
     * neighbouring property in this block had a test and this one did not,
     * which for a default that applies itself when the field is dropped is the
     * wrong way round.
     */
    it('attaches the server to the dedicated network, not to Docker default bridge', () => {
      expect(options.HostConfig?.NetworkMode).toBe('hopper0');
      expect(['bridge', 'host', 'default']).not.toContain(options.HostConfig?.NetworkMode);
    });

    /**
     * And nothing is published that the panel did not allocate.
     *
     * `portBindingsFor` above already pins the exact set for one, two and named
     * allocations; this pins the join — what the container is *built* with is
     * that set and no more. A port a plugin opens for itself is reachable from
     * inside the container and from nowhere else, and that sentence is only
     * true while these two agree.
     */
    it('publishes the allocations and nothing else', () => {
      const configuration = makeConfiguration({
        allocations: {
          default: { ip: '0.0.0.0', port: 25565 },
          additional: [{ ip: '127.0.0.1', port: 25575, role: 'rcon' }],
        },
      });

      const built = buildContainerOptions({ configuration, ...OPTIONS });
      const { exposed, bindings } = portBindingsFor(configuration);

      expect(built.ExposedPorts).toEqual(exposed);
      expect(built.HostConfig?.PortBindings).toEqual(bindings);
      expect(Object.keys(bindings).sort()).toEqual([
        '25565/tcp',
        '25565/udp',
        '25575/tcp',
        '25575/udp',
      ]);
      // The address is the allocation's own: an RCON port allocated on the
      // loopback is published there and not on every interface of the host.
      expect(bindings['25575/tcp']).toEqual([{ HostIp: '127.0.0.1', HostPort: '25575' }]);
    });

    it('does not let Docker restart the container on its own', () => {
      expect(options.HostConfig?.RestartPolicy?.Name).toBe('no');
    });

    it('bounds /tmp in memory', () => {
      expect(options.HostConfig?.Tmpfs?.['/tmp']).toContain('size=128m');
      expect(options.HostConfig?.Tmpfs?.['/tmp']).toContain('nosuid');
    });

    it('bounds the Docker logs', () => {
      const logConfig = options.HostConfig?.LogConfig as
        { Config?: Record<string, string> } | undefined;
      expect(logConfig?.Config?.['max-size']).toBe('5m');
    });
  });

  describe('resource limits', () => {
    it('applies the memory and the CPU quota', () => {
      expect(options.HostConfig?.Memory).toBe(4 * GIB);
      expect(options.HostConfig?.MemorySwap).toBe(4 * GIB);
      expect(options.HostConfig?.CpuQuota).toBe(200_000);
      expect(options.HostConfig?.CpuPeriod).toBe(100_000);
    });

    it('omits the limits when they are zero', () => {
      const unlimited = buildContainerOptions({
        configuration: makeConfiguration({
          build: { memoryBytes: 0, swapBytes: 0, cpuPercent: 0, diskBytes: 0 },
        }),
        ...OPTIONS,
      });

      expect(unlimited.HostConfig?.Memory).toBeUndefined();
      expect(unlimited.HostConfig?.CpuQuota).toBeUndefined();
      // The process limit, in contrast, is always set.
      expect(unlimited.HostConfig?.PidsLimit).toBe(512);
    });
  });

  it('labels the container for reconciliation at startup', () => {
    expect(options.Labels?.['io.hopper.managed']).toBe('true');
    expect(options.Labels?.['io.hopper.server']).toBe('3f2504e0-4f89-41d3-9a0c-0305e82c3301');
  });

  it('opens a TTY and stdin for the console', () => {
    expect(options.Tty).toBe(true);
    expect(options.OpenStdin).toBe(true);
  });

  it('injects the time zone and the template variables', () => {
    expect(options.Env).toContain('TZ=Europe/Paris');
    expect(options.Env).toContain('SERVER_JARFILE=server.jar');
    expect(options.Env).toContain('SERVER_PORT=25565');
  });

  /**
   * A startup command that names one of the server's ports.
   *
   * The three cases a template author meets, in the order they meet them: the
   * port is named and the command is built; the port is not named and nothing
   * is started; the value is empty and the argument goes, out loud.
   */
  describe('a command that names a port', () => {
    const withRcon = makeConfiguration({
      invocation: './factorio --port {{SERVER_PORT}} --rcon-port {{server.allocations.rcon.port}}',
      allocations: {
        default: { ip: '0.0.0.0', port: 34197 },
        additional: [{ ip: '0.0.0.0', port: 27015, role: 'rcon' }],
      },
    });

    it('resolves the name to the port the operator gave it', () => {
      const built = buildContainerOptions({ configuration: withRcon, ...OPTIONS });

      expect(built.Cmd).toEqual(['./factorio', '--port', '34197', '--rcon-port', '27015']);
    });

    it('publishes both ports, whether or not one is named', () => {
      expect(Object.keys(portBindingsFor(withRcon).exposed).sort()).toEqual([
        '27015/tcp',
        '27015/udp',
        '34197/tcp',
        '34197/udp',
      ]);
    });

    it('builds no container at all when the server has no such port', () => {
      // `--rcon-port` would otherwise be left holding `--port`, and the game
      // would start with no port of its own. Nothing is created, and the
      // refusal carries the name that went unmatched.
      const unnamed = makeConfiguration({
        invocation: withRcon.invocation,
        allocations: { default: { ip: '0.0.0.0', port: 34197 }, additional: [] },
      });

      expect(() => buildContainerOptions({ configuration: unnamed, ...OPTIONS })).toThrow(/rcon/);
    });

    it('says which argument it dropped when a variable is set and empty', () => {
      const warnings: string[] = [];

      const built = buildContainerOptions({
        configuration: makeConfiguration({
          invocation: 'java {{JAVA_FLAGS}} -jar {{SERVER_JARFILE}}',
          environment: { SERVER_JARFILE: 'server.jar', JAVA_FLAGS: '' },
        }),
        ...OPTIONS,
        onWarning: (message) => warnings.push(message),
      });

      // The argv is what it has always been for an empty `{{JAVA_FLAGS}}` —
      // half the imported eggs depend on that — and the operator is now told
      // that the command they read in the panel is not quite the one running.
      expect(built.Cmd).toEqual(['java', '-jar', 'server.jar']);
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain('{{JAVA_FLAGS}}');
    });
  });
});
