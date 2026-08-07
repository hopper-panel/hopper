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
  /**
   * Bytes the container's cgroup has read from and written to block devices.
   *
   * Read only by {@link activityCounters}, and declared with `null` in the union
   * because Docker really does send it: the field is empty rather than absent on
   * a host whose cgroup driver cannot account for I/O, and on some cgroup v2
   * configurations `io_service_bytes_recursive` is `null` while its siblings are
   * arrays. Anything that reads it has to survive that.
   */
  blkio_stats?: {
    io_service_bytes_recursive?: { op?: string; value?: number }[] | null;
  } | null;
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
  // cgroup v2 exposes `inactive_file`, cgroup v1 exposes `cache`.
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

/**
 * The two cumulative counters that say whether a container is doing any work.
 *
 * Cumulative and not rates, which is the property the whole thing rests on: each
 * of these only ever grows, so *any* difference between two samples is work that
 * happened in between, whenever the samples were taken. A reader can therefore
 * poll as rarely as it likes without ever missing activity — only without
 * learning about it promptly — which is what makes a cheap poll a sound basis
 * for a deadline.
 *
 * **Both are cgroup counters, and that is the rule for what belongs here**: the
 * kernel charges them to this container because this container caused them. A
 * third used to sit beside them — `networks[*].rx_bytes` and `tx_bytes` summed —
 * and it had to go, because it is not that kind of number. Those are link-layer
 * counters on the interfaces inside the container's network namespace: they
 * count every frame the interface *accepted*, whoever sent it and whether or not
 * anything in the container ever read it. Every server on a node shares one
 * bridge, a Linux bridge floods broadcast ARP to every port on it, and a `curl`
 * still holding a socket to a mirror that stopped answering keeps sending TCP
 * keepalives, which are on by default. So on a busy node those counters climb
 * for a container that is doing nothing whatsoever, the deadline they feed is
 * pushed back for ever, and the installation that never ends survives — on
 * precisely the nodes where it costs the most. Watching the network did not
 * widen the deadline's coverage, it quietly switched the deadline off.
 *
 * **Coverage does not suffer for it, and the walk is worth writing down** since
 * the loss looks like a hole. A transfer that is moving is not a passive thing:
 * every segment has to be copied off the socket by a `read` in the container and
 * put somewhere by a `write`, and both are charged to this cgroup as CPU time,
 * in nanoseconds — orders of magnitude finer than what a single packet costs, so
 * even a few kilobytes a second separates two samples taken fifteen seconds
 * apart. A transfer that has stalled is a process blocked in the kernel waiting
 * on a socket that says nothing; a task that is not scheduled is charged no CPU
 * and issues no I/O, so both counters stand still for exactly as long as the
 * stall lasts. That is the discrimination the deadline needs, and CPU time alone
 * already makes it.
 *
 * Two rather than one because they are not redundant, and the download nobody
 * thinks of is the demonstration: one whose writes sit in the page cache moves
 * **no** block I/O for as long as the kernel holds them there — up to
 * `dirty_expire_centisecs`, half a minute by default — and under cgroup v1
 * buffered writeback is never charged to the container at all, since the flusher
 * thread does it. Block I/O alone would call that download dead. It earns its
 * place the other way round, on the work that spends its time waiting on a disk
 * rather than on a CPU: a large copy, an unpacking, the `chown -R` this daemon
 * runs over a full volume after an install.
 *
 * The one shape neither counter sees is a script that is deliberately asleep — a
 * `sleep 600` around a wait on some external job. That is not a gap: a container
 * asleep is inactive by the definition this whole deadline is built on, and a
 * template that knows its script idles says so through
 * `install.inactivityTimeoutMs`.
 *
 * Absent fields read as 0 rather than as a break in the series, because 0 is
 * what Docker means by them: no I/O accounted for on this host. That a whole
 * counter reads 0 for the life of a container is fine — it simply never
 * contributes a difference, and the other decides.
 */
export interface ActivityCounters {
  /** Nanoseconds of CPU time the container's cgroup has been charged. */
  cpuNanos: number;
  /** Bytes its cgroup has read from and written to block devices. */
  blockIoBytes: number;
}

export function activityCounters(stats: DockerStats): ActivityCounters | null {
  const blockIo = stats.blkio_stats?.io_service_bytes_recursive ?? [];
  const cpuNanos = stats.cpu_stats?.cpu_usage?.total_usage;

  // `null`, not a pair of zeroes, when the host accounts for neither.
  //
  // Folding an absent counter to 0 makes "this host does not report CPU or
  // block I/O" indistinguishable from "this container did nothing" — and the
  // two are opposite answers. On such a host every sample would equal the last
  // one for ever, `countersMoved` would report stillness for ever, and the
  // deadline would kill every installation on the node however hard it was
  // working. A sample the daemon cannot read is the same event as a sample it
  // could not take: not knowing, which the watchdog is careful never to treat
  // as knowing.
  //
  // Either one is enough. A host reporting only CPU is common on cgroup v2
  // without `io` accounting, and CPU alone carries every real install.
  if (cpuNanos === undefined && blockIo.length === 0) {
    return null;
  }

  return {
    cpuNanos: cpuNanos ?? 0,
    // Every operation, not just Read and Write: `Sync`, `Async` and `Total` are
    // the same bytes counted again on cgroup v1, and summing the lot double
    // counts them. That is harmless here and deliberately not corrected for —
    // this figure is never shown to anybody and never compared to a threshold,
    // only to its own previous value, and a consistent over-count changes
    // nothing about whether it moved.
    blockIoBytes: blockIo.reduce((total, entry) => total + (entry?.value ?? 0), 0),
  };
}

/**
 * Whether anything happened between two samples.
 *
 * Inequality rather than "greater than". The counters only ever grow, so in
 * practice the two are the same test — but a counter that somehow went backwards
 * (a cgroup recreated under the container, a Docker bug) would read as *no*
 * activity under `>`, and the cost of that mistake is a working installation
 * killed. Any change at all is movement.
 */
export function countersMoved(before: ActivityCounters, after: ActivityCounters): boolean {
  return before.cpuNanos !== after.cpuNanos || before.blockIoBytes !== after.blockIoBytes;
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
