import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { PageHeader } from '../components/PageHeader';
import { Badge, Card, EmptyState, Spinner } from '../components/ui';
import { useTranslation } from '../i18n';
import { api, type Paginated, type ServerSummary } from '../lib/api';
import { describeStatus, formatAddress, formatBytes, formatCpu } from '../lib/format';

export function DashboardPage() {
  const { t } = useTranslation();

  const { data, isLoading, error } = useQuery({
    queryKey: ['servers'],
    queryFn: () => api.get<Paginated<ServerSummary>>('/api/servers'),
  });

  if (isLoading) {
    return <Spinner label={t('common.loading')} />;
  }

  if (error) {
    return <EmptyState title={t('common.loadFailed')} description={String(error)} />;
  }

  const servers = data?.data ?? [];

  return (
    <>
      <PageHeader
        title={t('dashboard.title')}
        description={
          servers.length > 0
            ? t('dashboard.subtitle', { count: data?.meta.total ?? servers.length })
            : undefined
        }
      />

      {servers.length === 0 ? (
        <EmptyState title={t('dashboard.empty')} description={t('dashboard.emptyHint')} />
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
  const { t } = useTranslation();
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
          <Badge tone={status.tone}>{t(status.key)}</Badge>
        </div>

        <dl className="mt-4 grid grid-cols-3 gap-3 border-t border-border-subtle pt-4 text-xs">
          <Stat label={t('console.memory')} value={formatBytes(server.memoryBytes)} />
          <Stat label={t('console.disk')} value={formatBytes(server.diskBytes)} />
          <Stat label={t('card.cpu')} value={formatCpu(server.cpuPercent)} />
        </dl>

        <p className="mt-3 text-xs text-content-muted">
          {server.template.name} · {server.node.name}
          {server.isOwner ? '' : ` · ${t('card.shared')}`}
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
