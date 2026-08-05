import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Modal } from '../../components/Modal';
import { PageHeader } from '../../components/PageHeader';
import { Alert, Badge, Button, Card, EmptyState, Field, Input, Spinner } from '../../components/ui';
import { useTranslation } from '../../i18n';
import { ApiError, api, type Paginated } from '../../lib/api';

interface Host {
  uuid: string;
  name: string;
  host: string;
  port: number;
  username: string;
  publicHost: string | null;
  publicPort: number | null;
  node: { uuid: string; name: string } | null;
  databases: number;
}

interface NodeOption {
  uuid: string;
  name: string;
}

const EMPTY = {
  name: '',
  host: '',
  port: '3306',
  username: '',
  password: '',
  publicHost: '',
  nodeUuid: '',
};

export function AdminDatabaseHostsPage() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState<typeof EMPTY | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const hosts = useQuery({
    queryKey: ['admin', 'database-hosts'],
    queryFn: () => api.get<{ data: Host[] }>('/api/admin/database-hosts'),
  });

  const nodes = useQuery({
    queryKey: ['admin', 'nodes', 'options'],
    queryFn: () => api.get<Paginated<NodeOption>>('/api/admin/nodes?perPage=100'),
  });

  const refresh = (): void => {
    void queryClient.invalidateQueries({ queryKey: ['admin', 'database-hosts'] });
  };

  const fail = (error: unknown): void => {
    setNotice(null);
    setFailure(error instanceof ApiError ? error.message : t('common.operationFailed'));
  };

  const create = useMutation({
    mutationFn: (input: typeof EMPTY) =>
      api.post<{ uuid: string }>('/api/admin/database-hosts', {
        name: input.name.trim(),
        host: input.host.trim(),
        port: Number(input.port) || 3306,
        username: input.username.trim(),
        password: input.password,
        publicHost: input.publicHost.trim() || undefined,
        nodeUuid: input.nodeUuid || undefined,
      }),
    onSuccess: () => {
      setDraft(null);
      setFailure(null);
      setNotice(t('adminHosts.declared'));
      refresh();
    },
    onError: fail,
  });

  const test = useMutation({
    mutationFn: (uuid: string) =>
      api.post<{ version: string }>(`/api/admin/database-hosts/${uuid}/test`),
    onSuccess: (data) => {
      setFailure(null);
      setNotice(t('adminHosts.connected', { version: data.version }));
    },
    onError: fail,
  });

  const remove = useMutation({
    mutationFn: (uuid: string) => api.delete<void>(`/api/admin/database-hosts/${uuid}`),
    onSuccess: () => {
      setFailure(null);
      setNotice(null);
      refresh();
    },
    onError: fail,
  });

  if (hosts.isLoading) {
    return <Spinner label={t('common.loading')} />;
  }

  const list = hosts.data?.data ?? [];

  return (
    <>
      <PageHeader
        title={t('adminHosts.title')}
        description={t('adminHosts.subtitle')}
        action={
          <Button variant="primary" onClick={() => setDraft({ ...EMPTY })}>
            {t('adminHosts.declare')}
          </Button>
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
        <EmptyState title={t('adminHosts.empty')} description={t('adminHosts.emptyHint')} />
      ) : (
        <div className="flex flex-col gap-2">
          {list.map((host) => (
            <Card key={host.uuid}>
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-medium text-content">{host.name}</span>
                    {host.node ? (
                      <Badge>{host.node.name}</Badge>
                    ) : (
                      <Badge tone="warn">{t('adminHosts.allNodes')}</Badge>
                    )}
                    <Badge>{t('adminHosts.databases', { count: host.databases })}</Badge>
                  </div>

                  <p className="mt-1 font-mono text-xs text-content-muted">
                    {host.username}@{host.host}:{host.port}
                    {host.publicHost
                      ? ` · ${t('adminHosts.announced', { host: host.publicHost })}`
                      : null}
                  </p>
                </div>

                <div className="flex flex-wrap gap-2">
                  <Button onClick={() => test.mutate(host.uuid)} disabled={test.isPending}>
                    {t('adminHosts.test')}
                  </Button>

                  <Button
                    variant="danger"
                    disabled={remove.isPending}
                    onClick={() => {
                      if (window.confirm(t('adminHosts.confirmRemove', { name: host.name }))) {
                        remove.mutate(host.uuid);
                      }
                    }}
                  >
                    {t('adminHosts.remove')}
                  </Button>
                </div>
              </div>
            </Card>
          ))}
        </div>
      )}

      <Modal
        open={draft !== null}
        title={t('adminHosts.modalTitle')}
        onClose={() => setDraft(null)}
        footer={
          <>
            <Button variant="ghost" onClick={() => setDraft(null)}>
              {t('common.cancel')}
            </Button>
            <Button
              variant="primary"
              onClick={() => draft && create.mutate(draft)}
              disabled={
                create.isPending ||
                !draft?.name.trim() ||
                !draft.host.trim() ||
                !draft.username.trim() ||
                !draft.password
              }
            >
              {create.isPending ? t('adminHosts.checking') : t('adminHosts.declare')}
            </Button>
          </>
        }
      >
        {draft ? (
          <div className="flex flex-col gap-5">
            <Field label={t('adminHosts.name')}>
              <Input
                value={draft.name}
                onChange={(event) => setDraft({ ...draft, name: event.target.value })}
                placeholder={t('adminHosts.namePlaceholder')}
              />
            </Field>

            <div className="grid gap-4 sm:grid-cols-3">
              <div className="sm:col-span-2">
                <Field label={t('adminHosts.panelAddress')} hint={t('adminHosts.panelAddressHint')}>
                  <Input
                    value={draft.host}
                    onChange={(event) => setDraft({ ...draft, host: event.target.value })}
                    placeholder="127.0.0.1"
                    className="font-mono"
                  />
                </Field>
              </div>

              <Field label={t('adminHosts.port')}>
                <Input
                  value={draft.port}
                  onChange={(event) => setDraft({ ...draft, port: event.target.value })}
                  className="font-mono"
                />
              </Field>
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
              <Field label={t('adminHosts.account')}>
                <Input
                  value={draft.username}
                  onChange={(event) => setDraft({ ...draft, username: event.target.value })}
                  className="font-mono"
                />
              </Field>

              <Field label={t('adminHosts.password')} hint={t('adminHosts.passwordHint')}>
                <Input
                  type="password"
                  value={draft.password}
                  onChange={(event) => setDraft({ ...draft, password: event.target.value })}
                />
              </Field>
            </div>

            <Field label={t('adminHosts.publicAddress')} hint={t('adminHosts.publicAddressHint')}>
              <Input
                value={draft.publicHost}
                onChange={(event) => setDraft({ ...draft, publicHost: event.target.value })}
                placeholder={t('adminHosts.publicPlaceholder')}
                className="font-mono"
              />
            </Field>

            <Field label={t('adminHosts.nodeScope')} hint={t('adminHosts.nodeScopeHint')}>
              <select
                className="w-full rounded-lg border border-border-subtle bg-surface px-3 py-2 text-sm text-content"
                value={draft.nodeUuid}
                onChange={(event) => setDraft({ ...draft, nodeUuid: event.target.value })}
              >
                <option value="">{t('adminHosts.allNodesOption')}</option>
                {(nodes.data?.data ?? []).map((node) => (
                  <option key={node.uuid} value={node.uuid}>
                    {node.name}
                  </option>
                ))}
              </select>
            </Field>

            {/* Declaring probes the connection *and* the privileges: an account
                that connects without being able to create a database would look
                healthy and fail on first use. */}
            <Alert tone="info">{t('adminHosts.willTest')}</Alert>
          </div>
        ) : null}
      </Modal>
    </>
  );
}
