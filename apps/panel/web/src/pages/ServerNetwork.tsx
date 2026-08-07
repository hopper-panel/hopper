import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useParams } from 'react-router-dom';
import { PageHeader } from '../components/PageHeader';
import { Alert, Badge, Button, Card, EmptyState, Input, Spinner } from '../components/ui';
import { ApiError, api } from '../lib/api';
import { useTranslation } from '../i18n';
import { useServerContext } from '../lib/server-context';

interface Allocation {
  id: number;
  ip: string;
  port: number;
  alias: string | null;
  /**
   * What the server's own configuration reaches this port by. Unlike the
   * alias, which is a note for whoever is reading the page, this is matched
   * against: a readiness check declaring `rcon` knocks on the port named
   * `rcon`. The primary port carries none — it is what everything means by
   * "the port" already.
   */
  role: string | null;
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
  const { t } = useTranslation();

  const [failure, setFailure] = useState<string | null>(null);

  const allocations = useQuery({
    queryKey: ['server', uuid, 'allocations'],
    queryFn: () => api.get<AllocationList>(`/api/servers/${uuid}/allocations`),
  });

  const refresh = (): void => {
    void queryClient.invalidateQueries({ queryKey: ['server', uuid, 'allocations'] });
    // The primary port shows in the server header: without this it would still
    // show the old one.
    void queryClient.invalidateQueries({ queryKey: ['server', uuid] });
  };

  const fail = (error: unknown): void => {
    setFailure(error instanceof ApiError ? error.message : t('common.operationFailed'));
  };

  const setAlias = useMutation({
    mutationFn: (input: { id: number; alias: string }) =>
      api.patch<Allocation>(`/api/servers/${uuid}/allocations/${input.id}`, {
        alias: input.alias.trim() || null,
      }),
    onSuccess: refresh,
    onError: fail,
  });

  // Its own request rather than a field on the one above: the panel asks the
  // node whether its daemon understands names before storing one, and the
  // refusal it can come back with has to reach the operator instead of being
  // lost behind a note being saved at the same time.
  const setRole = useMutation({
    mutationFn: (input: { id: number; role: string }) =>
      api.patch<Allocation>(`/api/servers/${uuid}/allocations/${input.id}/role`, {
        role: input.role.trim() || null,
      }),
    onSuccess: () => {
      setFailure(null);
      refresh();
    },
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
    return <Spinner label={t('common.loading')} />;
  }

  const list = allocations.data?.data ?? [];
  const meta = allocations.data?.meta;
  const full = meta ? meta.used >= meta.limit : true;

  return (
    <>
      <PageHeader
        title={t('network.title')}
        description={
          meta
            ? meta.limit > 0
              ? t('network.countLimited', { used: meta.used, limit: meta.limit })
              : t('network.count', { used: meta.used })
            : undefined
        }
        action={
          can('allocation.create') && meta && meta.limit > 0 ? (
            <Button
              variant="primary"
              onClick={() => add.mutate()}
              disabled={add.isPending || full || meta.availableOnNode === 0}
            >
              {add.isPending ? t('network.adding') : t('network.add')}
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
          <Alert tone="info">{t('network.noFreePorts')}</Alert>
        </div>
      ) : null}

      {list.length === 0 ? (
        <EmptyState title={t('network.empty')} description={t('network.subtitle')} />
      ) : (
        <div className="flex flex-col gap-2">
          {list.map((allocation) => (
            <AllocationRow
              key={allocation.id}
              allocation={allocation}
              canUpdate={can('allocation.update')}
              canDelete={can('allocation.delete')}
              busy={
                setPrimary.isPending || remove.isPending || setAlias.isPending || setRole.isPending
              }
              onAlias={(alias) => setAlias.mutate({ id: allocation.id, alias })}
              onRole={(role) => setRole.mutate({ id: allocation.id, role })}
              onPrimary={() => setPrimary.mutate(allocation.id)}
              onRemove={() => remove.mutate(allocation.id)}
            />
          ))}
        </div>
      )}

      <p className="mt-4 text-xs text-content-muted">{t('network.nextBoot')}</p>
      <p className="mt-2 text-xs text-content-muted">{t('network.roleHint')}</p>
    </>
  );
}

function AllocationRow({
  allocation,
  canUpdate,
  canDelete,
  busy,
  onAlias,
  onRole,
  onPrimary,
  onRemove,
}: {
  allocation: Allocation;
  canUpdate: boolean;
  canDelete: boolean;
  busy: boolean;
  onAlias: (alias: string) => void;
  onRole: (role: string) => void;
  onPrimary: () => void;
  onRemove: () => void;
}) {
  const { t } = useTranslation();
  const [alias, setAlias] = useState(allocation.alias ?? '');
  const [role, setRole] = useState(allocation.role ?? '');

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
            placeholder={t('network.notePlaceholder')}
            disabled={!canUpdate}
            onChange={(event) => setAlias(event.target.value)}
            // Saved on blur rather than on every keystroke: one request per
            // character would flood the API for a free-text field.
            onBlur={() => {
              if (alias !== (allocation.alias ?? '')) {
                onAlias(alias);
              }
            }}
          />
        </div>

        {/* The primary port gets no field: it is reached by being the primary,
            and a second name for it would be a second way to mean one port. */}
        {allocation.primary ? null : (
          <div className="min-w-40">
            <Input
              value={role}
              placeholder={t('network.rolePlaceholder')}
              disabled={!canUpdate}
              onChange={(event) => setRole(event.target.value)}
              onBlur={() => {
                if (role !== (allocation.role ?? '')) {
                  onRole(role);
                }
              }}
            />
          </div>
        )}

        <div className="flex flex-wrap items-center gap-2">
          {allocation.primary ? (
            <Badge tone="online">{t('network.primary')}</Badge>
          ) : canUpdate ? (
            <Button onClick={onPrimary} disabled={busy}>
              {t('network.makePrimary')}
            </Button>
          ) : null}

          {/* The primary port cannot be removed: the server would have no
              listen address. Hiding the button avoids a refusal that would
              look like a breakage. */}
          {canDelete && !allocation.primary ? (
            <Button variant="danger" onClick={onRemove} disabled={busy}>
              {t('network.remove')}
            </Button>
          ) : null}
        </div>
      </div>
    </Card>
  );
}
