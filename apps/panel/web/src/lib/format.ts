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

type Tone = 'online' | 'offline' | 'warn' | 'danger';

const STATUSES: Record<string, { key: StatusKey; tone: Tone }> = {
  READY: { key: 'status.ready', tone: 'online' },
  INSTALLING: { key: 'status.installing', tone: 'warn' },
  INSTALL_FAILED: { key: 'status.installFailed', tone: 'danger' },
  SUSPENDED: { key: 'status.suspended', tone: 'danger' },
  DELETING: { key: 'status.deleting', tone: 'warn' },
  REINSTALLING: { key: 'status.reinstalling', tone: 'warn' },
};

type StatusKey =
  | 'status.ready'
  | 'status.installing'
  | 'status.installFailed'
  | 'status.suspended'
  | 'status.deleting'
  | 'status.reinstalling';

/**
 * Stored server status, distinct from the runtime state the daemon reports.
 *
 * Returns a message key rather than a label: the caller translates. An unknown
 * status falls back to "installing" — never to nothing, a server with no
 * visible state at all is worse than a slightly wrong one.
 */
export function describeStatus(status: string): { key: StatusKey; tone: Tone } {
  return STATUSES[status] ?? { key: 'status.installing', tone: 'offline' };
}

/**
 * A download count someone can read at a glance.
 *
 * The catalogue answers with figures like 68699360. Printed in full they are
 * eight characters of noise beside a plugin's name, and nobody compares two of
 * them; what matters is the order of magnitude. `Intl` picks the right suffix
 * per language — "68.7M" in English, "68,7 M" in French.
 */
export function formatCompact(value: number, locale = 'en'): string {
  return new Intl.NumberFormat(locale, {
    notation: 'compact',
    maximumFractionDigits: 1,
  }).format(value);
}
