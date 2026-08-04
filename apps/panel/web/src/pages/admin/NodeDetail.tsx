import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { useParams } from 'react-router-dom';
import { PageHeader } from '../../components/PageHeader';
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
    // Un node injoignable est un état courant, pas une erreur transitoire :
    // réessayer trois fois ne ferait qu'allonger l'attente de 15 secondes.
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
        <StatCard label="Serveurs" value={String(node.serverCount)} />
        <StatCard label="Ports alloués" value={String(node.allocationCount)} />
        <StatCard label="Mémoire" value={formatBytes(node.memoryBytes)} />
        <StatCard label="Disque" value={formatBytes(node.diskBytes)} />
      </div>

      <Card className="mb-6">
        <h2 className="font-medium text-content">Ajouter des ports</h2>
        <p className="mt-1 text-sm text-content-muted">
          Un port isolé (<code>25565</code>) ou une plage (<code>25565-25585</code>). Les ports déjà
          présents sont ignorés.
        </p>
        <AllocationForm
          onSubmit={(body) => createAllocations.mutate(body)}
          pending={createAllocations.isPending}
          error={createAllocations.error}
          result={createAllocations.data}
        />
      </Card>

      <Card>
        <h2 className="mb-3 font-medium text-content">Ports</h2>
        {(allocations?.data.length ?? 0) === 0 ? (
          <EmptyState
            title="Aucun port alloué"
            description="Un serveur a besoin d'au moins un port pour accepter des joueurs."
          />
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
                    <p className="text-xs text-content-muted">libre</p>
                  )}
                </div>
                {allocation.assignedTo ? (
                  <Badge tone="online">utilisé</Badge>
                ) : (
                  <Button
                    variant="ghost"
                    onClick={() => deleteAllocation.mutate(allocation.id)}
                    aria-label={`Supprimer le port ${allocation.port}`}
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
  if (isLoading && !health) {
    return <Badge tone="offline">vérification…</Badge>;
  }

  if (!health) {
    return <Badge tone="offline">état inconnu</Badge>;
  }

  if (!health.reachable) {
    return <Badge tone="danger">{health.reason}</Badge>;
  }

  return <Badge tone="online">en ligne · {health.latencyMs} ms</Badge>;
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
          {result.created} port(s) créé(s)
          {result.skipped > 0 ? `, ${result.skipped} déjà présent(s)` : ''}.
        </Alert>
      ) : null}

      <div className="grid gap-4 sm:grid-cols-[200px_1fr_auto] sm:items-end">
        <Field label="Adresse IP">
          <Input value={ip} onChange={(event) => setIp(event.target.value)} required />
        </Field>

        <Field label="Ports">
          <Input
            value={ports}
            onChange={(event) => setPorts(event.target.value)}
            placeholder="25565-25585, 25600"
            required
          />
        </Field>

        <Button type="submit" variant="primary" disabled={pending}>
          {pending ? 'Ajout…' : 'Ajouter'}
        </Button>
      </div>
    </form>
  );
}
