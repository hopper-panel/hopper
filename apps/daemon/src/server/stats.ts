import type { ResourceUsage, ServerState } from '@hopper/shared';

/**
 * Extrait de la réponse `docker stats` ce dont on a besoin.
 * Le type complet de Dockerode est très large et surtout optionnel partout :
 * on ne déclare que les champs lus, avec leurs valeurs éventuellement absentes.
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
 * Pourcentage de CPU consommé, exprimé en pourcentage d'un cœur.
 *
 * Docker ne donne pas un pourcentage mais des compteurs cumulés : il faut la
 * différence entre deux relevés. Le premier relevé après le démarrage n'a pas
 * de précédent et vaut donc 0 — c'est normal, pas un bug.
 */
export function calculateCpuPercent(stats: DockerStats): number {
  const previousSystem = stats.precpu_stats?.system_cpu_usage ?? 0;

  // Sans relevé précédent, la différence se ferait contre zéro : on
  // comparerait le temps CPU du conteneur depuis son lancement au temps CPU de
  // la machine depuis son démarrage. Le rapport a l'air d'un pourcentage mais
  // n'en est pas un — mieux vaut afficher 0 que d'inventer une valeur.
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

  // × cores pour que 100 % désigne un cœur saturé : sur une machine à 16 cœurs,
  // un serveur qui en occupe un entier doit afficher 100, pas 6,25.
  return Math.round((cpuDelta / systemDelta) * cores * 10000) / 100;
}

/**
 * Mémoire réellement utilisée.
 *
 * `memory_stats.usage` inclut le cache de pages, qui peut représenter plusieurs
 * gigaoctets après la lecture d'une map Minecraft. L'afficher tel quel donnerait
 * un serveur perpétuellement « à 100 % de sa RAM » alors que le noyau libérerait
 * ce cache à la moindre pression.
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
 * Relevé nul, émis quand le serveur est arrêté.
 *
 * Le disque fait exception : un serveur éteint continue d'occuper sa place, et
 * l'annoncer à zéro laisserait croire que l'arrêt a libéré le volume.
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
