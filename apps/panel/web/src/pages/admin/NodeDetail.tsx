import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { FormDialog } from '../../components/FormDialog';
import { PageHeader } from '../../components/PageHeader';
import { useTranslation } from '../../i18n';
import { Alert, Badge, Button, Card, EmptyState, Field, Input, Spinner } from '../../components/ui';
import {
  ApiError,
  api,
  type AllocationSummary,
  type NodeHealth,
  type NodeSummary,
  type Paginated,
} from '../../lib/api';
import { formatBytes } from '../../lib/format';

/** Bytes to gibibytes, as the capacity fields are typed. */
const GIB = 1024 ** 3;

export function AdminNodeDetailPage() {
  const { t } = useTranslation();
  const { uuid = '' } = useParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState(false);

  const { data: node, isLoading } = useQuery({
    queryKey: ['admin', 'node', uuid],
    queryFn: () => api.get<NodeSummary>(`/api/admin/nodes/${uuid}`),
  });

  const remove = useMutation({
    mutationFn: () => api.delete<void>(`/api/admin/nodes/${uuid}`),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['admin', 'nodes'] });
      void navigate('/admin/nodes');
    },
  });

  const { data: allocations } = useQuery({
    queryKey: ['admin', 'node', uuid, 'allocations'],
    queryFn: () =>
      api.get<Paginated<AllocationSummary>>(`/api/admin/nodes/${uuid}/allocations?perPage=100`),
  });

  const health = useQuery({
    queryKey: ['admin', 'node', uuid, 'health'],
    queryFn: () => api.get<NodeHealth>(`/api/admin/nodes/${uuid}/health`),
    // An unreachable node is a normal state, not a transient error: retrying
    // three times would only stretch the wait to 15 seconds.
    retry: false,
    refetchInterval: 30_000,
  });

  const createAllocations = useMutation({
    mutationFn: (body: { ip: string; ports: string[] }) =>
      api.post<{ created: number; skipped: number }>(`/api/admin/nodes/${uuid}/allocations`, body),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: ['admin', 'node', uuid, 'allocations'] }),
  });

  const deleteAllocation = useMutation({
    mutationFn: (id: number) => api.delete<void>(`/api/admin/nodes/${uuid}/allocations/${id}`),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: ['admin', 'node', uuid, 'allocations'] }),
  });

  if (isLoading || !node) {
    return <Spinner />;
  }

  return (
    <>
      <PageHeader
        title={node.name}
        description={`${node.scheme}://${node.fqdn}:${node.port}`}
        action={
          <div className="flex items-center gap-2">
            <HealthBadge health={health.data} isLoading={health.isFetching} />
            <Button onClick={() => setEditing(true)}>{t('common.edit')}</Button>
          </div>
        }
      />

      {editing ? <NodeSettingsDialog node={node} onClose={() => setEditing(false)} /> : null}

      <div className="mb-6 grid gap-4 sm:grid-cols-4">
        <StatCard label={t('adminNodes.servers')} value={String(node.serverCount)} />
        <StatCard label={t('adminNode.allocations')} value={String(node.allocationCount)} />
        <StatCard label={t('console.memory')} value={formatBytes(node.memoryBytes)} />
        <StatCard label={t('console.disk')} value={formatBytes(node.diskBytes)} />
      </div>

      <Card className="mb-6">
        <h2 className="font-medium text-content">{t('adminNode.addPorts')}</h2>
        <p className="mt-1 text-sm text-content-muted">{t('adminNode.portsHelp')}</p>
        <AllocationForm
          onSubmit={(body) => createAllocations.mutate(body)}
          pending={createAllocations.isPending}
          error={createAllocations.error}
          result={createAllocations.data}
        />
      </Card>

      <Card>
        <h2 className="mb-3 font-medium text-content">{t('adminNodes.ports')}</h2>
        {(allocations?.data.length ?? 0) === 0 ? (
          <EmptyState title={t('adminNode.empty')} description={t('adminNode.addPortsHint')} />
        ) : (
          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {allocations?.data.map((allocation) => (
              <div
                key={allocation.id}
                className="flex items-center justify-between gap-2 rounded-lg border border-border-subtle px-3 py-2"
              >
                <div className="min-w-0">
                  <p className="truncate font-mono text-sm text-content">
                    {allocation.ip}:{allocation.port}
                  </p>
                  {allocation.assignedTo ? (
                    <p className="truncate text-xs text-content-muted">
                      {allocation.assignedTo.name}
                    </p>
                  ) : (
                    <p className="text-xs text-content-muted">{t('adminNode.free')}</p>
                  )}
                </div>
                {allocation.assignedTo ? (
                  <Badge tone="online">{t('adminNode.used')}</Badge>
                ) : (
                  <Button
                    variant="ghost"
                    onClick={() => deleteAllocation.mutate(allocation.id)}
                    aria-label={t('adminNode.removePort', { port: allocation.port })}
                  >
                    ✕
                  </Button>
                )}
              </div>
            ))}
          </div>
        )}
      </Card>

      <Card className="mt-6 border-danger/40">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div>
            <h2 className="font-medium text-content">{t('adminNode.deleteTitle')}</h2>
            <p className="mt-1 text-sm text-content-muted">{t('adminNode.deleteHint')}</p>
          </div>

          <Button
            variant="danger"
            disabled={remove.isPending}
            onClick={() => {
              if (window.confirm(t('adminNode.deleteConfirm', { name: node.name }))) {
                remove.mutate();
              }
            }}
          >
            {t('common.delete')}
          </Button>
        </div>

        {/* The API refuses a node that still hosts servers and says how many.
            Rendered rather than swallowed: the count is the whole instruction,
            and the remedy — move or delete them — depends on it. */}
        {remove.error instanceof ApiError ? (
          <div className="mt-4">
            <Alert>{remove.error.message}</Alert>
          </div>
        ) : null}
      </Card>
    </>
  );
}

/**
 * Editing a node, which is mostly editing the address the panel reaches it at.
 *
 * Every field is sent on every save, including the ones the operator did not
 * touch. That is deliberate and it is what the form is *for*: `updateNodeSchema`
 * now carries only the keys it was given, so a body naming a subset would leave
 * the rest alone — but a form that shows a value and does not send it back is a
 * form whose fields quietly disagree with the database the moment anything else
 * writes to it.
 *
 * The capacity fields are gibibytes on screen and bytes in the column. The
 * conversion happens in both directions here, and it has to: opening this
 * dialog on a node with 64 GiB and saving it back without dividing first would
 * multiply its declared capacity by a billion, and the panel sells servers
 * against that number.
 */
function NodeSettingsDialog({ node, onClose }: { node: NodeSummary; onClose: () => void }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [form, setForm] = useState({
    name: node.name,
    description: node.description,
    fqdn: node.fqdn,
    scheme: node.scheme,
    port: node.port,
    sftpPort: node.sftpPort,
    timezone: node.timezone,
    memoryGib: Number((node.memoryBytes / GIB).toFixed(2)),
    diskGib: Number((node.diskBytes / GIB).toFixed(2)),
    maintenance: node.maintenance,
  });

  const save = useMutation({
    mutationFn: () =>
      api.patch<NodeSummary>(`/api/admin/nodes/${node.uuid}`, {
        name: form.name.trim(),
        description: form.description,
        fqdn: form.fqdn.trim(),
        scheme: form.scheme,
        port: Number(form.port),
        sftpPort: Number(form.sftpPort),
        timezone: form.timezone.trim(),
        memoryBytes: Math.round(form.memoryGib * GIB),
        diskBytes: Math.round(form.diskGib * GIB),
        maintenance: form.maintenance,
      }),
    onSuccess: () => {
      // Two keys, because the list and this page are cached separately and the
      // address shown on both has just changed.
      void queryClient.invalidateQueries({ queryKey: ['admin', 'nodes'] });
      void queryClient.invalidateQueries({ queryKey: ['admin', 'node', node.uuid] });
      onClose();
    },
  });

  return (
    <FormDialog
      title={t('adminNode.editTitle')}
      formId="edit-node"
      onClose={onClose}
      onSubmit={() => save.mutate()}
      submit={t('common.save')}
      submitting={t('common.saving')}
      pending={save.isPending}
      disabled={form.name.trim() === '' || form.fqdn.trim() === ''}
      error={save.error}
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label={t('adminNodes.name')}>
          <Input
            value={form.name}
            onChange={(event) => setForm({ ...form, name: event.target.value })}
            required
          />
        </Field>

        <Field label={t('adminNodes.fqdn')} hint={t('adminNode.fqdnEditHint')}>
          <Input
            value={form.fqdn}
            onChange={(event) => setForm({ ...form, fqdn: event.target.value })}
            required
          />
        </Field>

        <Field label={t('adminNodes.daemonPort')}>
          <Input
            type="number"
            value={form.port}
            onChange={(event) => setForm({ ...form, port: Number(event.target.value) })}
            min={1}
            max={65535}
            required
          />
        </Field>

        <Field label={t('adminNode.sftpPort')}>
          <Input
            type="number"
            value={form.sftpPort}
            onChange={(event) => setForm({ ...form, sftpPort: Number(event.target.value) })}
            min={1}
            max={65535}
            required
          />
        </Field>

        <Field label={t('adminNodes.scheme')} hint={t('adminNodes.schemeHint')}>
          <select
            value={form.scheme}
            onChange={(event) => setForm({ ...form, scheme: event.target.value })}
            className="w-full rounded-lg border border-border-subtle bg-surface px-3 py-2 text-sm text-content focus:border-accent focus:outline-none"
          >
            <option value="https">https</option>
            <option value="http">http</option>
          </select>
        </Field>

        {/* The clock every game server on this node writes its logs with. An
            operator who reads "14:02" on a machine whose wall clock says 16:02
            is reading a container that was never told where it lives. */}
        <Field label={t('adminNode.timezone')} hint={t('adminNode.timezoneHint')}>
          <Input
            value={form.timezone}
            onChange={(event) => setForm({ ...form, timezone: event.target.value })}
            placeholder="Europe/Paris"
            required
          />
        </Field>

        <Field label={t('adminNodes.memory')} hint={t('adminNodes.capacityHint')}>
          <Input
            type="number"
            value={form.memoryGib}
            onChange={(event) => setForm({ ...form, memoryGib: Number(event.target.value) })}
            min={0}
            step="0.01"
            required
          />
        </Field>

        <Field label={t('adminNodes.disk')}>
          <Input
            type="number"
            value={form.diskGib}
            onChange={(event) => setForm({ ...form, diskGib: Number(event.target.value) })}
            min={0}
            step="0.01"
            required
          />
        </Field>

        <Field label={t('adminNode.description')}>
          <Input
            value={form.description}
            onChange={(event) => setForm({ ...form, description: event.target.value })}
          />
        </Field>
      </div>

      <label className="mt-4 flex items-start gap-2 text-sm text-content">
        <input
          type="checkbox"
          checked={form.maintenance}
          onChange={(event) => setForm({ ...form, maintenance: event.target.checked })}
          className="mt-0.5"
        />
        <span>
          {t('adminNode.maintenance')}
          <span className="mt-0.5 block text-xs text-content-muted">
            {t('adminNode.maintenanceHint')}
          </span>
        </span>
      </label>
    </FormDialog>
  );
}

function HealthBadge({ health, isLoading }: { health?: NodeHealth; isLoading: boolean }) {
  const { t } = useTranslation();

  if (isLoading && !health) {
    return <Badge tone="offline">{t('adminNode.checking')}</Badge>;
  }

  if (!health) {
    return <Badge tone="offline">{t('adminNode.unknown')}</Badge>;
  }

  if (!health.reachable) {
    return <Badge tone="danger">{health.reason}</Badge>;
  }

  return <Badge tone="online">{t('adminNode.online', { latency: health.latencyMs })}</Badge>;
}

function StatCard({ label, value }: { label: string; value: string }) {
  return (
    <Card>
      <p className="text-xs text-content-muted">{label}</p>
      <p className="mt-1 text-lg text-content">{value}</p>
    </Card>
  );
}

function AllocationForm({
  onSubmit,
  pending,
  error,
  result,
}: {
  onSubmit: (body: { ip: string; ports: string[] }) => void;
  pending: boolean;
  error: unknown;
  result?: { created: number; skipped: number };
}) {
  const { t } = useTranslation();
  const [ip, setIp] = useState('0.0.0.0');
  const [ports, setPorts] = useState('');

  function handleSubmit(event: FormEvent): void {
    event.preventDefault();
    onSubmit({
      ip,
      ports: ports
        .split(',')
        .map((entry) => entry.trim())
        .filter(Boolean),
    });
  }

  return (
    <form onSubmit={handleSubmit} className="mt-4 space-y-4">
      {error instanceof ApiError ? <Alert>{error.message}</Alert> : null}
      {result ? (
        <Alert tone="info">
          {t('adminNode.created', { created: result.created })}
          {result.skipped > 0 ? ` ${t('adminNode.skipped', { skipped: result.skipped })}` : ''}
        </Alert>
      ) : null}

      <div className="grid gap-4 sm:grid-cols-[200px_1fr_auto] sm:items-end">
        <Field label={t('adminNode.ip')}>
          <Input value={ip} onChange={(event) => setIp(event.target.value)} required />
        </Field>

        <Field label={t('adminNode.portsField')}>
          <Input
            value={ports}
            onChange={(event) => setPorts(event.target.value)}
            placeholder={t('adminNode.portsPlaceholder')}
            required
          />
        </Field>

        <Button type="submit" variant="primary" disabled={pending}>
          {pending ? t('adminNode.adding') : t('adminNode.add')}
        </Button>
      </div>
    </form>
  );
}
