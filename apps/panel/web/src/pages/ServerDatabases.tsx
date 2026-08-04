import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useParams } from 'react-router-dom';
import { CopyButton } from '../components/CopyButton';
import { Modal } from '../components/Modal';
import { PageHeader } from '../components/PageHeader';
import { Alert, Badge, Button, Card, EmptyState, Field, Input, Spinner } from '../components/ui';
import { ApiError, api } from '../lib/api';
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
    setFailure(error instanceof ApiError ? error.message : 'Opération impossible.');
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
    return <Spinner label="Chargement des bases de données…" />;
  }

  const list = databases.data?.data ?? [];
  const meta = databases.data?.meta;
  const full = meta ? meta.used >= meta.limit : true;

  return (
    <>
      <PageHeader
        title="Bases de données"
        description={
          meta && meta.limit > 0
            ? `${meta.used} sur ${meta.limit} base${meta.limit > 1 ? 's' : ''} autorisée${meta.limit > 1 ? 's' : ''}.`
            : 'Bases MySQL attribuées à ce serveur.'
        }
        action={
          can('database.create') && meta && meta.limit > 0 ? (
            <Button
              variant="primary"
              onClick={() => setCreating(true)}
              disabled={full || meta.hostsAvailable === 0}
            >
              Nouvelle base
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
          <Alert tone="info">
            Aucun serveur de bases de données n’est déclaré pour ce node. Un administrateur doit en
            ajouter un avant que vous puissiez créer une base.
          </Alert>
        </div>
      ) : null}

      {list.length === 0 ? (
        <EmptyState
          title="Aucune base de données"
          description={
            meta && meta.limit > 0
              ? 'Une base MySQL sert aux plugins qui gardent des données : permissions, protections, économie.'
              : 'Ce serveur n’est pas autorisé à disposer de bases de données. Demandez à un administrateur d’en relever la limite.'
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
        title="Créer une base de données"
        onClose={() => setCreating(false)}
        footer={
          <>
            <Button variant="ghost" onClick={() => setCreating(false)}>
              Annuler
            </Button>
            <Button
              variant="primary"
              onClick={() => create.mutate()}
              disabled={create.isPending || name.trim() === ''}
            >
              {create.isPending ? 'Création…' : 'Créer la base'}
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-5">
          <Field
            label="Nom de la base"
            hint="Lettres, chiffres et soulignés. Le nom réel sera préfixé par l’identifiant du serveur, pour qu’il ne puisse pas entrer en conflit avec celui d’un autre."
          >
            <Input
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="plugins"
            />
          </Field>

          <Field
            label="Connexions autorisées depuis"
            hint="Une adresse, un motif comme 192.168.1.%, ou vide pour autoriser n’importe quelle provenance."
          >
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
  // Le mot de passe est masqué par défaut : il est en clair dans la réponse —
  // il le faut, pour être recopié dans un plugin — mais l'afficher d'office le
  // livrerait à quiconque passe derrière l'écran.
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
                // Le changement est immédiat côté MySQL : un plugin encore
                // configuré avec l'ancien mot de passe perd la connexion à sa
                // prochaine requête.
                if (
                  window.confirm(
                    'Le nouveau mot de passe prend effet aussitôt. Les plugins configurés avec ' +
                      'l’ancien perdront la connexion. Continuer ?',
                  )
                ) {
                  onRotate();
                }
              }}
            >
              Changer le mot de passe
            </Button>
          ) : null}

          {canDelete ? (
            <Button
              variant="danger"
              disabled={busy}
              onClick={() => {
                const typed = window.prompt(
                  `Cette base et tout son contenu seront supprimés. Saisissez son nom pour confirmer : ${database.name}`,
                );

                if (typed?.trim() === database.name) {
                  onRemove();
                }
              }}
            >
              Supprimer
            </Button>
          ) : null}
        </div>
      </div>

      {/* Champs en ligne, sur toute la largeur : en colonnes, ils
          s'entassaient à gauche et laissaient la moitié de la carte vide. */}
      <dl className="mt-3 flex flex-wrap gap-x-8 gap-y-2 text-sm">
        <InlineField label="Hôte" value={`${database.host.address}:${database.host.port}`} />
        <InlineField label="Utilisateur" value={database.username} copyable />
        <InlineField
          label="Mot de passe"
          value={revealed ? database.password : '••••••••••••'}
          copyValue={database.password}
          copyable
          action={
            <button
              type="button"
              className="text-xs text-accent hover:underline"
              onClick={() => setRevealed((previous) => !previous)}
            >
              {revealed ? 'masquer' : 'afficher'}
            </button>
          }
        />
        <InlineField label="Connexions depuis" value={database.remote} />
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
 * Un champ sur une seule ligne : libellé, valeur, et de quoi la copier.
 *
 * Le libellé et la valeur partagent la ligne au lieu d'être empilés — sur une
 * carte large, quatre blocs de deux lignes créent surtout du vide.
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
  /** Valeur réellement copiée, si l'affichage est masqué. */
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
