import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useParams } from 'react-router-dom';
import { PageHeader } from '../components/PageHeader';
import { Modal } from '../components/Modal';
import { Toggle } from '../components/Toggle';
import { Alert, Badge, Button, Card, EmptyState, Field, Input, Spinner } from '../components/ui';
import { ApiError, api } from '../lib/api';
import { formatBytes, formatDate } from '../lib/format';
import { useTranslation } from '../i18n';
import { useServerContext } from '../lib/server-context';

interface Backup {
  uuid: string;
  name: string;
  sizeBytes: number;
  checksum: string | null;
  /** `null` until the node has returned its verdict. */
  successful: boolean | null;
  error: string | null;
  locked: boolean;
  completedAt: string | null;
  createdAt: string;
}

interface BackupList {
  data: Backup[];
  meta: { limit: number; used: number };
}

/** Example shown in the exclusions field. */
const IGNORE_PLACEHOLDER = ['*.log', 'cache/', '!important.log'].join('\n');

export function ServerBackupsPage() {
  const { uuid = '' } = useParams();
  const queryClient = useQueryClient();
  // Permissions supplied by `ServerLayout`, as for the other tabs.
  const { can } = useServerContext();
  const { t } = useTranslation();

  const [name, setName] = useState('');
  const [ignored, setIgnored] = useState('');
  const [locked, setLocked] = useState(false);
  const [creating, setCreating] = useState(false);
  const [confirming, setConfirming] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);

  const backups = useQuery({
    queryKey: ['server', uuid, 'backups'],
    queryFn: () => api.get<BackupList>(`/api/servers/${uuid}/backups`),
    // A running backup has no event to signal its end browser-side: the
    // verdict travels from the node to the panel, not this far. So it polls
    // while one is still open, and stops afterwards — a permanent interval
    // would hammer the API for nothing.
    refetchInterval: (query) =>
      query.state.data?.data.some((backup) => backup.successful === null) ? 3000 : false,
  });

  const refresh = (): void => {
    void queryClient.invalidateQueries({ queryKey: ['server', uuid, 'backups'] });
  };

  const fail = (error: unknown): void => {
    setFailure(error instanceof ApiError ? error.message : t('common.operationFailed'));
  };

  const create = useMutation({
    mutationFn: () =>
      api.post<Backup>(`/api/servers/${uuid}/backups`, {
        name: name.trim() || undefined,
        // Empty lines are dropped, but nothing else is touched: the daemon
        // strips the comments itself, and normalising here would make what the
        // user wrote diverge from what is applied.
        ignoredFiles: ignored.split(/\r?\n/).filter((line) => line.trim() !== ''),
        locked,
      }),
    onSuccess: () => {
      setName('');
      setIgnored('');
      setLocked(false);
      setCreating(false);
      setFailure(null);
      refresh();
    },
    onError: fail,
  });

  const remove = useMutation({
    mutationFn: (backupUuid: string) =>
      api.delete<void>(`/api/servers/${uuid}/backups/${backupUuid}`),
    onSuccess: () => {
      setConfirming(null);
      setFailure(null);
      refresh();
    },
    onError: fail,
  });

  const toggleLock = useMutation({
    mutationFn: (input: { backupUuid: string; locked: boolean }) =>
      api.post<Backup>(`/api/servers/${uuid}/backups/${input.backupUuid}/lock`, {
        locked: input.locked,
      }),
    onSuccess: () => {
      setFailure(null);
      refresh();
    },
    onError: fail,
  });

  const restore = useMutation({
    mutationFn: (backupUuid: string) =>
      api.post<{ restoredFiles: number }>(`/api/servers/${uuid}/backups/${backupUuid}/restore`, {
        truncate: true,
      }),
    onSuccess: () => {
      setConfirming(null);
      setFailure(null);
      refresh();
    },
    onError: fail,
  });

  if (backups.isLoading) {
    return <Spinner label={t('common.loading')} />;
  }

  const list = backups.data?.data ?? [];
  const meta = backups.data?.meta;
  const full = meta ? meta.used >= meta.limit : false;
  const running = list.some((backup) => backup.successful === null);

  return (
    <>
      <PageHeader
        title={t('backups.title')}
        description={meta ? t('backups.slots', { used: meta.used, limit: meta.limit }) : undefined}
        action={
          can('backup.create') ? (
            <Button variant="primary" onClick={() => setCreating(true)} disabled={running || full}>
              {t('backups.create')}
            </Button>
          ) : null
        }
      />

      {failure && (
        <div className="mb-4">
          <Alert tone="danger">{failure}</Alert>
        </div>
      )}

      <Modal
        open={creating}
        title={t('backups.create')}
        onClose={() => setCreating(false)}
        footer={
          <>
            <Button variant="ghost" onClick={() => setCreating(false)}>
              {t('common.cancel')}
            </Button>
            <Button
              variant="primary"
              onClick={() => create.mutate()}
              disabled={create.isPending || running || full}
            >
              {create.isPending ? t('backups.creating') : t('backups.start')}
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-5">
          <Field label={t('backups.name')} hint={t('backups.nameHint')}>
            <Input
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder={t('backups.namePlaceholder')}
            />
          </Field>

          <Field label={t('backups.excluded')} hint={t('backups.excludedHint')}>
            <textarea
              className="min-h-32 w-full rounded-lg border border-border-subtle bg-surface px-3 py-2 font-mono text-xs text-content placeholder:text-content-subtle focus:border-accent focus:outline-none"
              placeholder={IGNORE_PLACEHOLDER}
              value={ignored}
              onChange={(event) => setIgnored(event.target.value)}
              spellCheck={false}
            />
          </Field>

          <Toggle
            checked={locked}
            onChange={setLocked}
            label={t('backups.locked')}
            description={t('backups.lockedHint')}
          />

          {running ? <Alert tone="info">{t('backups.runningNotice')}</Alert> : null}

          {full && !running ? (
            <Alert tone="info">{t('backups.fullNotice', { limit: meta?.limit ?? 0 })}</Alert>
          ) : null}
        </div>
      </Modal>

      {list.length === 0 ? (
        <EmptyState title={t('backups.empty')} description={t('backups.emptyHint')} />
      ) : (
        <div className="flex flex-col gap-2">
          {list.map((backup) => (
            <Card key={backup.uuid}>
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="truncate font-medium text-content">{backup.name}</span>
                    <StatusBadge backup={backup} />
                    {backup.locked && <Badge tone="warn">{t('backups.lockedBadge')}</Badge>}
                  </div>

                  <p className="mt-1 text-xs text-content-muted">
                    {formatDate(backup.createdAt)}
                    {backup.successful === true && ` · ${formatBytes(backup.sizeBytes)}`}
                  </p>

                  {backup.error && (
                    <p className="mt-1 text-xs text-danger" role="alert">
                      {backup.error}
                    </p>
                  )}
                </div>

                <div className="flex flex-wrap items-center gap-2">
                  {can('backup.download') && backup.successful === true && (
                    <a
                      href={`/api/servers/${uuid}/backups/${backup.uuid}/download`}
                      className="rounded-lg border border-border-subtle px-3 py-1.5 text-sm text-content-muted transition-colors hover:bg-surface-hover hover:text-content"
                    >
                      {t('backups.download')}
                    </a>
                  )}

                  {can('backup.delete') && (
                    <Button
                      variant="ghost"
                      onClick={() =>
                        toggleLock.mutate({ backupUuid: backup.uuid, locked: !backup.locked })
                      }
                      disabled={toggleLock.isPending}
                    >
                      {t(backup.locked ? 'backups.unlock' : 'backups.lock')}
                    </Button>
                  )}

                  {can('backup.restore') && backup.successful === true && (
                    <Button
                      variant="ghost"
                      onClick={() => setConfirming(`restore:${backup.uuid}`)}
                      disabled={restore.isPending}
                    >
                      {t('backups.restore')}
                    </Button>
                  )}

                  {can('backup.delete') && backup.successful !== null && !backup.locked && (
                    <Button
                      variant="danger"
                      onClick={() => setConfirming(`delete:${backup.uuid}`)}
                      disabled={remove.isPending}
                    >
                      {t('common.delete')}
                    </Button>
                  )}
                </div>
              </div>

              {/* Restoring overwrites the server: it deserves a confirmation
                  that says exactly what disappears, not an "are you sure?"
                  that gets clicked through. */}
              {confirming === `restore:${backup.uuid}` && (
                <div className="mt-3">
                  <Alert tone="info">
                    <p>{t('backups.restoreWarning')}</p>
                    <div className="mt-3 flex gap-2">
                      <Button
                        variant="danger"
                        onClick={() => restore.mutate(backup.uuid)}
                        disabled={restore.isPending}
                      >
                        {restore.isPending ? t('backups.restoring') : t('backups.restoreAction')}
                      </Button>
                      <Button variant="ghost" onClick={() => setConfirming(null)}>
                        {t('common.cancel')}
                      </Button>
                    </div>
                  </Alert>
                </div>
              )}

              {confirming === `delete:${backup.uuid}` && (
                <div className="mt-3">
                  <Alert tone="danger">
                    <p>{t('backups.deleteWarning')}</p>
                    <div className="mt-3 flex gap-2">
                      <Button
                        variant="danger"
                        onClick={() => remove.mutate(backup.uuid)}
                        disabled={remove.isPending}
                      >
                        {t('backups.deleteAction')}
                      </Button>
                      <Button variant="ghost" onClick={() => setConfirming(null)}>
                        {t('common.cancel')}
                      </Button>
                    </div>
                  </Alert>
                </div>
              )}
            </Card>
          ))}
        </div>
      )}
    </>
  );
}

function StatusBadge({ backup }: { backup: Backup }) {
  const { t } = useTranslation();

  if (backup.successful === null) {
    return <Badge tone="warn">{t('backups.inProgress')}</Badge>;
  }

  return backup.successful ? (
    <Badge tone="online">{t('backups.done')}</Badge>
  ) : (
    <Badge tone="danger">{t('backups.failed')}</Badge>
  );
}
