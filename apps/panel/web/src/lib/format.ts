/**
 * Value formatting.
 *
 * Units keep their international form (B, KiB, MiB): they read the same in
 * every language the panel speaks, and a translated unit would drift from what
 * the daemon logs. The few words that appear here are English, the source
 * language; screens that need them translated pass through `useTranslation`.
 */

const UNITS = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];

/** Formats a limit. 0 means unlimited. */
export function formatBytes(bytes: number): string {
  return bytes === 0 ? '∞' : formatUsedBytes(bytes);
}

/** Formats a measurement, where 0 is a real value rather than a missing limit. */
export function formatUsedBytes(bytes: number): string {
  let value = bytes;
  let unit = 0;

  while (value >= 1024 && unit < UNITS.length - 1) {
    value /= 1024;
    unit += 1;
  }

  return `${value % 1 === 0 ? value : value.toFixed(1)} ${UNITS[unit]}`;
}

/** Percent of one core into a core count. 0 means unlimited. */
export function formatCpu(percent: number): string {
  return percent === 0 ? '∞' : `${(percent / 100).toFixed(percent % 100 === 0 ? 0 : 1)} vCPU`;
}

export function formatDate(iso: string | null, locale = 'en'): string {
  if (!iso) {
    return '—';
  }

  return new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' }).format(
    new Date(iso),
  );
}

/**
 * Container uptime.
 *
 * Leading zero units are dropped, middle ones are not: "2d 0h 5m" reads
 * unambiguously, "2d 5m" reads as five minutes more than there are.
 */
export function formatUptime(milliseconds: number): string {
  if (milliseconds <= 0) {
    return '—';
  }

  const total = Math.floor(milliseconds / 1000);
  const days = Math.floor(total / 86_400);
  const hours = Math.floor((total % 86_400) / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;

  if (days > 0) {
    return `${days}d ${hours}h ${minutes}m`;
  }

  if (hours > 0) {
    return `${hours}h ${minutes}m ${seconds}s`;
  }

  return minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`;
}

/**
 * Address a player connects to.
 *
 * A `0.0.0.0` allocation means "every interface on the machine", not a
 * reachable address: the node hostname is shown instead. An alias, when set,
 * wins over everything — it is the domain the host announces to players.
 */
export function formatAddress(
  allocation: { ip: string; port: number; alias: string | null } | null,
  nodeFqdn?: string,
): string {
  if (!allocation) {
    return '—';
  }

  const wildcard = allocation.ip === '0.0.0.0' || allocation.ip === '::';
  const host = allocation.alias ?? (wildcard ? (nodeFqdn ?? allocation.ip) : allocation.ip);

  return `${host}:${allocation.port}`;
}

const STATUS_LABELS: Record<
  string,
  { label: string; tone: 'online' | 'offline' | 'warn' | 'danger' }
> = {
  INSTALLING: { label: 'Installing', tone: 'warn' },
  INSTALL_FAILED: { label: 'Install failed', tone: 'danger' },
  READY: { label: 'Ready', tone: 'online' },
  SUSPENDED: { label: 'Suspended', tone: 'danger' },
  DELETING: { label: 'Deleting', tone: 'warn' },
  REINSTALLING: { label: 'Reinstalling', tone: 'warn' },
};

/** Stored server status, distinct from the runtime state reported by the daemon. */
export function describeStatus(status: string) {
  // An unknown status is shown as-is rather than hidden: a raw value beats a
  // server with no visible state at all.
  return STATUS_LABELS[status] ?? { label: status, tone: 'offline' as const };
}
