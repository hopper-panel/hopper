import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from '../i18n';
import { api, ApiError } from '../lib/api';
import { Badge, Button, Card, Spinner } from './ui';

interface UpdateCheck {
  version: string;
  commit: string | null;
  commitDate: string | null;
  latest: string | null;
  latestDate: string | null;
  updateAvailable: boolean | null;
  reason?: string;
  checkedAt: string;
}

interface UpdateStatus {
  state: 'idle' | 'requested' | 'running' | 'succeeded' | 'failed';
  supported: boolean;
  log?: string;
}

/**
 * Panel version, and the button that updates it.
 *
 * The panel restarts in the middle of its own update, so the request will
 * almost always end in a failed poll rather than a tidy response. That is
 * expected and says nothing about whether the update worked — which is why a
 * dropped connection is reported as "restarting", not as an error.
 */
export function UpdateCard() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [applied, setApplied] = useState(false);

  const check = useQuery({
    queryKey: ['admin', 'updates'],
    queryFn: () => api.get<UpdateCheck>('/api/admin/updates'),
  });

  const status = useQuery({
    queryKey: ['admin', 'updates', 'status'],
    queryFn: () => api.get<UpdateStatus>('/api/admin/updates/status'),
    // Polled only while something is happening: the panel goes away mid-update
    // and comes back, and the poll is how the interface notices it returned.
    refetchInterval: applied ? 5000 : false,
    retry: false,
  });

  const apply = useMutation({
    mutationFn: () => api.post<{ accepted: true }>('/api/admin/updates/apply', {}),
    onSuccess: () => {
      setApplied(true);
      void queryClient.invalidateQueries({ queryKey: ['admin', 'updates', 'status'] });
    },
  });

  const refresh = useMutation({
    mutationFn: () => api.get<UpdateCheck>('/api/admin/updates?refresh=true'),
    onSuccess: (data) => queryClient.setQueryData(['admin', 'updates'], data),
  });

  const data = check.data;
  const unsupported = status.data?.supported === false;
  const running = applied || status.data?.state === 'running' || status.data?.state === 'requested';

  return (
    <Card>
      <div className="mb-4 flex items-start justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold uppercase tracking-wide text-content">
            {t('adminUpdates.title')}
          </h2>
          <p className="mt-1 text-sm text-content-muted">{t('adminUpdates.subtitle')}</p>
        </div>

        {data?.updateAvailable === true ? (
          <Badge tone="danger">{t('adminUpdates.available')}</Badge>
        ) : data?.updateAvailable === false ? (
          <Badge tone="online">{t('adminUpdates.upToDate')}</Badge>
        ) : null}
      </div>

      {check.isPending ? (
        <Spinner />
      ) : (
        <dl className="grid gap-2 text-sm sm:grid-cols-2">
          <div>
            <dt className="text-content-subtle">{t('adminUpdates.installed')}</dt>
            <dd className="font-mono text-content">
              {data?.version}
              {data?.commit ? ` · ${data.commit.slice(0, 7)}` : null}
            </dd>
          </div>
          <div>
            <dt className="text-content-subtle">{t('adminUpdates.latest')}</dt>
            <dd className="font-mono text-content">{data?.latest ?? '—'}</dd>
            {/* When the answer was obtained, not just what it was. "Up to date"
                with no time on it is a claim about now, and the check is
                cached: an operator who has just released something reads it as
                current and concludes their release never landed. */}
            {data?.checkedAt ? (
              <dd className="mt-0.5 text-xs text-content-subtle">
                {t('adminUpdates.checkedAt', {
                  time: new Date(data.checkedAt).toLocaleTimeString(),
                })}
              </dd>
            ) : null}
          </div>
        </dl>
      )}

      {/* An unreachable GitHub is shown as unknown, never as up to date: the one
          answer that would let an operator skip an update they needed. */}
      {data?.updateAvailable === null ? (
        <p className="mt-3 text-sm text-content-muted">
          {t('adminUpdates.unknown', { reason: data.reason ?? '' })}
        </p>
      ) : null}

      <div className="mt-4 flex flex-wrap items-center gap-2">
        <Button
          onClick={() => apply.mutate()}
          disabled={running || unsupported || data?.updateAvailable !== true}
        >
          {running ? t('adminUpdates.applying') : t('adminUpdates.apply')}
        </Button>

        <Button variant="ghost" onClick={() => refresh.mutate()} disabled={refresh.isPending}>
          {t('adminUpdates.recheck')}
        </Button>
      </div>

      {running ? (
        <p className="mt-3 text-sm text-content-muted">{t('adminUpdates.restarting')}</p>
      ) : null}

      {status.data?.state === 'failed' ? (
        <pre className="mt-3 max-h-40 overflow-auto rounded-lg bg-surface p-3 font-mono text-xs text-danger">
          {status.data.log ?? t('adminUpdates.failed')}
        </pre>
      ) : null}

      {/* An installation made before the updater existed has no unit to
          trigger. Showing the command beats a button that does nothing. */}
      {unsupported ? (
        <p className="mt-3 text-sm text-content-muted">{t('adminUpdates.manualOnly')}</p>
      ) : null}

      {apply.error instanceof ApiError ? (
        <p className="mt-3 text-sm text-danger">{apply.error.message}</p>
      ) : null}
    </Card>
  );
}
