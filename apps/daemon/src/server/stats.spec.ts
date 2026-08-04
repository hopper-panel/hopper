import { describe, expect, it } from 'vitest';
import {
  calculateCpuPercent,
  calculateMemoryBytes,
  calculateNetwork,
  emptyUsage,
  type DockerStats,
} from './stats.js';

/**
 * Docker's samples are counters cumulative since boot: the reference values
 * below are therefore deliberately non-zero. A zero in
 * `precpu_stats.system_cpu_usage`, in contrast, signals the absence of a
 * previous sample, which the computation handles separately.
 */
function sample(overrides: {
  cpu: number;
  previousCpu: number;
  system: number;
  previousSystem: number;
  cores?: number;
}): DockerStats {
  return {
    cpu_stats: {
      cpu_usage: { total_usage: overrides.cpu },
      system_cpu_usage: overrides.system,
      online_cpus: overrides.cores,
    },
    precpu_stats: {
      cpu_usage: { total_usage: overrides.previousCpu },
      system_cpu_usage: overrides.previousSystem,
    },
  };
}

describe('calculateCpuPercent', () => {
  it('reads 100% for one fully consumed core', () => {
    // 1 ms of container CPU out of 8 ms of host CPU, 8 cores: one full core.
    const stats = sample({
      cpu: 2_000_000,
      previousCpu: 1_000_000,
      system: 16_000_000,
      previousSystem: 8_000_000,
      cores: 8,
    });

    expect(calculateCpuPercent(stats)).toBe(100);
  });

  // On a 16-core machine, a server occupying two has to show 200, not 12.5:
  // that is what the operator compares to its CPU limit.
  it('goes past 100% beyond one core', () => {
    const stats = sample({
      cpu: 3_000_000,
      previousCpu: 1_000_000,
      system: 16_000_000,
      previousSystem: 8_000_000,
      cores: 8,
    });

    expect(calculateCpuPercent(stats)).toBe(200);
  });

  // The first sample has no predecessor: Docker sends `precpu_stats` at zero.
  // Without this special case, the container's CPU time since launch would be
  // compared to the machine's CPU time since boot, which looks like a
  // percentage without being one.
  it('returns 0 on the first sample, for want of a predecessor', () => {
    const stats: DockerStats = {
      cpu_stats: { cpu_usage: { total_usage: 1_000_000 }, system_cpu_usage: 8_000_000 },
      precpu_stats: {},
    };

    expect(calculateCpuPercent(stats)).toBe(0);
  });

  it('returns 0 when Docker sends a zeroed predecessor', () => {
    const stats = sample({
      cpu: 1_000_000,
      previousCpu: 0,
      system: 8_000_000,
      previousSystem: 0,
      cores: 8,
    });

    expect(calculateCpuPercent(stats)).toBe(0);
  });

  it('returns 0 on identical samples', () => {
    const stats = sample({
      cpu: 500,
      previousCpu: 500,
      system: 1000,
      previousSystem: 1000,
      cores: 4,
    });

    expect(calculateCpuPercent(stats)).toBe(0);
  });

  it('does not crash on an incomplete response', () => {
    expect(calculateCpuPercent({})).toBe(0);
  });

  it('infers the core count from percpu_usage as a fallback', () => {
    const stats: DockerStats = {
      cpu_stats: {
        cpu_usage: { total_usage: 2_000_000, percpu_usage: [1, 2, 3, 4] },
        system_cpu_usage: 8_000_000,
      },
      precpu_stats: { cpu_usage: { total_usage: 1_000_000 }, system_cpu_usage: 4_000_000 },
    };

    expect(calculateCpuPercent(stats)).toBe(100);
  });
});

describe('calculateMemoryBytes', () => {
  // Without this subtraction, a server shows "100% of RAM" as soon as it has
  // read its map, when the kernel would release that cache at the slightest
  // pressure.
  it('subtracts the reclaimable page cache (cgroup v2)', () => {
    const stats: DockerStats = {
      memory_stats: { usage: 4 * 1024 ** 3, stats: { inactive_file: 1024 ** 3 } },
    };

    expect(calculateMemoryBytes(stats)).toBe(3 * 1024 ** 3);
  });

  it('subtracts the cache (cgroup v1)', () => {
    const stats: DockerStats = {
      memory_stats: { usage: 2 * 1024 ** 3, stats: { cache: 512 * 1024 ** 2 } },
    };

    expect(calculateMemoryBytes(stats)).toBe(2 * 1024 ** 3 - 512 * 1024 ** 2);
  });

  it('returns the raw usage with no cache detail', () => {
    expect(calculateMemoryBytes({ memory_stats: { usage: 1000 } })).toBe(1000);
  });

  it('never goes below zero', () => {
    const stats: DockerStats = { memory_stats: { usage: 100, stats: { cache: 500 } } };
    expect(calculateMemoryBytes(stats)).toBe(0);
  });

  it('does not crash on an empty response', () => {
    expect(calculateMemoryBytes({})).toBe(0);
  });
});

describe('calculateNetwork', () => {
  it('adds every interface together', () => {
    const stats: DockerStats = {
      networks: {
        eth0: { rx_bytes: 100, tx_bytes: 200 },
        eth1: { rx_bytes: 50, tx_bytes: 25 },
      },
    };

    expect(calculateNetwork(stats)).toEqual({ rx: 150, tx: 225 });
  });

  it('returns zero with no interface', () => {
    expect(calculateNetwork({})).toEqual({ rx: 0, tx: 0 });
  });
});

describe('emptyUsage', () => {
  it('reports an empty sample carrying the state', () => {
    const usage = emptyUsage('offline');

    expect(usage.state).toBe('offline');
    expect(usage.cpuPercent).toBe(0);
    expect(usage.memoryBytes).toBe(0);
    expect(usage.uptime).toBe(0);
  });
});
