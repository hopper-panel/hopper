import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { useParams } from 'react-router-dom';
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

export function AdminNodeDetailPage() {
  const { t } = useTranslation();
  const { uuid = '' } = useParams();
  const queryClient = useQueryClient();

  const { data: node, isLoading } = useQuery({
    queryKey: ['admin', 'node', uuid],
    queryFn: () => api.get<NodeSummary>(`/api/admin/nodes/${uuid}`),
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
        action={<HealthBadge health={health.data} isLoading={health.isFetching} />}
      />

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
    </>
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
