import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Modal } from '../../components/Modal';
import { PageHeader } from '../../components/PageHeader';
import { Alert, Badge, Button, Card, EmptyState, Field, Input, Spinner } from '../../components/ui';
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
    setFailure(error instanceof ApiError ? error.message : 'Opération impossible.');
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
      setNotice('Serveur déclaré : la connexion et les droits ont été vérifiés.');
      refresh();
    },
    onError: fail,
  });

  const test = useMutation({
    mutationFn: (uuid: string) =>
      api.post<{ version: string }>(`/api/admin/database-hosts/${uuid}/test`),
    onSuccess: (data) => {
      setFailure(null);
      setNotice(`Connexion établie — version ${data.version}.`);
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
    return <Spinner label="Chargement des serveurs de bases…" />;
  }

  const list = hosts.data?.data ?? [];

  return (
    <>
      <PageHeader
        title="Serveurs de bases de données"
        description="Serveurs MySQL ou MariaDB sur lesquels les serveurs de jeu peuvent créer leurs bases."
        action={
          <Button variant="primary" onClick={() => setDraft({ ...EMPTY })}>
            Déclarer un serveur
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
        <EmptyState
          title="Aucun serveur de bases déclaré"
          description="Tant qu’aucun n’est déclaré, l’onglet « Bases de données » d’un serveur ne peut rien créer."
        />
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
                      <Badge tone="warn">tous les nodes</Badge>
                    )}
                    <Badge>{host.databases} base(s)</Badge>
                  </div>

                  <p className="mt-1 font-mono text-xs text-content-muted">
                    {host.username}@{host.host}:{host.port}
                    {host.publicHost ? ` · annoncé : ${host.publicHost}` : null}
                  </p>
                </div>

                <div className="flex flex-wrap gap-2">
                  <Button onClick={() => test.mutate(host.uuid)} disabled={test.isPending}>
                    Tester
                  </Button>

                  <Button
                    variant="danger"
                    disabled={remove.isPending}
                    onClick={() => {
                      if (window.confirm(`Retirer le serveur « ${host.name} » ?`)) {
                        remove.mutate(host.uuid);
                      }
                    }}
                  >
                    Retirer
                  </Button>
                </div>
              </div>
            </Card>
          ))}
        </div>
      )}

      <Modal
        open={draft !== null}
        title="Déclarer un serveur de bases de données"
        onClose={() => setDraft(null)}
        footer={
          <>
            <Button variant="ghost" onClick={() => setDraft(null)}>
              Annuler
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
              {create.isPending ? 'Vérification…' : 'Déclarer'}
            </Button>
          </>
        }
      >
        {draft ? (
          <div className="flex flex-col gap-5">
            <Field label="Nom">
              <Input
                value={draft.name}
                onChange={(event) => setDraft({ ...draft, name: event.target.value })}
                placeholder="MariaDB local"
              />
            </Field>

            <div className="grid gap-4 sm:grid-cols-3">
              <div className="sm:col-span-2">
                <Field
                  label="Adresse vue par le panel"
                  hint="Celle qu’emprunte le panel pour administrer le serveur SQL."
                >
                  <Input
                    value={draft.host}
                    onChange={(event) => setDraft({ ...draft, host: event.target.value })}
                    placeholder="127.0.0.1"
                    className="font-mono"
                  />
                </Field>
              </div>

              <Field label="Port">
                <Input
                  value={draft.port}
                  onChange={(event) => setDraft({ ...draft, port: event.target.value })}
                  className="font-mono"
                />
              </Field>
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Compte d’administration">
                <Input
                  value={draft.username}
                  onChange={(event) => setDraft({ ...draft, username: event.target.value })}
                  className="font-mono"
                />
              </Field>

              <Field
                label="Mot de passe"
                hint="Stocké chiffré : le panel doit le présenter à chaque connexion."
              >
                <Input
                  type="password"
                  value={draft.password}
                  onChange={(event) => setDraft({ ...draft, password: event.target.value })}
                />
              </Field>
            </div>

            <Field
              label="Adresse annoncée aux joueurs"
              hint="Laissée vide, c’est l’adresse ci-dessus qui est communiquée. À renseigner quand le panel passe par un réseau interne inaccessible de l’extérieur."
            >
              <Input
                value={draft.publicHost}
                onChange={(event) => setDraft({ ...draft, publicHost: event.target.value })}
                placeholder="mysql.exemple.fr"
                className="font-mono"
              />
            </Field>

            <Field
              label="Réservé à un node"
              hint="Une base gagne à vivre près du serveur qui l’interroge. Sans choix, ce serveur est proposé à tous les nodes."
            >
              <select
                className="w-full rounded-lg border border-border-subtle bg-surface px-3 py-2 text-sm text-content"
                value={draft.nodeUuid}
                onChange={(event) => setDraft({ ...draft, nodeUuid: event.target.value })}
              >
                <option value="">Tous les nodes</option>
                {(nodes.data?.data ?? []).map((node) => (
                  <option key={node.uuid} value={node.uuid}>
                    {node.name}
                  </option>
                ))}
              </select>
            </Field>

            {/* La déclaration éprouve la connexion **et** les droits : un compte
                qui se connecte sans pouvoir créer de base donnerait un serveur
                qui paraît sain et échoue à la première utilisation. */}
            <Alert tone="info">
              La connexion sera testée avant enregistrement, droits de création compris.
            </Alert>
          </div>
        ) : null}
      </Modal>
    </>
  );
}
