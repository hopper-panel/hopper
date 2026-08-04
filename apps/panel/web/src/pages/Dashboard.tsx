import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { PageHeader } from '../components/PageHeader';
import { Badge, Card, EmptyState, Spinner } from '../components/ui';
import { api, type Paginated, type ServerSummary } from '../lib/api';
import { describeStatus, formatAddress, formatBytes, formatCpu } from '../lib/format';

export function DashboardPage() {
  const { data, isLoading, error } = useQuery({
    queryKey: ['servers'],
    queryFn: () => api.get<Paginated<ServerSummary>>('/api/servers'),
  });

  if (isLoading) {
    return <Spinner label="Chargement de vos serveurs…" />;
  }

  if (error) {
    return <EmptyState title="Chargement impossible" description={String(error)} />;
  }

  const servers = data?.data ?? [];

  return (
    <>
      <PageHeader
        title="Mes serveurs"
        description={
          servers.length > 0
            ? `${data?.meta.total} serveur${(data?.meta.total ?? 0) > 1 ? 's' : ''}`
            : undefined
        }
      />

      {servers.length === 0 ? (
        <EmptyState
          title="Aucun serveur pour l'instant"
          description="Les serveurs auxquels vous avez accès apparaîtront ici. Demandez à un administrateur d'en créer un, ou d'être ajouté comme sous-utilisateur."
        />
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {servers.map((server) => (
            <ServerCard key={server.uuid} server={server} />
          ))}
        </div>
      )}
    </>
  );
}

function ServerCard({ server }: { server: ServerSummary }) {
  const status = describeStatus(server.status);

  return (
    <Link to={`/server/${server.uuid}`} className="block">
      <Card className="h-full transition-colors hover:border-accent/50">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="truncate font-medium text-content">{server.name}</p>
            <p className="mt-0.5 truncate font-mono text-xs text-content-muted">
              {formatAddress(server.primaryAllocation)}
            </p>
          </div>
          <Badge tone={status.tone}>{status.label}</Badge>
        </div>

        <dl className="mt-4 grid grid-cols-3 gap-3 border-t border-border-subtle pt-4 text-xs">
          <Stat label="Mémoire" value={formatBytes(server.memoryBytes)} />
          <Stat label="Disque" value={formatBytes(server.diskBytes)} />
          <Stat label="CPU" value={formatCpu(server.cpuPercent)} />
        </dl>

        <p className="mt-3 text-xs text-content-muted">
          {server.template.name} · {server.node.name}
          {!server.isOwner ? ' · partagé avec vous' : ''}
        </p>
      </Card>
    </Link>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-content-muted">{label}</dt>
      <dd className="mt-0.5 text-content">{value}</dd>
    </div>
  );
}
