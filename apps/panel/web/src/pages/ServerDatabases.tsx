import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useParams } from 'react-router-dom';
import { CopyButton } from '../components/CopyButton';
import { Modal } from '../components/Modal';
import { PageHeader } from '../components/PageHeader';
import { Alert, Badge, Button, Card, EmptyState, Field, Input, Spinner } from '../components/ui';
import { ApiError, api } from '../lib/api';
import { useTranslation } from '../i18n';
import { useServerContext } from '../lib/server-context';

interface Database {
  uuid: string;
  name: string;
  username: string;
  password: string;
  remote: string;
  host: { name: string; address: string; port: number };
  connectionString: string;
  createdAt: string;
}

interface DatabaseList {
  data: Database[];
  meta: { limit: number; used: number; hostsAvailable: number };
}

export function ServerDatabasesPage() {
  const { uuid = '' } = useParams();
  const queryClient = useQueryClient();
  const { can } = useServerContext();
  const { t } = useTranslation();

  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const [remote, setRemote] = useState('');
  const [failure, setFailure] = useState<string | null>(null);

  const databases = useQuery({
    queryKey: ['server', uuid, 'databases'],
    queryFn: () => api.get<DatabaseList>(`/api/servers/${uuid}/databases`),
  });

  const refresh = (): void => {
    void queryClient.invalidateQueries({ queryKey: ['server', uuid, 'databases'] });
  };

  const fail = (error: unknown): void => {
    setFailure(error instanceof ApiError ? error.message : t('common.operationFailed'));
  };

  const create = useMutation({
    mutationFn: () =>
      api.post<Database>(`/api/servers/${uuid}/databases`, {
        name: name.trim(),
        remote: remote.trim() || undefined,
      }),
    onSuccess: () => {
      setCreating(false);
      setName('');
      setRemote('');
      setFailure(null);
      refresh();
    },
    onError: fail,
  });

  const rotate = useMutation({
    mutationFn: (databaseUuid: string) =>
      api.post<Database>(`/api/servers/${uuid}/databases/${databaseUuid}/rotate`),
    onSuccess: () => {
      setFailure(null);
      refresh();
    },
    onError: fail,
  });

  const remove = useMutation({
    mutationFn: (databaseUuid: string) =>
      api.delete<void>(`/api/servers/${uuid}/databases/${databaseUuid}`),
    onSuccess: () => {
      setFailure(null);
      refresh();
    },
    onError: fail,
  });

  if (databases.isLoading) {
    return <Spinner label={t('common.loading')} />;
  }

  const list = databases.data?.data ?? [];
  const meta = databases.data?.meta;
  const full = meta ? meta.used >= meta.limit : true;

  return (
    <>
      <PageHeader
        title={t('databases.title')}
        description={
          meta && meta.limit > 0
            ? t('databases.count', { used: meta.used, limit: meta.limit })
            : t('databases.subtitle')
        }
        action={
          can('database.create') && meta && meta.limit > 0 ? (
            <Button
              variant="primary"
              onClick={() => setCreating(true)}
              disabled={full || meta.hostsAvailable === 0}
            >
              {t('databases.new')}
            </Button>
          ) : null
        }
      />

      {failure ? (
        <div className="mb-4">
          <Alert tone="danger">{failure}</Alert>
        </div>
      ) : null}

      {meta && meta.limit > 0 && meta.hostsAvailable === 0 ? (
        <div className="mb-4">
          <Alert tone="info">{t('databases.noHost')}</Alert>
        </div>
      ) : null}

      {list.length === 0 ? (
        <EmptyState
          title={t('databases.empty')}
          description={
            meta && meta.limit > 0 ? t('databases.emptyHint') : t('databases.notAllowed')
          }
        />
      ) : (
        <div className="flex flex-col gap-3">
          {list.map((database) => (
            <DatabaseCard
              key={database.uuid}
              database={database}
              canRotate={can('database.update')}
              canDelete={can('database.delete')}
              busy={rotate.isPending || remove.isPending}
              onRotate={() => rotate.mutate(database.uuid)}
              onRemove={() => remove.mutate(database.uuid)}
            />
          ))}
        </div>
      )}

      <Modal
        open={creating}
        title={t('databases.createTitle')}
        onClose={() => setCreating(false)}
        footer={
          <>
            <Button variant="ghost" onClick={() => setCreating(false)}>
              {t('common.cancel')}
            </Button>
            <Button
              variant="primary"
              onClick={() => create.mutate()}
              disabled={create.isPending || name.trim() === ''}
            >
              {create.isPending ? t('databases.creating') : t('databases.create')}
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-5">
          <Field label={t('databases.name')} hint={t('databases.nameHint')}>
            <Input
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder={t('databases.namePlaceholder')}
            />
          </Field>

          <Field label={t('databases.remote')} hint={t('databases.remoteHint')}>
            <Input
              value={remote}
              onChange={(event) => setRemote(event.target.value)}
              placeholder="%"
              className="font-mono"
            />
          </Field>
        </div>
      </Modal>
    </>
  );
}

function DatabaseCard({
  database,
  canRotate,
  canDelete,
  busy,
  onRotate,
  onRemove,
}: {
  database: Database;
  canRotate: boolean;
  canDelete: boolean;
  busy: boolean;
  onRotate: () => void;
  onRemove: () => void;
}) {
  const { t } = useTranslation();
  // The password is hidden by default: it comes in clear in the response — it
  // has to, so it can be pasted into a plugin — but showing it outright would
  // hand it to whoever walks past the screen.
  const [revealed, setRevealed] = useState(false);

  return (
    <Card>
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border-subtle pb-3">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-mono font-medium text-content">{database.name}</span>
          <Badge>{database.host.name}</Badge>
        </div>

        <div className="flex flex-wrap gap-2">
          {canRotate ? (
            <Button
              variant="ghost"
              disabled={busy}
              onClick={() => {
                // The change is immediate on the MySQL side: a plugin still
                // holding the old password loses its next connection.
                if (window.confirm(t('databases.rotateConfirm'))) {
                  onRotate();
                }
              }}
            >
              {t('databases.rotate')}
            </Button>
          ) : null}

          {canDelete ? (
            <Button
              variant="danger"
              disabled={busy}
              onClick={() => {
                const typed = window.prompt(t('databases.deletePrompt', { name: database.name }));

                if (typed?.trim() === database.name) {
                  onRemove();
                }
              }}
            >
              {t('common.delete')}
            </Button>
          ) : null}
        </div>
      </div>

      {/* Fields in a row, across the full width: in columns they
          piled up on the left and left half the card empty. */}
      <dl className="mt-3 flex flex-wrap gap-x-8 gap-y-2 text-sm">
        <InlineField
          label={t('databases.host')}
          value={`${database.host.address}:${database.host.port}`}
        />
        <InlineField label={t('databases.user')} value={database.username} copyable />
        <InlineField
          label={t('databases.password')}
          value={revealed ? database.password : '••••••••••••'}
          copyValue={database.password}
          copyable
          action={
            <button
              type="button"
              className="text-xs text-accent hover:underline"
              onClick={() => setRevealed((previous) => !previous)}
            >
              {t(revealed ? 'databases.hide' : 'databases.show')}
            </button>
          }
        />
        <InlineField label={t('databases.remoteLabel')} value={database.remote} />
      </dl>

      <div className="mt-3 flex items-center gap-2 rounded-lg bg-surface px-3 py-2">
        <code className="min-w-0 flex-1 truncate font-mono text-xs text-content-muted">
          {database.connectionString}
        </code>
        <CopyButton value={database.connectionString} />
      </div>
    </Card>
  );
}

/**
 * A one-line field: label, value, and a way to copy it.
 *
 * Label and value share the line rather than stacking — on a wide card, four
 * two-line blocks mostly create emptiness.
 */
function InlineField({
  label,
  value,
  copyValue,
  copyable,
  action,
}: {
  label: string;
  value: string;
  /** The value actually copied, when the display is masked. */
  copyValue?: string;
  copyable?: boolean;
  action?: React.ReactNode;
}) {
  return (
    <div className="flex min-w-0 items-baseline gap-2">
      <dt className="whitespace-nowrap text-xs text-content-muted">{label}</dt>
      <dd className="truncate font-mono text-xs text-content">{value}</dd>
      {action}
      {copyable ? <CopyButton value={copyValue ?? value} /> : null}
    </div>
  );
}
