import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useParams } from 'react-router-dom';
import { PageHeader } from '../components/PageHeader';
import { Alert, Badge, Button, Card, EmptyState, Input, Spinner } from '../components/ui';
import { ApiError, api } from '../lib/api';
import { useServerContext } from '../lib/server-context';

interface Allocation {
  id: number;
  ip: string;
  port: number;
  alias: string | null;
  primary: boolean;
}

interface AllocationList {
  data: Allocation[];
  meta: { limit: number; used: number; availableOnNode: number };
}

export function ServerNetworkPage() {
  const { uuid = '' } = useParams();
  const queryClient = useQueryClient();
  const { can } = useServerContext();

  const [failure, setFailure] = useState<string | null>(null);

  const allocations = useQuery({
    queryKey: ['server', uuid, 'allocations'],
    queryFn: () => api.get<AllocationList>(`/api/servers/${uuid}/allocations`),
  });

  const refresh = (): void => {
    void queryClient.invalidateQueries({ queryKey: ['server', uuid, 'allocations'] });
    // Le port principal figure dans l'en-tête du serveur : sans cela, il y
    // afficherait encore l'ancien.
    void queryClient.invalidateQueries({ queryKey: ['server', uuid] });
  };

  const fail = (error: unknown): void => {
    setFailure(error instanceof ApiError ? error.message : 'Opération impossible.');
  };

  const setAlias = useMutation({
    mutationFn: (input: { id: number; alias: string }) =>
      api.patch<Allocation>(`/api/servers/${uuid}/allocations/${input.id}`, {
        alias: input.alias.trim() || null,
      }),
    onSuccess: refresh,
    onError: fail,
  });

  const setPrimary = useMutation({
    mutationFn: (id: number) =>
      api.post<{ changed: boolean }>(`/api/servers/${uuid}/allocations/${id}/primary`),
    onSuccess: () => {
      setFailure(null);
      refresh();
    },
    onError: fail,
  });

  const add = useMutation({
    mutationFn: () => api.post<Allocation>(`/api/servers/${uuid}/allocations`),
    onSuccess: () => {
      setFailure(null);
      refresh();
    },
    onError: fail,
  });

  const remove = useMutation({
    mutationFn: (id: number) => api.delete<void>(`/api/servers/${uuid}/allocations/${id}`),
    onSuccess: () => {
      setFailure(null);
      refresh();
    },
    onError: fail,
  });

  if (allocations.isLoading) {
    return <Spinner label="Chargement des ports…" />;
  }

  const list = allocations.data?.data ?? [];
  const meta = allocations.data?.meta;
  const full = meta ? meta.used >= meta.limit : true;

  return (
    <>
      <PageHeader
        title="Réseau"
        description={
          meta
            ? `${meta.used} port${meta.used > 1 ? 's' : ''} attribué${meta.used > 1 ? 's' : ''}` +
              (meta.limit > 0 ? ` sur ${meta.limit} autorisé${meta.limit > 1 ? 's' : ''}.` : '.')
            : undefined
        }
        action={
          can('allocation.create') && meta && meta.limit > 0 ? (
            <Button
              variant="primary"
              onClick={() => add.mutate()}
              disabled={add.isPending || full || meta.availableOnNode === 0}
            >
              {add.isPending ? 'Attribution…' : 'Ajouter un port'}
            </Button>
          ) : null
        }
      />

      {failure ? (
        <div className="mb-4">
          <Alert tone="danger">{failure}</Alert>
        </div>
      ) : null}

      {meta && meta.limit > 0 && meta.availableOnNode === 0 && !full ? (
        <div className="mb-4">
          <Alert tone="info">
            Aucun port libre sur ce node. Un administrateur doit en ajouter à la machine.
          </Alert>
        </div>
      ) : null}

      {list.length === 0 ? (
        <EmptyState
          title="Aucun port attribué"
          description="Un port est l’adresse sur laquelle les joueurs se connectent. Le port principal est celui écrit dans server.properties au démarrage."
        />
      ) : (
        <div className="flex flex-col gap-2">
          {list.map((allocation) => (
            <AllocationRow
              key={allocation.id}
              allocation={allocation}
              canUpdate={can('allocation.update')}
              canDelete={can('allocation.delete')}
              busy={setPrimary.isPending || remove.isPending || setAlias.isPending}
              onAlias={(alias) => setAlias.mutate({ id: allocation.id, alias })}
              onPrimary={() => setPrimary.mutate(allocation.id)}
              onRemove={() => remove.mutate(allocation.id)}
            />
          ))}
        </div>
      )}

      <p className="mt-4 text-xs text-content-muted">
        Changer le port principal prend effet au <strong>prochain démarrage</strong> : il est écrit
        dans la configuration du serveur au lancement, pas pendant qu’il tourne.
      </p>
    </>
  );
}

function AllocationRow({
  allocation,
  canUpdate,
  canDelete,
  busy,
  onAlias,
  onPrimary,
  onRemove,
}: {
  allocation: Allocation;
  canUpdate: boolean;
  canDelete: boolean;
  busy: boolean;
  onAlias: (alias: string) => void;
  onPrimary: () => void;
  onRemove: () => void;
}) {
  const [alias, setAlias] = useState(allocation.alias ?? '');

  return (
    <Card>
      <div className="flex flex-wrap items-center gap-4">
        <div>
          <code className="rounded bg-surface px-2 py-1 font-mono text-sm text-content">
            {allocation.ip}
          </code>
          <span className="mt-1 block text-xs uppercase tracking-wide text-content-subtle">
            adresse
          </span>
        </div>

        <div>
          <code className="rounded bg-surface px-2 py-1 font-mono text-sm text-content">
            {allocation.port}
          </code>
          <span className="mt-1 block text-xs uppercase tracking-wide text-content-subtle">
            port
          </span>
        </div>

        <div className="min-w-48 flex-1">
          <Input
            value={alias}
            placeholder="Note — dynmap, voice, domaine annoncé…"
            disabled={!canUpdate}
            onChange={(event) => setAlias(event.target.value)}
            // Enregistré à la sortie du champ plutôt qu'à chaque frappe : une
            // requête par caractère saturerait l'API pour un champ libre.
            onBlur={() => {
              if (alias !== (allocation.alias ?? '')) {
                onAlias(alias);
              }
            }}
          />
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {allocation.primary ? (
            <Badge tone="online">principal</Badge>
          ) : canUpdate ? (
            <Button onClick={onPrimary} disabled={busy}>
              Définir principal
            </Button>
          ) : null}

          {/* Le port principal n'est pas retirable : le serveur n'aurait plus
              d'adresse d'écoute. Masquer le bouton évite un refus qui
              ressemblerait à une panne. */}
          {canDelete && !allocation.primary ? (
            <Button variant="danger" onClick={onRemove} disabled={busy}>
              Retirer
            </Button>
          ) : null}
        </div>
      </div>
    </Card>
  );
}
