import type { ResourceUsage, ServerState } from '@hopper/shared';

/**
 * The part of the `docker stats` response we need.
 * Dockerode's full type is very wide and, above all, optional everywhere: only
 * the fields read are declared, with their possibly absent values.
 */
export interface DockerStats {
  read?: string;
  cpu_stats?: {
    cpu_usage?: { total_usage?: number; percpu_usage?: number[] };
    system_cpu_usage?: number;
    online_cpus?: number;
  };
  precpu_stats?: {
    cpu_usage?: { total_usage?: number };
    system_cpu_usage?: number;
  };
  memory_stats?: {
    usage?: number;
    limit?: number;
    stats?: { cache?: number; inactive_file?: number };
  };
  networks?: Record<string, { rx_bytes?: number; tx_bytes?: number }>;
}

/**
 * CPU consumed, expressed as a percentage of one core.
 *
 * Docker gives no percentage but cumulative counters: the difference between
 * two samples is what is needed. The first sample after startup has no
 * predecessor and is therefore 0 — that is normal, not a bug.
 */
export function calculateCpuPercent(stats: DockerStats): number {
  const previousSystem = stats.precpu_stats?.system_cpu_usage ?? 0;

  // With no previous sample, the difference would be taken against zero: the
  // container's CPU time since launch would be compared to the machine's CPU
  // time since boot. The ratio looks like a percentage but is not one — better
  // to show 0 than to invent a value.
  if (previousSystem === 0) {
    return 0;
  }

  const cpuDelta =
    (stats.cpu_stats?.cpu_usage?.total_usage ?? 0) -
    (stats.precpu_stats?.cpu_usage?.total_usage ?? 0);

  const systemDelta = (stats.cpu_stats?.system_cpu_usage ?? 0) - previousSystem;

  if (cpuDelta <= 0 || systemDelta <= 0) {
    return 0;
  }

  const cores =
    stats.cpu_stats?.online_cpus ?? stats.cpu_stats?.cpu_usage?.percpu_usage?.length ?? 1;

  // × cores so that 100% means one saturated core: on a 16-core machine, a
  // server occupying a whole one has to show 100, not 6.25.
  return Math.round((cpuDelta / systemDelta) * cores * 10000) / 100;
}

/**
 * Memory actually used.
 *
 * `memory_stats.usage` includes the page cache, which can amount to several
 * gigabytes after reading a Minecraft map. Showing it as is would give a server
 * perpetually "at 100% of its RAM" when the kernel would release that cache at
 * the slightest pressure.
 */
export function calculateMemoryBytes(stats: DockerStats): number {
  const usage = stats.memory_stats?.usage ?? 0;
  // cgroup v2 expose `inactive_file`, cgroup v1 expose `cache`.
  const reclaimable =
    stats.memory_stats?.stats?.inactive_file ?? stats.memory_stats?.stats?.cache ?? 0;

  return Math.max(0, usage - reclaimable);
}

export function calculateNetwork(stats: DockerStats): { rx: number; tx: number } {
  const interfaces = Object.values(stats.networks ?? {});

  return interfaces.reduce(
    (totals, entry) => ({
      rx: totals.rx + (entry.rx_bytes ?? 0),
      tx: totals.tx + (entry.tx_bytes ?? 0),
    }),
    { rx: 0, tx: 0 },
  );
}

export function buildResourceUsage(
  stats: DockerStats,
  context: { state: ServerState; startedAt: number | null; diskBytes: number },
): ResourceUsage {
  const network = calculateNetwork(stats);

  return {
    state: context.state,
    uptime: context.startedAt === null ? 0 : Math.max(0, Date.now() - context.startedAt),
    memoryBytes: calculateMemoryBytes(stats),
    memoryLimitBytes: stats.memory_stats?.limit ?? 0,
    cpuPercent: calculateCpuPercent(stats),
    diskBytes: context.diskBytes,
    networkRxBytes: network.rx,
    networkTxBytes: network.tx,
  };
}

/**
 * Empty sample, emitted when the server is stopped.
 *
 * Disk is the exception: a stopped server still takes up its space, and
 * announcing zero would suggest stopping it had freed the volume.
 */
export function emptyUsage(state: ServerState, diskBytes = 0): ResourceUsage {
  return {
    state,
    uptime: 0,
    memoryBytes: 0,
    memoryLimitBytes: 0,
    cpuPercent: 0,
    diskBytes,
    networkRxBytes: 0,
    networkTxBytes: 0,
  };
}
