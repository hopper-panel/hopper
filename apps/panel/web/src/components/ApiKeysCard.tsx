import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { ApiError, api } from '../lib/api';
import { useTranslation, type MessageKey } from '../i18n';
import { useAuth } from '../lib/auth';
import { formatDate } from '../lib/format';
import { CopyButton } from './CopyButton';
import { Alert, Badge, Button, Card, Field, Input } from './ui';

interface ApiKey {
  identifier: string;
  key: string;
  memo: string;
  scopes: string[];
  allowedIps: string[];
  lastUsedAt: string | null;
  expiresAt: string | null;
  createdAt: string;
}

const SCOPES: {
  value: string;
  label: MessageKey;
  description: MessageKey;
  adminOnly?: boolean;
}[] = [
  {
    value: 'read',
    label: 'apiKeys.scopeRead',
    description: 'apiKeys.scopeReadHint',
  },
  {
    value: 'write',
    label: 'apiKeys.scopeWrite',
    description: 'apiKeys.scopeWriteHint',
  },
  {
    value: 'admin',
    label: 'apiKeys.scopeAdmin',
    description: 'apiKeys.scopeAdminHint',
    adminOnly: true,
  },
];

/**
 * API keys of the signed-in account.
 *
 * A key never grants more than its owner already holds: it borrows their
 * access, it does not widen it. That is what lets it live under "my account"
 * rather than under administration.
 */
export function ApiKeysCard() {
  const { user } = useAuth();
  const { t, locale } = useTranslation();
  const queryClient = useQueryClient();

  const [creating, setCreating] = useState(false);
  const [memo, setMemo] = useState('');
  const [scopes, setScopes] = useState<string[]>(['read']);
  const [allowedIps, setAllowedIps] = useState('');
  const [issued, setIssued] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);

  const keys = useQuery({
    queryKey: ['account', 'api-keys'],
    queryFn: () => api.get<ApiKey[]>('/api/account/api-keys'),
  });

  const refresh = (): void => {
    void queryClient.invalidateQueries({ queryKey: ['account', 'api-keys'] });
  };

  const create = useMutation({
    mutationFn: () =>
      api.post<{ token: string }>('/api/account/api-keys', {
        memo: memo.trim(),
        scopes,
        allowedIps: allowedIps
          .split(/[,\s]+/)
          .map((entry) => entry.trim())
          .filter(Boolean),
      }),
    onSuccess: (created) => {
      setIssued(created.token);
      setCreating(false);
      setMemo('');
      setScopes(['read']);
      setAllowedIps('');
      setFailure(null);
      refresh();
    },
    onError: (error: unknown) =>
      setFailure(error instanceof ApiError ? error.message : 'Création impossible.'),
  });

  const revoke = useMutation({
    mutationFn: (identifier: string) => api.delete<void>(`/api/account/api-keys/${identifier}`),
    onSuccess: () => {
      setFailure(null);
      refresh();
    },
    onError: (error: unknown) =>
      setFailure(error instanceof ApiError ? error.message : 'Révocation impossible.'),
  });

  const list = keys.data ?? [];

  return (
    <Card>
      <div className="mb-4 flex items-center justify-between gap-3">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-content">
          {t('apiKeys.title')}
        </h2>

        {!creating ? (
          <Button onClick={() => setCreating(true)}>{t('apiKeys.create')}</Button>
        ) : (
          <Button variant="ghost" onClick={() => setCreating(false)}>
            {t('common.cancel')}
          </Button>
        )}
      </div>

      {failure ? (
        <div className="mb-4">
          <Alert tone="danger">{failure}</Alert>
        </div>
      ) : null}

      {/* Montré une seule fois : le jeton n'est pas conservé en clair, et aucune
          route ne le réexpose. */}
      {issued ? (
        <div className="mb-4">
          <Alert tone="info">
            {t('apiKeys.issued')}
            <span className="mt-2 flex items-center gap-2 break-all rounded-lg bg-surface px-3 py-2 font-mono text-xs text-content">
              {issued}
              <CopyButton value={issued} />
            </span>
          </Alert>
        </div>
      ) : null}

      {creating ? (
        <div className="mb-4 flex flex-col gap-4 rounded-lg border border-border-subtle bg-surface p-4">
          <Field label={t('apiKeys.memo')} hint={t('apiKeys.memoHint')}>
            <Input
              value={memo}
              onChange={(event) => setMemo(event.target.value)}
              placeholder="Bot Discord du staff"
            />
          </Field>

          <div>
            <p className="mb-2 text-sm font-medium text-content">{t('apiKeys.scope')}</p>

            <div className="flex flex-col gap-1">
              {SCOPES.filter((scope) => !scope.adminOnly || user?.role === 'ADMIN').map((scope) => {
                const checked = scopes.includes(scope.value);

                return (
                  <label
                    key={scope.value}
                    className="flex cursor-pointer items-start gap-3 rounded-lg px-2 py-1.5 hover:bg-surface-hover"
                  >
                    <input
                      type="checkbox"
                      checked={checked}
                      className="mt-1"
                      onChange={() =>
                        setScopes(
                          checked
                            ? scopes.filter((entry) => entry !== scope.value)
                            : [...scopes, scope.value],
                        )
                      }
                    />
                    <span className="min-w-0">
                      <span className="block text-sm text-content">{t(scope.label)}</span>
                      <span className="block text-xs text-content-muted">
                        {t(scope.description)}
                      </span>
                    </span>
                  </label>
                );
              })}
            </div>
          </div>

          <Field label={t('apiKeys.allowedIps')} hint={t('apiKeys.allowedIpsHint')}>
            <Input
              value={allowedIps}
              onChange={(event) => setAllowedIps(event.target.value)}
              placeholder="203.0.113.7"
              className="font-mono"
            />
          </Field>

          <div className="flex justify-end">
            <Button
              variant="primary"
              disabled={create.isPending || memo.trim() === '' || scopes.length === 0}
              onClick={() => create.mutate()}
            >
              {create.isPending ? t('common.saving') : t('common.create')}
            </Button>
          </div>
        </div>
      ) : null}

      {list.length === 0 ? (
        <p className="text-sm text-content-muted">{t('apiKeys.empty')}</p>
      ) : (
        <ul className="flex flex-col gap-2">
          {list.map((key) => (
            <li
              key={key.identifier}
              className="flex flex-wrap items-start justify-between gap-3 rounded-lg border border-border-subtle bg-surface p-3"
            >
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-sm text-content">{key.memo}</span>
                  {key.scopes.map((scope) => (
                    <Badge key={scope} tone={scope === 'admin' ? 'danger' : 'offline'}>
                      {scope}
                    </Badge>
                  ))}
                </div>

                <p className="mt-1 font-mono text-xs text-content-subtle">{key.key}</p>

                <p className="mt-1 text-xs text-content-subtle">
                  {key.lastUsedAt === null
                    ? t('apiKeys.neverUsed')
                    : t('apiKeys.lastUsed', { date: formatDate(key.lastUsedAt, locale) })}
                  {key.allowedIps.length > 0 ? ` · depuis ${key.allowedIps.join(', ')}` : null}
                  {key.expiresAt === null ? null : ` · expire le ${formatDate(key.expiresAt)}`}
                </p>
              </div>

              <Button
                variant="danger"
                disabled={revoke.isPending}
                onClick={() => {
                  if (window.confirm(t('apiKeys.revokeConfirm', { memo: key.memo }))) {
                    revoke.mutate(key.identifier);
                  }
                }}
              >
                {t('apiKeys.revoke')}
              </Button>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
