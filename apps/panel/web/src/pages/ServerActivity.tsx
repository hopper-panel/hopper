import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { useParams } from 'react-router-dom';
import { PageHeader } from '../components/PageHeader';
import { Badge, Button, Card, EmptyState, Spinner } from '../components/ui';
import { api, type Paginated } from '../lib/api';
import { formatDate } from '../lib/format';

interface Entry {
  uuid: string;
  event: string;
  description: string;
  /** Null pour une action du système : planificateur, daemon. */
  actor: { username: string } | null;
  ip: string | null;
  createdAt: string;
}

export function ServerActivityPage() {
  const { uuid = '' } = useParams();
  const [page, setPage] = useState(1);

  const activity = useQuery({
    queryKey: ['server', uuid, 'activity', page],
    queryFn: () => api.get<Paginated<Entry>>(`/api/servers/${uuid}/activity?page=${page}`),
    // La page consultée ne doit pas se dérober sous les yeux : le journal se
    // lit, il ne se surveille pas en direct.
    refetchOnWindowFocus: false,
  });

  if (activity.isLoading) {
    return <Spinner label="Chargement du journal…" />;
  }

  const entries = activity.data?.data ?? [];
  const meta = activity.data?.meta;

  return (
    <>
      <PageHeader
        title="Activité"
        description="Ce qui a été fait sur ce serveur, par qui et depuis où."
      />

      {entries.length === 0 ? (
        <EmptyState
          title="Aucune activité"
          description="Les actions menées sur ce serveur — commandes, fichiers, sauvegardes — apparaîtront ici."
        />
      ) : (
        <Card className="p-0">
          <ul>
            {entries.map((entry) => (
              <li
                key={entry.uuid}
                className="flex flex-wrap items-start gap-x-3 gap-y-1 border-b border-border-subtle/50 px-4 py-3 last:border-0"
              >
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-sm font-medium text-content">
                      {/* Une action sans acteur vient du planificateur ou du
                          daemon : l'attribuer à personne serait faux, et à un
                          utilisateur encore plus. */}
                      {entry.actor?.username ?? 'Système'}
                    </span>
                    <code className="font-mono text-xs text-content-subtle">{entry.event}</code>
                  </div>

                  <p className="mt-0.5 text-sm text-content-muted">{entry.description}</p>
                </div>

                <div className="flex shrink-0 items-center gap-2 text-xs text-content-subtle">
                  {entry.ip ? <span className="font-mono">{entry.ip}</span> : null}
                  <span>{formatDate(entry.createdAt)}</span>
                </div>
              </li>
            ))}
          </ul>
        </Card>
      )}

      {meta && meta.lastPage > 1 ? (
        <div className="mt-4 flex items-center justify-between gap-3">
          <Button onClick={() => setPage((current) => current - 1)} disabled={page <= 1}>
            Précédent
          </Button>

          <span className="text-sm text-content-muted">
            Page {meta.currentPage} sur {meta.lastPage}
            <Badge>{meta.total} entrées</Badge>
          </span>

          <Button
            onClick={() => setPage((current) => current + 1)}
            disabled={page >= meta.lastPage}
          >
            Suivant
          </Button>
        </div>
      ) : null}
    </>
  );
}
