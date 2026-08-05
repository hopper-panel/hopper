import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState, type ReactNode } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { PageHeader } from '../../components/PageHeader';
import { Alert, Badge, Button, Card, Spinner } from '../../components/ui';
import { useTranslation, type MessageKey } from '../../i18n';
import { api, ApiError } from '../../lib/api';
import { formatBytes } from '../../lib/format';
import { TransferCard } from './TransferCard';
import { DatabasesTab, DetailsTab, NetworkTab, StartupTab } from './ServerDetailTabs';

interface AdminServer {
  uuid: string;
  name: string;
  description: string;
  status: string;
  memoryBytes: number;
  diskBytes: number;
  cpuPercent: number;
  node: { uuid: string; name: string; fqdn: string };
  template: { uuid: string; name: string };
  primaryAllocation: { ip: string; port: number; alias: string | null } | null;
  createdAt: string;
}

const MIB = 1024 * 1024;

/**
 * The tabs, in the order an administrator walks them.
 *
 * Identity first, then what the server may consume, then what it runs, then
 * what it is reachable on — and the irreversible actions last, where a misclick
 * has to travel furthest.
 */
const TABS = [
  ['about', 'adminServer.about'],
  ['details', 'adminServer.details'],
  ['build', 'adminServer.build'],
  ['startup', 'adminServer.startup'],
  ['network', 'adminServer.network'],
  ['databases', 'adminServer.databases'],
  ['manage', 'adminServer.manage'],
] as const;

type Tab = (typeof TABS)[number][0];

/** The build fields, with the unit each is entered in. */
interface BuildForm {
  memoryMib: number;
  diskMib: number;
  swapMib: number;
  cpuPercent: number;
  ioWeight: number;
  pidsLimit: number;
  backupLimit: number;
  databaseLimit: number;
  allocationLimit: number;
}

/**
 * A server, as an administrator sees it.
 *
 * Separate from the tab an owner gets. The two answer different questions —
 * "how is my server doing" against "what is this server allowed to use" — and
 * folding them together put a delete button next to a console.
 *
 * Limits are entered in mebibytes, not bytes. An operator thinks in the units
 * the game does; asking for 2147483648 invites a typo nobody catches until a
 * server will not start.
 */
export function AdminServerDetailPage() {
  const { uuid = '' } = useParams();
  const { t } = useTranslation();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [tab, setTab] = useState<Tab>('about');

  const server = useQuery({
    queryKey: ['admin', 'server', uuid],
    queryFn: () => api.get<AdminServer>(`/api/admin/servers/${uuid}`),
  });

  const reload = (): void => {
    void queryClient.invalidateQueries({ queryKey: ['admin', 'server', uuid] });
  };

  if (server.isPending) {
    return <Spinner />;
  }

  if (server.error instanceof ApiError) {
    return <Alert tone="danger">{server.error.message}</Alert>;
  }

  const data = server.data!;

  return (
    <>
      <PageHeader
        title={data.name}
        description={`${data.template.name} · ${data.node.name}`}
        action={
          // The owner's view of the same server, one click away: an
          // administrator diagnosing something needs the console, and hunting
          // for it through the server list is the kind of friction that makes
          // people keep two tabs open forever.
          <Link to={`/server/${data.uuid}`}>
            <Button>{t('adminServer.openConsole')}</Button>
          </Link>
        }
      />

      <div className="mb-4 flex gap-1 border-b border-border-subtle">
        {TABS.map(([key, label]) => (
          <button
            key={key}
            type="button"
            onClick={() => setTab(key)}
            className={
              tab === key
                ? 'border-b-2 border-accent px-3 py-2 text-sm font-medium text-content'
                : 'px-3 py-2 text-sm text-content-muted hover:text-content'
            }
          >
            {t(label)}
          </button>
        ))}
      </div>

      {tab === 'about' ? <About server={data} /> : null}
      {tab === 'build' ? <Build server={data} onSaved={reload} /> : null}
      {tab === 'details' ? <DetailsTab server={data} onSaved={reload} /> : null}
      {tab === 'startup' ? <StartupTab server={data} /> : null}
      {tab === 'network' ? <NetworkTab server={data} /> : null}
      {tab === 'databases' ? <DatabasesTab server={data} /> : null}
      {tab === 'manage' ? (
        <Manage
          server={data}
          onDeleted={() => {
            void navigate('/admin/servers');
          }}
        />
      ) : null}
    </>
  );
}

function About({ server }: { server: AdminServer }) {
  const { t } = useTranslation();

  return (
    <Card>
      <dl className="grid gap-3 text-sm sm:grid-cols-2">
        <Row label="adminServer.uuid" value={<code className="font-mono">{server.uuid}</code>} />
        <Row label="adminServer.status" value={<Badge>{server.status}</Badge>} />
        <Row label="adminServer.template" value={server.template.name} />
        <Row
          label="adminServer.node"
          value={
            <Link to={`/admin/nodes/${server.node.uuid}`} className="hover:underline">
              {server.node.name}
            </Link>
          }
        />
        <Row
          label="adminServer.address"
          value={
            server.primaryAllocation
              ? `${server.primaryAllocation.alias ?? server.primaryAllocation.ip}:${server.primaryAllocation.port}`
              : '—'
          }
        />
        <Row label="adminServer.memory" value={formatBytes(server.memoryBytes)} />
        <Row label="adminServer.disk" value={formatBytes(server.diskBytes)} />
        <Row
          label="adminServer.cpu"
          value={server.cpuPercent === 0 ? t('adminServer.unlimited') : `${server.cpuPercent}%`}
        />
        <Row label="adminServer.created" value={new Date(server.createdAt).toLocaleString()} />
      </dl>

      {server.description ? (
        <p className="mt-4 border-t border-border-subtle pt-3 text-sm text-content-muted">
          {server.description}
        </p>
      ) : null}
    </Card>
  );
}

function Row({ label, value }: { label: MessageKey; value: ReactNode }) {
  const { t } = useTranslation();

  return (
    <div>
      <dt className="text-content-subtle">{t(label)}</dt>
      <dd className="mt-0.5 text-content">{value}</dd>
    </div>
  );
}

function Build({ server, onSaved }: { server: AdminServer; onSaved: () => void }) {
  const { t } = useTranslation();
  const [form, setForm] = useState<BuildForm>({
    memoryMib: Math.round(server.memoryBytes / MIB),
    diskMib: Math.round(server.diskBytes / MIB),
    swapMib: 0,
    cpuPercent: server.cpuPercent,
    ioWeight: 500,
    pidsLimit: 512,
    backupLimit: 3,
    databaseLimit: 0,
    allocationLimit: 0,
  });

  // The form follows the server when it is reloaded elsewhere — a save, another
  // administrator — instead of holding whatever was on screen when it mounted.
  useEffect(() => {
    setForm((current) => ({
      ...current,
      memoryMib: Math.round(server.memoryBytes / MIB),
      diskMib: Math.round(server.diskBytes / MIB),
      cpuPercent: server.cpuPercent,
    }));
  }, [server.memoryBytes, server.diskBytes, server.cpuPercent]);

  const save = useMutation({
    mutationFn: () =>
      api.patch(`/api/admin/servers/${server.uuid}/build`, {
        memoryBytes: form.memoryMib * MIB,
        diskBytes: form.diskMib * MIB,
        swapBytes: form.swapMib * MIB,
        cpuPercent: form.cpuPercent,
        ioWeight: form.ioWeight,
        pidsLimit: form.pidsLimit,
        backupLimit: form.backupLimit,
        databaseLimit: form.databaseLimit,
        allocationLimit: form.allocationLimit,
      }),
    onSuccess: onSaved,
  });

  return (
    <Card>
      <form
        className="grid gap-4 sm:grid-cols-2"
        onSubmit={(event) => {
          event.preventDefault();
          save.mutate();
        }}
      >
        <Field label="adminServer.memory" hint="adminServer.mibHint">
          <input
            type="number"
            min={0}
            value={form.memoryMib}
            onChange={(event) => setForm({ ...form, memoryMib: Number(event.target.value) })}
            className="w-full rounded-lg border border-border-subtle bg-surface px-3 py-2 text-sm text-content"
          />
        </Field>

        <Field label="adminServer.disk" hint="adminServer.mibHint">
          <input
            type="number"
            min={0}
            value={form.diskMib}
            onChange={(event) => setForm({ ...form, diskMib: Number(event.target.value) })}
            className="w-full rounded-lg border border-border-subtle bg-surface px-3 py-2 text-sm text-content"
          />
        </Field>

        <Field label="adminServer.cpu" hint="adminServer.cpuHint">
          <input
            type="number"
            min={0}
            max={6400}
            value={form.cpuPercent}
            onChange={(event) => setForm({ ...form, cpuPercent: Number(event.target.value) })}
            className="w-full rounded-lg border border-border-subtle bg-surface px-3 py-2 text-sm text-content"
          />
        </Field>

        <Field label="adminServer.pids" hint="adminServer.pidsHint">
          <input
            type="number"
            min={64}
            max={8192}
            value={form.pidsLimit}
            onChange={(event) => setForm({ ...form, pidsLimit: Number(event.target.value) })}
            className="w-full rounded-lg border border-border-subtle bg-surface px-3 py-2 text-sm text-content"
          />
        </Field>

        <Field label="adminServer.backupLimit">
          <input
            type="number"
            min={0}
            max={100}
            value={form.backupLimit}
            onChange={(event) => setForm({ ...form, backupLimit: Number(event.target.value) })}
            className="w-full rounded-lg border border-border-subtle bg-surface px-3 py-2 text-sm text-content"
          />
        </Field>

        <Field label="adminServer.databaseLimit">
          <input
            type="number"
            min={0}
            max={50}
            value={form.databaseLimit}
            onChange={(event) => setForm({ ...form, databaseLimit: Number(event.target.value) })}
            className="w-full rounded-lg border border-border-subtle bg-surface px-3 py-2 text-sm text-content"
          />
        </Field>

        <div className="sm:col-span-2">
          {/* Said plainly rather than left to be discovered: the daemon writes
              these into the container, and a container's limits are set when it
              is created. */}
          <p className="mb-3 text-sm text-content-muted">{t('adminServer.rebuildNotice')}</p>

          {save.error instanceof ApiError ? (
            <Alert tone="danger">{save.error.message}</Alert>
          ) : null}

          <Button type="submit" variant="primary" disabled={save.isPending}>
            {save.isPending ? t('adminServer.saving') : t('adminServer.save')}
          </Button>
        </div>
      </form>
    </Card>
  );
}

function Field({
  label,
  hint,
  children,
}: {
  label: MessageKey;
  hint?: MessageKey;
  children: ReactNode;
}) {
  const { t } = useTranslation();

  return (
    <label className="block">
      <span className="mb-1 block text-sm text-content">{t(label)}</span>
      {children}
      {hint ? <span className="mt-1 block text-xs text-content-subtle">{t(hint)}</span> : null}
    </label>
  );
}

function Manage({ server, onDeleted }: { server: AdminServer; onDeleted: () => void }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const suspended = server.status === 'SUSPENDED';

  const suspend = useMutation({
    mutationFn: () =>
      api.post(`/api/admin/servers/${server.uuid}/${suspended ? 'unsuspend' : 'suspend'}`, {}),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['admin', 'server', server.uuid] }),
  });

  const remove = useMutation({
    mutationFn: () => api.delete(`/api/admin/servers/${server.uuid}`),
    onSuccess: onDeleted,
  });

  return (
    <div className="grid gap-4">
      <TransferCard server={server} currentNode={server.node.name} />

      <Card>
        <h2 className="mb-1 text-sm font-semibold uppercase tracking-wide text-content">
          {t(suspended ? 'adminServer.unsuspend' : 'adminServer.suspend')}
        </h2>
        <p className="mb-3 text-sm text-content-muted">{t('adminServer.suspendHint')}</p>

        {suspend.error instanceof ApiError ? (
          <Alert tone="danger">{suspend.error.message}</Alert>
        ) : null}

        <Button onClick={() => suspend.mutate()} disabled={suspend.isPending}>
          {t(suspended ? 'adminServer.unsuspend' : 'adminServer.suspend')}
        </Button>
      </Card>

      <Card>
        <h2 className="mb-1 text-sm font-semibold uppercase tracking-wide text-danger">
          {t('adminServer.delete')}
        </h2>
        {/* What is lost, not "are you sure": the world is on that volume, and
            the confirmation is worth nothing if it does not say so. */}
        <p className="mb-3 text-sm text-content-muted">{t('adminServer.deleteHint')}</p>

        {remove.error instanceof ApiError ? (
          <Alert tone="danger">{remove.error.message}</Alert>
        ) : null}

        <Button
          variant="danger"
          disabled={remove.isPending}
          onClick={() => {
            // The name has to be typed. A server is deleted once, and a button
            // that only needs a click is a button that gets clicked on the
            // wrong row.
            const typed = window.prompt(t('adminServer.deleteConfirm', { name: server.name }));

            if (typed === server.name) {
              remove.mutate();
            }
          }}
        >
          {remove.isPending ? t('adminServer.deleting') : t('adminServer.delete')}
        </Button>
      </Card>
    </div>
  );
}
