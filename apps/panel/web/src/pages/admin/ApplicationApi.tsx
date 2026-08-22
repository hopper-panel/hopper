import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Modal } from '../../components/Modal';
import { PageHeader } from '../../components/PageHeader';
import { Alert, Badge, Button, Card, EmptyState, Field, Input, Spinner } from '../../components/ui';
import { useTranslation, type MessageKey } from '../../i18n';
import { ApiError, api } from '../../lib/api';

/**
 * Application keys — the credentials a hosting provider's own software holds.
 *
 * The screen exists because a credential nobody can see is one nobody revokes.
 * `hopper application-key:create` was enough to make the first key during an
 * installation; it is not enough to answer "which of these is still being used,
 * and by what" six months later, which is the question that decides whether an
 * old key gets deleted or left alone for ever.
 */

type Level = 'none' | 'read' | 'write';

interface KeyRow {
  uuid: string;
  name: string;
  key: string;
  permissions: Record<string, Level>;
  allowedIps: string[];
  lastUsedAt: string | null;
  expiresAt: string | null;
  revokedAt: string | null;
  createdAt: string;
  createdBy: string | null;
}

interface ResourceRow {
  resource: string;
  levels: Level[];
}

/** Labels come from the catalogue; the API only ever sends resource names. */
const RESOURCE_LABELS: Record<string, MessageKey> = {
  servers: 'adminAppApi.resource.servers',
  users: 'adminAppApi.resource.users',
  plans: 'adminAppApi.resource.plans',
  nodes: 'adminAppApi.resource.nodes',
  allocations: 'adminAppApi.resource.allocations',
  templates: 'adminAppApi.resource.templates',
};

export function AdminApplicationApiPage() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();

  const [draft, setDraft] = useState<{
    name: string;
    allowedIps: string;
    permissions: Record<string, Level>;
  } | null>(null);
  const [issued, setIssued] = useState<{ name: string; token: string } | null>(null);
  const [failure, setFailure] = useState<string | null>(null);

  const keys = useQuery({
    queryKey: ['admin', 'application-keys'],
    queryFn: () => api.get<KeyRow[]>('/api/admin/application-keys'),
  });

  /**
   * The matrix comes from the API rather than being written here.
   *
   * Two lists of resources — one validating, one rendering — is how a resource
   * added on one side becomes a row nobody can tick, or a permission nobody can
   * see.
   */
  const resources = useQuery({
    queryKey: ['admin', 'application-keys', 'resources'],
    queryFn: () => api.get<{ resources: ResourceRow[] }>('/api/admin/application-keys/resources'),
  });

  const fail = (error: unknown): void => {
    setFailure(error instanceof ApiError ? error.message : t('common.operationFailed'));
  };

  const create = useMutation({
    mutationFn: (input: NonNullable<typeof draft>) =>
      api.post<{ name: string; token: string }>('/api/admin/application-keys', {
        name: input.name.trim(),
        permissions: input.permissions,
        allowedIps: input.allowedIps
          .split(',')
          .map((entry) => entry.trim())
          .filter((entry) => entry !== ''),
      }),
    onSuccess: (data) => {
      setDraft(null);
      setFailure(null);
      // Shown once, in a box the operator has to close deliberately: the token
      // is stored hashed, and closing this without copying it means making
      // another key.
      setIssued({ name: data.name, token: data.token });
      void queryClient.invalidateQueries({ queryKey: ['admin', 'application-keys'] });
    },
    onError: fail,
  });

  const revoke = useMutation({
    mutationFn: (uuid: string) => api.delete<void>(`/api/admin/application-keys/${uuid}`),
    onSuccess: () => {
      setFailure(null);
      void queryClient.invalidateQueries({ queryKey: ['admin', 'application-keys'] });
    },
    onError: fail,
  });

  if (keys.isLoading || resources.isLoading) {
    return <Spinner label={t('common.loading')} />;
  }

  const rows = keys.data ?? [];
  const matrix = resources.data?.resources ?? [];

  const startDraft = (): void => {
    setDraft({
      name: '',
      allowedIps: '',
      // Everything at `none`: the shortest path through this form must not be
      // the one that grants the most.
      permissions: Object.fromEntries(matrix.map((row) => [row.resource, 'none'])),
    });
  };

  const setAll = (level: Level): void => {
    setDraft((current) =>
      current === null
        ? current
        : {
            ...current,
            permissions: Object.fromEntries(
              matrix.map((row) => [
                row.resource,
                // "Read & write all" means "as much as each line allows": four
                // of the six have no write route, and skipping them entirely
                // would make the shortcut useless.
                row.levels.includes(level) ? level : row.levels[row.levels.length - 1]!,
              ]),
            ),
          },
    );
  };

  return (
    <>
      <PageHeader
        title={t('adminAppApi.title')}
        description={t('adminAppApi.subtitle')}
        action={
          <Button variant="primary" onClick={startDraft}>
            {t('adminAppApi.create')}
          </Button>
        }
      />

      {failure ? (
        <div className="mb-4">
          <Alert tone="danger">{failure}</Alert>
        </div>
      ) : null}

      {rows.length === 0 ? (
        <EmptyState title={t('adminAppApi.empty')} description={t('adminAppApi.emptyHint')} />
      ) : (
        <div className="flex flex-col gap-2">
          {rows.map((row) => (
            <Card key={row.uuid}>
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-medium text-content">{row.name}</span>
                    {row.revokedAt === null ? null : (
                      <Badge tone="danger">{t('adminAppApi.revoked')}</Badge>
                    )}
                    {row.createdBy === null ? null : (
                      <Badge>{t('adminAppApi.by', { name: row.createdBy })}</Badge>
                    )}
                  </div>

                  <p className="mt-1 font-mono text-xs text-content-muted">{row.key}</p>

                  <div className="mt-2 flex flex-wrap gap-1.5">
                    {Object.entries(row.permissions)
                      .filter(([, level]) => level !== 'none')
                      .map(([resource, level]) => (
                        <Badge key={resource} tone={level === 'write' ? 'warn' : undefined}>
                          {t(RESOURCE_LABELS[resource] ?? 'adminAppApi.resource.unknown')}
                          {' · '}
                          {t(
                            level === 'write' ? 'adminAppApi.levelWrite' : 'adminAppApi.levelRead',
                          )}
                        </Badge>
                      ))}
                  </div>

                  <p className="mt-2 text-xs text-content-muted">
                    {t('adminAppApi.lastUsed', {
                      when:
                        row.lastUsedAt === null
                          ? t('common.never')
                          : new Date(row.lastUsedAt).toLocaleString(),
                    })}
                    {' · '}
                    {t('adminAppApi.created', {
                      when: new Date(row.createdAt).toLocaleDateString(),
                    })}
                    {row.allowedIps.length === 0
                      ? ''
                      : ` · ${t('adminAppApi.fromAddresses', { list: row.allowedIps.join(', ') })}`}
                  </p>
                </div>

                {row.revokedAt === null ? (
                  <Button
                    variant="danger"
                    disabled={revoke.isPending}
                    onClick={() => {
                      if (window.confirm(t('adminAppApi.confirmRevoke', { name: row.name }))) {
                        revoke.mutate(row.uuid);
                      }
                    }}
                  >
                    {t('adminAppApi.revoke')}
                  </Button>
                ) : null}
              </div>
            </Card>
          ))}
        </div>
      )}

      <Modal
        open={draft !== null}
        size="lg"
        title={t('adminAppApi.newTitle')}
        onClose={() => setDraft(null)}
        footer={
          <>
            <Button onClick={() => setDraft(null)}>{t('common.cancel')}</Button>
            <Button
              variant="primary"
              disabled={create.isPending || (draft?.name.trim() ?? '') === ''}
              onClick={() => {
                if (draft) {
                  create.mutate(draft);
                }
              }}
            >
              {create.isPending ? t('common.saving') : t('common.create')}
            </Button>
          </>
        }
      >
        {draft === null ? null : (
          <div className="flex flex-col gap-4">
            <Field label={t('adminAppApi.name')} hint={t('adminAppApi.nameHint')}>
              <Input
                value={draft.name}
                autoFocus
                placeholder="Paymenter"
                onChange={(event) => setDraft({ ...draft, name: event.target.value })}
              />
            </Field>

            <Field label={t('adminAppApi.addresses')} hint={t('adminAppApi.addressesHint')}>
              <Input
                value={draft.allowedIps}
                placeholder="203.0.113.7"
                onChange={(event) => setDraft({ ...draft, allowedIps: event.target.value })}
              />
            </Field>

            <div>
              <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                <span className="text-sm font-medium text-content">
                  {t('adminAppApi.permissions')}
                </span>

                <div className="flex gap-2">
                  <Button onClick={() => setAll('none')}>{t('adminAppApi.noneAll')}</Button>
                  <Button onClick={() => setAll('read')}>{t('adminAppApi.readAll')}</Button>
                  <Button onClick={() => setAll('write')}>{t('adminAppApi.writeAll')}</Button>
                </div>
              </div>

              <div className="overflow-hidden rounded-lg border border-border-subtle">
                {matrix.map((row, index) => (
                  <div
                    key={row.resource}
                    className={`flex flex-wrap items-center justify-between gap-3 px-3 py-2.5 ${
                      index % 2 === 0 ? '' : 'bg-surface-raised'
                    }`}
                  >
                    <span className="text-sm text-content">
                      {t(RESOURCE_LABELS[row.resource] ?? 'adminAppApi.resource.unknown')}
                    </span>

                    <div className="flex gap-4">
                      {(['none', 'read', 'write'] as const).map((level) => {
                        const offered = row.levels.includes(level);

                        return (
                          <label
                            key={level}
                            title={offered ? undefined : t('adminAppApi.readOnlyResource')}
                            className={`flex items-center gap-1.5 text-sm ${
                              offered
                                ? 'cursor-pointer text-content-muted'
                                : 'cursor-not-allowed text-content-muted/40'
                            }`}
                          >
                            <input
                              type="radio"
                              name={`permission-${row.resource}`}
                              disabled={!offered}
                              checked={draft.permissions[row.resource] === level}
                              onChange={() =>
                                setDraft({
                                  ...draft,
                                  permissions: { ...draft.permissions, [row.resource]: level },
                                })
                              }
                            />
                            {t(
                              level === 'none'
                                ? 'adminAppApi.levelNone'
                                : level === 'read'
                                  ? 'adminAppApi.levelRead'
                                  : 'adminAppApi.levelWrite',
                            )}
                          </label>
                        );
                      })}
                    </div>
                  </div>
                ))}
              </div>

              <p className="mt-2 text-xs text-content-muted">{t('adminAppApi.permissionsHint')}</p>
            </div>
          </div>
        )}
      </Modal>

      <Modal
        open={issued !== null}
        title={t('adminAppApi.issuedTitle')}
        onClose={() => setIssued(null)}
        footer={<Button onClick={() => setIssued(null)}>{t('common.close')}</Button>}
      >
        {issued === null ? null : (
          <div className="flex flex-col gap-3">
            <Alert tone="info">{t('adminAppApi.issuedOnce')}</Alert>

            <code className="block break-all rounded-lg border border-border-subtle bg-surface-raised p-3 font-mono text-xs text-content">
              {issued.token}
            </code>

            <p className="text-xs text-content-muted">
              {t('adminAppApi.issuedHint', { name: issued.name })}
            </p>
          </div>
        )}
      </Modal>
    </>
  );
}
