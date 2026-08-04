import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { ApiError, api } from '../lib/api';
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

const SCOPES: { value: string; label: string; description: string; adminOnly?: boolean }[] = [
  { value: 'read', label: 'Lecture', description: 'Consulter les serveurs, fichiers et sauvegardes.' },
  {
    value: 'write',
    label: 'Écriture',
    description: 'Agir : démarrer, arrêter, écrire un fichier, lancer une sauvegarde.',
  },
  {
    value: 'admin',
    label: 'Administration',
    description: 'Atteindre les routes d’administration de l’instance.',
    adminOnly: true,
  },
];

/**
 * Clés d'API du compte.
 *
 * Une clé n'accorde jamais plus que ce que son propriétaire possède déjà : elle
 * emprunte son accès, elle ne l'élargit pas. C'est ce qui permet de la ranger
 * dans « Mon compte » plutôt que dans l'administration.
 */
export function ApiKeysCard() {
  const { user } = useAuth();
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
        <h2 className="text-sm font-semibold uppercase tracking-wide text-content">Clés d’API</h2>

        {!creating ? (
          <Button onClick={() => setCreating(true)}>Créer une clé</Button>
        ) : (
          <Button variant="ghost" onClick={() => setCreating(false)}>
            Annuler
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
            Copiez cette clé maintenant : elle ne sera plus jamais affichée.
            <span className="mt-2 flex items-center gap-2 break-all rounded-lg bg-surface px-3 py-2 font-mono text-xs text-content">
              {issued}
              <CopyButton value={issued} />
            </span>
          </Alert>
        </div>
      ) : null}

      {creating ? (
        <div className="mb-4 flex flex-col gap-4 rounded-lg border border-border-subtle bg-surface p-4">
          <Field label="À quoi sert cette clé ?" hint="C’est ce qui vous dira laquelle révoquer.">
            <Input
              value={memo}
              onChange={(event) => setMemo(event.target.value)}
              placeholder="Bot Discord du staff"
            />
          </Field>

          <div>
            <p className="mb-2 text-sm font-medium text-content">Portée</p>

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
                      <span className="block text-sm text-content">{scope.label}</span>
                      <span className="block text-xs text-content-muted">{scope.description}</span>
                    </span>
                  </label>
                );
              })}
            </div>
          </div>

          <Field
            label="Adresses autorisées"
            hint="Facultatif. Séparées par des virgules ; laissé vide, aucune restriction."
          >
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
              {create.isPending ? 'Création…' : 'Créer'}
            </Button>
          </div>
        </div>
      ) : null}

      {list.length === 0 ? (
        <p className="text-sm text-content-muted">
          Aucune clé. Une clé d’API sert à piloter vos serveurs depuis un script ou un bot, avec vos
          propres accès.
        </p>
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
                    ? 'jamais utilisée'
                    : `dernière utilisation le ${formatDate(key.lastUsedAt)}`}
                  {key.allowedIps.length > 0 ? ` · depuis ${key.allowedIps.join(', ')}` : null}
                  {key.expiresAt === null ? null : ` · expire le ${formatDate(key.expiresAt)}`}
                </p>
              </div>

              <Button
                variant="danger"
                disabled={revoke.isPending}
                onClick={() => {
                  if (window.confirm(`Révoquer la clé « ${key.memo} » ?`)) {
                    revoke.mutate(key.identifier);
                  }
                }}
              >
                Révoquer
              </Button>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
