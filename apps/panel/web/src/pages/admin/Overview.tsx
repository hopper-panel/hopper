import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { PageHeader } from '../../components/PageHeader';
import { Badge, Card, Spinner } from '../../components/ui';
import { api } from '../../lib/api';
import { formatBytes } from '../../lib/format';

interface NodeHealth {
  uuid: string;
  name: string;
  fqdn: string;
  servers: number;
  reachable: boolean;
  reason?: string;
  version?: string;
  cpuCount?: number;
  memoryTotalBytes?: number;
  runningContainers?: number;
  latencyMs?: number;
}

interface Overview {
  version: string;
  counts: {
    servers: number;
    nodes: number;
    users: number;
    templates: number;
    backups: number;
    databases: number;
  };
  nodes: NodeHealth[];
}

export function AdminOverviewPage() {
  const overview = useQuery({
    queryKey: ['admin', 'overview'],
    queryFn: () => api.get<Overview>('/api/admin/overview'),
    // Les nodes sont sondés en direct : rafraîchir régulièrement fait de cette
    // page un tableau de bord utilisable, et non une photographie.
    refetchInterval: 15_000,
  });

  if (overview.isLoading || !overview.data) {
    return <Spinner label="Chargement de la vue d’ensemble…" />;
  }

  const { counts, nodes, version } = overview.data;

  return (
    <>
      <PageHeader title="Vue d’ensemble" description={`Hopper Panel ${version}`} />

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-3">
        <Count label="Serveurs" value={counts.servers} to="/admin/servers" />
        <Count label="Nodes" value={counts.nodes} to="/admin/nodes" />
        <Count label="Utilisateurs" value={counts.users} to="/admin/users" />
        <Count label="Templates" value={counts.templates} to="/admin/templates" />
        <Count label="Sauvegardes" value={counts.backups} />
        <Count label="Bases de données" value={counts.databases} to="/admin/database-hosts" />
      </div>

      <h2 className="mb-3 mt-8 text-lg font-semibold text-content">État des nodes</h2>

      {nodes.length === 0 ? (
        <Card>
          <p className="text-sm text-content-muted">
            Aucun node déclaré.{' '}
            <Link to="/admin/nodes" className="text-accent hover:underline">
              En ajouter un
            </Link>{' '}
            pour héberger des serveurs.
          </p>
        </Card>
      ) : (
        <div className="flex flex-col gap-2">
          {nodes.map((node) => (
            <Card key={node.uuid}>
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <Link
                      to={`/admin/nodes/${node.uuid}`}
                      className="font-medium text-content hover:underline"
                    >
                      {node.name}
                    </Link>
                    {/* Un node déclaré n'est pas un node joignable : c'est
                        exactement ce qu'on vient vérifier ici. */}
                    {node.reachable ? (
                      <Badge tone="online">joignable</Badge>
                    ) : (
                      <Badge tone="danger">injoignable</Badge>
                    )}
                    <span className="font-mono text-xs text-content-subtle">{node.fqdn}</span>
                  </div>

                  <p className="mt-1 text-xs text-content-muted">
                    {node.reachable
                      ? `hopperd ${node.version} · ${node.cpuCount} cœurs · ` +
                        `${formatBytes(node.memoryTotalBytes ?? 0)} · ` +
                        `${node.runningContainers} conteneur(s) en marche · ${node.latencyMs} ms`
                      : node.reason}
                  </p>
                </div>

                <span className="shrink-0 text-sm text-content-muted">
                  {node.servers} serveur{node.servers > 1 ? 's' : ''}
                </span>
              </div>
            </Card>
          ))}
        </div>
      )}
    </>
  );
}

function Count({ label, value, to }: { label: string; value: number; to?: string }) {
  const content = (
    <Card className="h-full">
      <p className="text-xs uppercase tracking-wide text-content-muted">{label}</p>
      <p className="mt-1 text-2xl font-semibold text-content">{value}</p>
    </Card>
  );

  return to ? (
    <Link to={to} className="transition-opacity hover:opacity-80">
      {content}
    </Link>
  ) : (
    content
  );
}
