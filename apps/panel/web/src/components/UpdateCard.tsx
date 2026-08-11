import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
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

  // Asked afresh on every mount, never served from the browser's cache. The
  // question is "is there an update right now", and any answer kept from
  // earlier is an answer to a different question. The panel keeps a one-minute
  // floor so a held-down reload cannot spend the API quota it shares.
  const check = useQuery({
    queryKey: ['admin', 'updates'],
    queryFn: () => api.get<UpdateCheck>('/api/admin/updates?refresh=true'),
    staleTime: 0,
    refetchOnMount: 'always',
  });

  const status = useQuery({
    queryKey: ['admin', 'updates', 'status'],
    queryFn: () => api.get<UpdateStatus>('/api/admin/updates/status'),
    // Polled only while something is happening: the panel goes away mid-update
    // and comes back, and the poll is how the interface notices it returned.
    //
    // Every two seconds rather than five, because this interval is now what
    // stands between the update finishing and the page showing the version it
    // finished on.
    refetchInterval: applied ? 2000 : false,
    retry: false,
  });

  /**
   * The reload the card has been promising.
   *
   * "This page will come back" was written in three languages and implemented
   * nowhere: the poll noticed `succeeded` and then did nothing with it, so the
   * card sat on "Updating…" until somebody pressed F5 — on an installation
   * that had finished updating minutes earlier.
   *
   * A full reload rather than refetching the queries, and that is the whole
   * reason this is not `invalidateQueries`. Vite stamps a digest into every
   * asset name, so the JavaScript this page is running no longer exists on
   * the server it is talking to. Only fetching `index.html` again picks up the
   * new names.
   *
   * Gated on `applied`, so a `succeeded` left over from an update somebody ran
   * last week does not reload the page of whoever opens the settings next.
   */
  useEffect(() => {
    if (!applied || status.data?.state !== 'succeeded') {
      return;
    }

    // The answer carrying `succeeded` came from the panel that has already
    // restarted — it is the one that served this very poll — so there is
    // nothing left to wait for.
    window.location.reload();
  }, [applied, status.data?.state]);

  const apply = useMutation({
    mutationFn: () => api.post<{ accepted: true }>('/api/admin/updates/apply', {}),
    onSuccess: () => {
      setApplied(true);
      void queryClient.invalidateQueries({ queryKey: ['admin', 'updates', 'status'] });
    },
  });

  const data = check.data;
  const unsupported = status.data?.supported === false;

  // `applied` alone used to keep the card on "Updating…" for ever once the
  // button had been pressed, including after the unit reported a failure: the
  // log appeared underneath while the button above it still said the work was
  // under way.
  const finished = status.data?.state === 'failed' || status.data?.state === 'succeeded';
  const running =
    !finished &&
    (applied || status.data?.state === 'running' || status.data?.state === 'requested');

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
