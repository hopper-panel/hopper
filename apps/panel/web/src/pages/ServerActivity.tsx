import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { useParams } from 'react-router-dom';
import { PageHeader } from '../components/PageHeader';
import { Badge, Button, Card, EmptyState, Spinner } from '../components/ui';
import { useTranslation } from '../i18n';
import { api, type Paginated } from '../lib/api';
import { formatDate } from '../lib/format';

interface Entry {
  uuid: string;
  event: string;
  description: string;
  /** Null for a system action: scheduler, daemon. */
  actor: { username: string } | null;
  ip: string | null;
  createdAt: string;
}

export function ServerActivityPage() {
  const { t } = useTranslation();
  const { uuid = '' } = useParams();
  const [page, setPage] = useState(1);

  const activity = useQuery({
    queryKey: ['server', uuid, 'activity', page],
    queryFn: () => api.get<Paginated<Entry>>(`/api/servers/${uuid}/activity?page=${page}`),
    // The page being read must not shift under the eye: the log is read, not
    // watched live.
    refetchOnWindowFocus: false,
  });

  if (activity.isLoading) {
    return <Spinner label={t('common.loading')} />;
  }

  const entries = activity.data?.data ?? [];
  const meta = activity.data?.meta;

  return (
    <>
      <PageHeader title={t('activity.title')} description={t('activity.subtitle')} />

      {entries.length === 0 ? (
        <EmptyState title={t('activity.empty')} description={t('activity.emptyHint')} />
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
                      {/* An action with no actor comes from the scheduler or the
                          daemon: crediting nobody would be wrong, and crediting
                          a user even more so. */}
                      {entry.actor?.username ?? t('activity.system')}
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
            {t('common.previous')}
          </Button>

          <span className="text-sm text-content-muted">
            {t('common.page', { current: meta.currentPage, last: meta.lastPage })}
            <Badge>{t('activity.count', { count: meta.total })}</Badge>
          </span>

          <Button
            onClick={() => setPage((current) => current + 1)}
            disabled={page >= meta.lastPage}
          >
            {t('common.next')}
          </Button>
        </div>
      ) : null}
    </>
  );
}
