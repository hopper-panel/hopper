import type { Permission, PowerAction, ResourceUsage } from '@hopper/shared';
import { useEffect, useState, type ReactNode } from 'react';
import { Console } from '../components/Console';
import { CHART_POINTS, ResourceChart } from '../components/ResourceChart';
import {
  AddressIcon,
  ClockIcon,
  CpuIcon,
  DiskIcon,
  DownloadIcon,
  MemoryIcon,
  UploadIcon,
} from '../components/icons';
import { Button } from '../components/ui';
import { useTranslation, type MessageKey } from '../i18n';
import { copyText } from '../lib/clipboard';
import { cx } from '../lib/cx';
import { formatAddress, formatBytes, formatUptime, formatUsedBytes } from '../lib/format';
import { useServerContext } from '../lib/server-context';
import { useUsageHistory, type ConsoleController } from '../lib/use-console';

const POWER_PERMISSIONS: Record<PowerAction, Permission> = {
  start: 'control.start',
  restart: 'control.restart',
  stop: 'control.stop',
  kill: 'control.stop',
};

/**
 * How long a stop is given before Kill is offered in its place.
 *
 * The daemon already escalates on its own: it waits `stopTimeoutSeconds` — 30
 * by default — then sends SIGKILL itself. So a server still stopping past that
 * window is one whose own escalation did not take, which is the only situation
 * where a person killing it by hand adds anything.
 *
 * The margin covers the SIGKILL and the state change finding its way back
 * through the WebSocket. The front does not receive the configured value; if
 * that default moves, this moves with it.
 */
const KILL_OFFERED_AFTER_MS = 45_000;

/**
 * Milliseconds spent in `stopping`, or null outside that state.
 *
 * A ticking clock rather than a timer armed on the click: the console survives
 * tab changes and reconnections, so a timer tied to the button would be lost
 * the moment someone looked at another tab.
 *
 * It counts from when this page *noticed* the state, not from when the stop
 * began — the daemon reports the state but not when it was entered. Opening the
 * console on a server that has been stuck for five minutes therefore still
 * waits the full delay. Fixing that means carrying the timestamp in the state
 * message, which is a change to the panel↔daemon contract.
 */
function useStoppingFor(state: string): number | null {
  const [since, setSince] = useState<number | null>(null);
  const [, tick] = useState(0);

  useEffect(() => {
    if (state !== 'stopping') {
      setSince(null);
      return;
    }

    setSince((current) => current ?? Date.now());

    // One second is enough: the threshold is counted in tens of seconds, and a
    // faster interval would re-render the page under a live console for
    // nothing.
    const timer = setInterval(() => tick((value) => value + 1), 1000);
    return () => clearInterval(timer);
  }, [state]);

  return since === null ? null : Date.now() - since;
}

/** Curve colours, read from the theme rather than hard-coded. */
const PRIMARY_LINE = 'var(--color-accent)';
const SECONDARY_LINE = 'var(--color-online)';

export function ServerDetailPage() {
  // The server, its permissions and the console come from `ServerLayout`:
  // this page is now one tab among others and reloads nothing.
  const { server, controller, can } = useServerContext();
  const { t } = useTranslation();
  // A local subscription: the other tabs no longer re-render at the rate of
  // the daemon's samples.
  const history = useUsageHistory(controller, CHART_POINTS);
  const usage = history.at(-1) ?? null;

  const busy = controller.state === 'starting' || controller.state === 'stopping';
  const unlimited = '∞';

  // Kill is not a button of its own any more. Offered permanently it gets
  // clicked instead of Stop — it is quicker and it always works — and every
  // such click is a world saved to disk in whatever state it was in. It now
  // replaces Stop, and only once Stop has visibly failed.
  const stoppingFor = useStoppingFor(controller.state);
  const stopIsStuck = stoppingFor !== null && stoppingFor > KILL_OFFERED_AFTER_MS;

  return (
    <>
      <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-semibold text-content">{server.name}</h1>

        <div className="flex flex-wrap gap-2">
          <PowerButton
            action="start"
            label="console.start"
            controller={controller}
            can={can}
            variant="primary"
            disabled={busy || controller.state === 'running'}
          />
          <PowerButton
            action="restart"
            label="console.restart"
            controller={controller}
            can={can}
            disabled={busy || controller.state === 'offline'}
          />
          {stopIsStuck ? (
            <PowerButton
              action="kill"
              label="console.kill"
              controller={controller}
              can={can}
              variant="danger"
              disabled={false}
              // A SIGKILL during a region save corrupts the map: this asks for
              // confirmation rather than exposing an ordinary button.
              confirm="console.killConfirm"
            />
          ) : (
            <PowerButton
              action="stop"
              label="console.stop"
              controller={controller}
              can={can}
              variant="danger"
              disabled={busy || controller.state === 'offline'}
            />
          )}
        </div>
      </div>

      <div className="grid gap-4 lg:grid-cols-4">
        <div className="lg:col-span-3">
          <Console controller={controller} />
        </div>

        {/* One card per measurement. The node, template and server id moved to
            the Settings tab: they never change, and took the room of what one
            actually comes here to watch.

            The column stretches to the console height — a grid item already
            does — and `flex-1` shares that height between the cards. */}
        <div className="flex flex-col gap-3">
          <Stat
            icon={<AddressIcon />}
            label={t('console.address')}
            value={formatAddress(server.primaryAllocation, server.node.fqdn)}
            mono
            copyable
          />
          <Stat
            icon={<ClockIcon />}
            label={t('console.uptime')}
            value={usage ? formatUptime(usage.uptime) : '—'}
          />
          <Stat
            icon={<CpuIcon />}
            label={t('console.cpu')}
            value={usage ? `${usage.cpuPercent.toFixed(2)} %` : '—'}
            limit={server.cpuPercent === 0 ? unlimited : `${server.cpuPercent} %`}
          />
          <Stat
            icon={<MemoryIcon />}
            label={t('console.memory')}
            value={usage ? formatUsedBytes(usage.memoryBytes) : '—'}
            limit={server.memoryBytes === 0 ? unlimited : formatBytes(server.memoryBytes)}
          />
          <Stat
            icon={<DiskIcon />}
            label={t('console.disk')}
            value={usage ? formatUsedBytes(usage.diskBytes) : '—'}
            limit={server.diskBytes === 0 ? unlimited : formatBytes(server.diskBytes)}
          />
          <Stat
            icon={<DownloadIcon />}
            label={t('console.networkIn')}
            value={usage ? formatUsedBytes(usage.networkRxBytes) : '—'}
          />
          <Stat
            icon={<UploadIcon />}
            label={t('console.networkOut')}
            value={usage ? formatUsedBytes(usage.networkTxBytes) : '—'}
          />
        </div>
      </div>

      <div className="mt-4 grid gap-4 lg:grid-cols-3">
        <ResourceChart
          title={t('console.chartCpu')}
          series={[
            {
              label: t('console.chartCpu'),
              points: history.map((s) => s.cpuPercent),
              color: PRIMARY_LINE,
              fill: true,
            },
          ]}
          // A CPU limit acts as the ceiling; without one the scale follows
          // the observed maximum, so a quiet server still reads.
          ceiling={server.cpuPercent}
          format={(value) => `${value.toFixed(2)} %`}
        />

        <ResourceChart
          title={t('console.chartMemory')}
          series={[
            {
              label: t('console.chartMemory'),
              points: history.map((s) => s.memoryBytes),
              color: PRIMARY_LINE,
              fill: true,
            },
          ]}
          ceiling={server.memoryBytes}
          format={formatUsedBytes}
        />

        <ResourceChart
          title={t('console.chartNetwork')}
          series={[
            {
              label: t('console.chartInbound'),
              points: rates(history, 'networkRxBytes'),
              color: PRIMARY_LINE,
            },
            {
              label: t('console.chartOutbound'),
              points: rates(history, 'networkTxBytes'),
              color: SECONDARY_LINE,
            },
          ]}
          format={(value) => `${formatUsedBytes(Math.round(value))}/s`}
        />
      </div>
    </>
  );
}

/**
 * Instant throughput, from two consecutive cumulative counters.
 *
 * The daemon reports totals since container start: plotting them raw would give
 * an ever-rising line with no visible spike. A restart resets the counters and
 * would produce a negative difference — clamped to zero rather than drawn below
 * the axis.
 */
function rates(
  history: readonly ResourceUsage[],
  key: 'networkRxBytes' | 'networkTxBytes',
): number[] {
  return history.slice(1).map((sample, index) => Math.max(0, sample[key] - history[index]![key]));
}

function PowerButton({
  action,
  label,
  controller,
  can,
  disabled,
  variant = 'secondary',
  confirm,
}: {
  action: PowerAction;
  label: MessageKey;
  controller: ConsoleController;
  can: (permission: Permission) => boolean;
  disabled: boolean;
  variant?: 'primary' | 'secondary' | 'danger' | 'ghost';
  confirm?: MessageKey;
}) {
  const { t } = useTranslation();

  // Hidden rather than disabled: a greyed-out button with no explanation
  // reads as a breakage. The API would refuse the action anyway.
  //
  // The permission comes from the API, not from the WebSocket: otherwise the
  // buttons appeared all at once when the console connected.
  if (!can(POWER_PERMISSIONS[action])) {
    return null;
  }

  return (
    <Button
      variant={variant}
      className="min-w-24"
      disabled={disabled || controller.status !== 'connected'}
      onClick={() => {
        if (confirm && !window.confirm(t(confirm))) {
          return;
        }
        controller.setPower(action);
      }}
    >
      {t(label)}
    </Button>
  );
}

/**
 * One measurement, in its own card.
 *
 * Separate cards rather than one dense list: each reads at a glance while the
 * console scrolls. The icon is not decorative — it is what the eye aims for
 * when looking for one row in the column.
 */
function Stat({
  icon,
  label,
  value,
  limit,
  mono,
  copyable,
}: {
  icon: ReactNode;
  label: string;
  value: string;
  /** Ceiling of the measurement, shown muted after the value. */
  limit?: string;
  mono?: boolean;
  /** Makes the card clickable: a click copies the value. */
  copyable?: boolean;
}) {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) {
      return;
    }

    const timer = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(timer);
  }, [copied]);

  const body = (
    <>
      <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-surface text-content-muted [&>svg]:size-5">
        {icon}
      </span>

      <div className="min-w-0 text-left">
        <p className="text-xs uppercase tracking-wide text-content-muted">
          {label}
          {/* Feedback in the label rather than a tooltip: nothing tells a
              filled clipboard from a click with no effect, and copying can
              genuinely fail — a panel served over plain HTTP has no clipboard
              API. */}
          {copied ? <span className="ml-2 text-accent">{t('common.copied')}</span> : null}
        </p>
        <p className={`truncate text-content ${mono ? 'font-mono text-sm' : 'font-semibold'}`}>
          {value}
          {limit ? (
            <span className="ml-1 text-xs font-normal text-content-subtle">/ {limit}</span>
          ) : null}
        </p>
      </div>
    </>
  );

  const shell =
    'flex flex-1 items-center gap-3 rounded-xl border border-border-subtle bg-surface-raised p-3';

  if (!copyable) {
    return <div className={shell}>{body}</div>;
  }

  return (
    <button
      type="button"
      title={t('console.copyAddress', { value })}
      className={cx(shell, 'w-full text-left transition-colors hover:bg-surface-hover')}
      onClick={() => {
        void copyText(value).then(setCopied);
      }}
    >
      {body}
    </button>
  );
}
