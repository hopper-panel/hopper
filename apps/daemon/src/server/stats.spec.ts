import { describe, expect, it } from 'vitest';
import {
  activityCounters,
  calculateCpuPercent,
  calculateMemoryBytes,
  calculateNetwork,
  countersMoved,
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

/**
 * The two counters the install deadline is built on.
 *
 * They are read from the same samples the panel's resource graphs are drawn
 * from, deliberately: the daemon already streams `docker stats`, and a second
 * mechanism for asking the same question would be a second thing to keep true.
 *
 * Only the two, and the interfaces' byte counters are the ones left out. Those
 * count frames an interface *accepted* inside the container's netns — broadcast
 * ARP flooded across the bridge every server on the node shares, TCP keepalives
 * on a socket to a mirror that stopped answering — rather than work this
 * container did, so on a busy node they climb for a container that is doing
 * nothing at all. A deadline pushed back by them never fires, which is the
 * original bug wearing a hat.
 */
describe('activityCounters', () => {
  it('adds every block operation together and counts the CPU time', () => {
    const stats: DockerStats = {
      cpu_stats: { cpu_usage: { total_usage: 1_500 } },
      blkio_stats: {
        io_service_bytes_recursive: [
          { op: 'read', value: 4_096 },
          { op: 'write', value: 8_192 },
        ],
      },
    };

    expect(activityCounters(stats)).toEqual({ cpuNanos: 1_500, blockIoBytes: 12_288 });
  });

  // The counter this deliberately cannot see. A container whose interface is
  // taking the bridge's broadcast traffic and nothing else has done no work, and
  // must read exactly as still as one with no interface at all.
  it('takes no notice of what the interfaces received', () => {
    // Interface traffic and nothing else reads as a host that accounts for
    // neither counter, which is `null` — not as a container standing still.
    expect(
      activityCounters({ networks: { eth0: { rx_bytes: 4_000_000, tx_bytes: 12_000 } } }),
    ).toBeNull();
  });

  it('reads a host that keeps only one of the two', () => {
    // Common on cgroup v2 without `io` accounting. Either counter alone is
    // enough, and CPU alone carries every real installation.
    expect(activityCounters({ cpu_stats: { cpu_usage: { total_usage: 42 } } })).toEqual({
      cpuNanos: 42,
      blockIoBytes: 0,
    });
  });

  /**
   * Docker really does send these empty, and on some cgroup v2 hosts sends
   * `io_service_bytes_recursive` as `null` while its siblings are arrays. A
   * throw here would be an exception inside a timer with nobody to catch it, and
   * the deadline it feeds would stop being reset.
   */
  it('survives a host that accounts for none of it', () => {
    // `null` rather than a pair of zeroes, and the difference decides whether
    // installations run on such a host at all. Folded to zero, every sample
    // equals the last one for ever, the deadline reads perpetual stillness, and
    // it kills every installation on the node however hard each is working.
    expect(activityCounters({})).toBeNull();
    expect(activityCounters({ blkio_stats: { io_service_bytes_recursive: null } })).toBeNull();
  });
});

describe('countersMoved', () => {
  const still = { cpuNanos: 10, blockIoBytes: 30 };

  it('sees nothing in two identical samples', () => {
    expect(countersMoved(still, { ...still })).toBe(false);
  });

  // Each covers a way of being busy the other misses: a download whose writes
  // are still in the page cache has touched no disk — under cgroup v1 the
  // writeback is never charged to it at all — while a large copy waiting on a
  // slow disk spends very little of its time on a CPU.
  it.each([
    ['CPU', { cpuNanos: 11 }],
    ['block I/O', { blockIoBytes: 31 }],
  ])('sees movement in %s alone', (_name, moved) => {
    expect(countersMoved(still, { ...still, ...moved })).toBe(true);
  });

  /**
   * These counters only grow, so in practice "changed" and "increased" are the
   * same test — but a counter that somehow went backwards would read as *no*
   * activity under a `>` comparison, and the price of that mistake is a working
   * installation killed. Any change at all is movement.
   */
  it('counts a counter that went backwards as movement', () => {
    expect(countersMoved(still, { ...still, blockIoBytes: 1 })).toBe(true);
  });
});
