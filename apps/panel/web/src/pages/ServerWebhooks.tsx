import { PERMISSIONS } from '@hopper/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { CopyButton } from '../components/CopyButton';
import { Modal } from '../components/Modal';
import { PageHeader } from '../components/PageHeader';
import { Alert, Badge, Button, Card, EmptyState, Field, Input, Spinner } from '../components/ui';
import { ApiError, api } from '../lib/api';
import { formatDate } from '../lib/format';
import { useTranslation, type MessageKey } from '../i18n';
import { useServerContext } from '../lib/server-context';

/**
 * Subscribable events.
 *
 * Kept on the interface side rather than read from the API: their labels have
 * to be translated, and a list rendered by the server would ship interface text
 * inside a JSON response.
 */
const EVENTS: { value: string; label: MessageKey; description: MessageKey }[] = [
  {
    value: 'server.started',
    label: 'webhooks.eventServerStarted',
    description: 'webhooks.eventServerStartedHint',
  },
  {
    value: 'server.stopped',
    label: 'webhooks.eventServerStopped',
    description: 'webhooks.eventServerStoppedHint',
  },
  {
    value: 'server.crashed',
    label: 'webhooks.eventServerCrashed',
    description: 'webhooks.eventServerCrashedHint',
  },
  {
    value: 'backup.completed',
    label: 'webhooks.eventBackupCompleted',
    description: 'webhooks.eventBackupCompletedHint',
  },
  {
    value: 'backup.failed',
    label: 'webhooks.eventBackupFailed',
    description: 'webhooks.eventBackupFailedHint',
  },
  {
    value: 'install.completed',
    label: 'webhooks.eventInstallCompleted',
    description: 'webhooks.eventInstallCompletedHint',
  },
  {
    value: 'install.failed',
    label: 'webhooks.eventInstallFailed',
    description: 'webhooks.eventInstallFailedHint',
  },
];

interface Webhook {
  uuid: string;
  url: string;
  description: string;
  events: string[];
  active: boolean;
  lastStatus: number | null;
  lastError: string | null;
  lastAttemptAt: string | null;
  lastSuccessAt: string | null;
  failureCount: number;
}

const EMPTY = { url: '', description: '', events: ['server.crashed'] as string[] };

export function ServerWebhooksPage() {
  const { server, can } = useServerContext();
  const { t, locale } = useTranslation();
  const queryClient = useQueryClient();

  const [draft, setDraft] = useState<typeof EMPTY | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [secret, setSecret] = useState<{ uuid: string; value: string } | null>(null);

  const webhooks = useQuery({
    queryKey: ['server', server.uuid, 'webhooks'],
    queryFn: () => api.get<{ data: Webhook[] }>(`/api/servers/${server.uuid}/webhooks`),
  });

  const refresh = (): void => {
    void queryClient.invalidateQueries({ queryKey: ['server', server.uuid, 'webhooks'] });
  };

  const fail = (error: unknown): void => {
    setNotice(null);
    setFailure(error instanceof ApiError ? error.message : t('common.operationFailed'));
  };

  const create = useMutation({
    mutationFn: (input: typeof EMPTY) =>
      api.post<Webhook>(`/api/servers/${server.uuid}/webhooks`, {
        url: input.url.trim(),
        description: input.description.trim(),
        events: input.events,
      }),
    onSuccess: () => {
      setDraft(null);
      setFailure(null);
      setNotice(t('webhooks.saved'));
      refresh();
    },
    onError: fail,
  });

  const toggle = useMutation({
    mutationFn: ({ uuid, active }: { uuid: string; active: boolean }) =>
      api.patch<Webhook>(`/api/servers/${server.uuid}/webhooks/${uuid}`, { active }),
    onSuccess: () => {
      setFailure(null);
      refresh();
    },
    onError: fail,
  });

  const test = useMutation({
    mutationFn: (uuid: string) =>
      api.post<{ delivered: boolean; status: number | null; error: string | null }>(
        `/api/servers/${server.uuid}/webhooks/${uuid}/test`,
      ),
    onSuccess: (result) => {
      setFailure(result.delivered ? null : (result.error ?? t('webhooks.testFailed')));
      setNotice(result.delivered ? t('webhooks.tested') : null);
      refresh();
    },
    onError: fail,
  });

  const reveal = useMutation({
    mutationFn: (uuid: string) =>
      api
        .get<{ secret: string }>(`/api/servers/${server.uuid}/webhooks/${uuid}/secret`)
        .then((response) => ({ uuid, value: response.secret })),
    onSuccess: setSecret,
    onError: fail,
  });

  const remove = useMutation({
    mutationFn: (uuid: string) => api.delete<void>(`/api/servers/${server.uuid}/webhooks/${uuid}`),
    onSuccess: () => {
      setFailure(null);
      setNotice(null);
      refresh();
    },
    onError: fail,
  });

  if (webhooks.isLoading) {
    return <Spinner label={t('common.loading')} />;
  }

  const list = webhooks.data?.data ?? [];

  return (
    <>
      <PageHeader
        title={t('webhooks.title')}
        description={t('webhooks.subtitle')}
        action={
          can(PERMISSIONS.WEBHOOK_CREATE) ? (
            <Button variant="primary" onClick={() => setDraft({ ...EMPTY })}>
              {t('webhooks.add')}
            </Button>
          ) : null
        }
      />

      {failure ? (
        <div className="mb-4">
          <Alert tone="danger">{failure}</Alert>
        </div>
      ) : null}

      {notice && !failure ? (
        <div className="mb-4">
          <Alert tone="info">{notice}</Alert>
        </div>
      ) : null}

      {list.length === 0 ? (
        <EmptyState title={t('webhooks.empty')} description={t('webhooks.emptyHint')} />
      ) : (
        <div className="flex flex-col gap-2">
          {list.map((webhook) => (
            <Card key={webhook.uuid}>
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="truncate font-mono text-sm text-content">
                      {redact(webhook.url)}
                    </span>
                    {webhook.active ? (
                      <Badge tone="online">{t('webhooks.active')}</Badge>
                    ) : (
                      <Badge tone="danger">{t('webhooks.paused')}</Badge>
                    )}
                  </div>

                  {webhook.description ? (
                    <p className="mt-1 text-sm text-content-muted">{webhook.description}</p>
                  ) : null}

                  <p className="mt-1 text-xs text-content-subtle">
                    {webhook.events.map(labelOf).join(' · ')}
                  </p>

                  <p className="mt-1 text-xs text-content-subtle">
                    {webhook.lastAttemptAt === null
                      ? t('webhooks.neverCalled')
                      : webhook.lastError
                        ? t('webhooks.lastFailed', { error: webhook.lastError })
                        : t('webhooks.lastSucceeded', {
                            date: formatDate(webhook.lastSuccessAt, locale),
                          })}
                    {webhook.failureCount > 0
                      ? ` · ${t('webhooks.failureStreak', { count: webhook.failureCount })}`
                      : null}
                  </p>

                  {secret?.uuid === webhook.uuid ? (
                    <p className="mt-2 flex items-center gap-2 break-all rounded-lg bg-surface px-3 py-2 font-mono text-xs text-content">
                      {secret.value}
                      <CopyButton value={secret.value} />
                    </p>
                  ) : null}
                </div>

                <div className="flex flex-wrap gap-2">
                  {can(PERMISSIONS.WEBHOOK_UPDATE) ? (
                    <>
                      <Button onClick={() => test.mutate(webhook.uuid)} disabled={test.isPending}>
                        {t('webhooks.test')}
                      </Button>
                      <Button
                        onClick={() => reveal.mutate(webhook.uuid)}
                        disabled={reveal.isPending}
                      >
                        {t('webhooks.secret')}
                      </Button>
                      <Button
                        onClick={() =>
                          toggle.mutate({ uuid: webhook.uuid, active: !webhook.active })
                        }
                        disabled={toggle.isPending}
                      >
                        {t(webhook.active ? 'webhooks.pause' : 'webhooks.resume')}
                      </Button>
                    </>
                  ) : null}

                  {can(PERMISSIONS.WEBHOOK_DELETE) ? (
                    <Button
                      variant="danger"
                      disabled={remove.isPending}
                      onClick={() => {
                        if (window.confirm(t('webhooks.deleteConfirm'))) {
                          remove.mutate(webhook.uuid);
                        }
                      }}
                    >
                      {t('common.delete')}
                    </Button>
                  ) : null}
                </div>
              </div>
            </Card>
          ))}
        </div>
      )}

      <Modal
        open={draft !== null}
        title={t('webhooks.addTitle')}
        onClose={() => setDraft(null)}
        footer={
          <>
            <Button variant="ghost" onClick={() => setDraft(null)}>
              {t('common.cancel')}
            </Button>
            <Button
              variant="primary"
              disabled={create.isPending || !draft?.url.trim() || draft.events.length === 0}
              onClick={() => draft && create.mutate(draft)}
            >
              {create.isPending ? t('webhooks.adding') : t('common.create')}
            </Button>
          </>
        }
      >
        {draft ? (
          <div className="flex flex-col gap-5">
            <Field label={t('webhooks.url')} hint={t('webhooks.urlHint')}>
              <Input
                value={draft.url}
                onChange={(event) => setDraft({ ...draft, url: event.target.value })}
                placeholder={t('webhooks.urlPlaceholder')}
                className="font-mono"
              />
            </Field>

            <Field label={t('webhooks.description')} hint={t('webhooks.descriptionHint')}>
              <Input
                value={draft.description}
                onChange={(event) => setDraft({ ...draft, description: event.target.value })}
                placeholder={t('webhooks.descriptionPlaceholder')}
              />
            </Field>

            <div>
              <p className="mb-2 text-sm font-medium text-content">{t('webhooks.events')}</p>

              <div className="flex flex-col gap-1">
                {EVENTS.map((event) => {
                  const checked = draft.events.includes(event.value);

                  return (
                    <label
                      key={event.value}
                      className="flex cursor-pointer items-start gap-3 rounded-lg px-2 py-1.5 hover:bg-surface-hover"
                    >
                      <input
                        type="checkbox"
                        checked={checked}
                        className="mt-1"
                        onChange={() =>
                          setDraft({
                            ...draft,
                            events: checked
                              ? draft.events.filter((entry) => entry !== event.value)
                              : [...draft.events, event.value],
                          })
                        }
                      />
                      <span className="min-w-0">
                        <span className="block text-sm text-content">{t(event.label)}</span>
                        <span className="block text-xs text-content-muted">
                          {t(event.description)}
                        </span>
                      </span>
                    </label>
                  );
                })}
              </div>
            </div>

            {/* The panel will send a request to this address: saying so is what
                justifies refusing internal ones. */}
            <Alert tone="info">{t('webhooks.notice')}</Alert>
          </div>
        ) : null}
      </Modal>
    </>
  );
}

function labelOf(value: string): string {
  return EVENTS.find((event) => event.value === value)?.label ?? value;
}

/**
 * Masks the secret part of a webhook address.
 *
 * A Discord webhook URL **is** its password: whoever reads it can post in the
 * channel. Showing it whole on a page one gladly shows to staff would hand it
 * to anyone looking over the shoulder.
 */
function redact(url: string): string {
  try {
    const parsed = new URL(url);
    const segments = parsed.pathname.split('/').filter(Boolean);

    if (segments.length <= 1) {
      return `${parsed.origin}/${segments.join('/')}`;
    }

    return `${parsed.origin}/${segments.slice(0, -1).join('/')}/••••`;
  } catch {
    return url;
  }
}
