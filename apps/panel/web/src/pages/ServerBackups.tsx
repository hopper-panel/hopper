import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useParams } from 'react-router-dom';
import { PageHeader } from '../components/PageHeader';
import { Modal } from '../components/Modal';
import { Toggle } from '../components/Toggle';
import { Alert, Badge, Button, Card, EmptyState, Field, Input, Spinner } from '../components/ui';
import { ApiError, api } from '../lib/api';
import { formatBytes, formatDate } from '../lib/format';
import { useServerContext } from '../lib/server-context';

interface Backup {
  uuid: string;
  name: string;
  sizeBytes: number;
  checksum: string | null;
  /** `null` tant que le node n'a pas rendu son verdict. */
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

/** Exemple montré dans le champ d'exclusions. */
const IGNORE_PLACEHOLDER = ['*.log', 'cache/', '!important.log'].join('\n');

export function ServerBackupsPage() {
  const { uuid = '' } = useParams();
  const queryClient = useQueryClient();
  // Permissions fournies par `ServerLayout`, comme pour les autres onglets.
  const { can } = useServerContext();

  const [name, setName] = useState('');
  const [ignored, setIgnored] = useState('');
  const [locked, setLocked] = useState(false);
  const [creating, setCreating] = useState(false);
  const [confirming, setConfirming] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);

  const backups = useQuery({
    queryKey: ['server', uuid, 'backups'],
    queryFn: () => api.get<BackupList>(`/api/servers/${uuid}/backups`),
    // Une sauvegarde en cours n'a pas d'événement pour signaler sa fin côté
    // navigateur : le verdict arrive du node au panel, pas jusqu'ici. On
    // interroge donc tant qu'il en reste une ouverte, et on s'arrête ensuite —
    // un intervalle permanent ferait battre l'API pour rien.
    refetchInterval: (query) =>
      query.state.data?.data.some((backup) => backup.successful === null) ? 3000 : false,
  });

  const refresh = (): void => {
    void queryClient.invalidateQueries({ queryKey: ['server', uuid, 'backups'] });
  };

  const fail = (error: unknown): void => {
    setFailure(error instanceof ApiError ? error.message : 'Opération impossible.');
  };

  const create = useMutation({
    mutationFn: () =>
      api.post<Backup>(`/api/servers/${uuid}/backups`, {
        name: name.trim() || undefined,
        // Les lignes vides sont retirées, mais rien d'autre n'est retouché :
        // le daemon écarte lui-même les commentaires, et normaliser ici ferait
        // diverger ce que l'utilisateur a écrit de ce qui est appliqué.
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
    return <Spinner label="Chargement des sauvegardes…" />;
  }

  const list = backups.data?.data ?? [];
  const meta = backups.data?.meta;
  const full = meta ? meta.used >= meta.limit : false;
  const running = list.some((backup) => backup.successful === null);

  return (
    <>
      <PageHeader
        title="Sauvegardes"
        description={
          meta
            ? `${meta.used} sur ${meta.limit} emplacement${meta.limit > 1 ? 's' : ''} utilisé${meta.used > 1 ? 's' : ''}.`
            : undefined
        }
        action={
          can('backup.create') ? (
            <Button variant="primary" onClick={() => setCreating(true)} disabled={running || full}>
              Créer une sauvegarde
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
        title="Créer une sauvegarde"
        onClose={() => setCreating(false)}
        footer={
          <>
            <Button variant="ghost" onClick={() => setCreating(false)}>
              Annuler
            </Button>
            <Button
              variant="primary"
              onClick={() => create.mutate()}
              disabled={create.isPending || running || full}
            >
              {create.isPending ? 'Lancement…' : 'Démarrer la sauvegarde'}
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-5">
          <Field label="Nom de la sauvegarde" hint="Laissé vide, un nom daté est attribué.">
            <Input
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="Sauvegarde du 3 août 2026 21:40"
            />
          </Field>

          <Field
            label="Fichiers et dossiers exclus"
            hint={
              <>
                Un motif par ligne, syntaxe <code>.gitignore</code> : <code>*</code> et{' '}
                <code>**</code> sont acceptés, et <code>!</code> en tête réintègre ce qu’une règle
                précédente excluait. Laissé vide, le fichier <code>.hopperignore</code> placé à la
                racine du serveur est utilisé s’il existe.
              </>
            }
          >
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
            label="Verrouillée"
            description="Empêche la suppression de cette sauvegarde, y compris par la rétention automatique, tant qu’elle n’est pas déverrouillée."
          />

          {running ? (
            <Alert tone="info">
              Une sauvegarde est déjà en cours. Attendez qu’elle se termine avant d’en lancer une
              autre.
            </Alert>
          ) : null}

          {full && !running ? (
            <Alert tone="info">
              Les {meta?.limit} emplacements sont utilisés : la plus ancienne sauvegarde non
              verrouillée sera remplacée.
            </Alert>
          ) : null}
        </div>
      </Modal>

      {list.length === 0 ? (
        <EmptyState
          title="Aucune sauvegarde"
          description="Une sauvegarde archive l’intégralité des fichiers du serveur et permet de revenir en arrière."
        />
      ) : (
        <div className="flex flex-col gap-2">
          {list.map((backup) => (
            <Card key={backup.uuid}>
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="truncate font-medium text-content">{backup.name}</span>
                    <StatusBadge backup={backup} />
                    {backup.locked && <Badge tone="warn">Verrouillée</Badge>}
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
                      Télécharger
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
                      {backup.locked ? 'Déverrouiller' : 'Verrouiller'}
                    </Button>
                  )}

                  {can('backup.restore') && backup.successful === true && (
                    <Button
                      variant="ghost"
                      onClick={() => setConfirming(`restore:${backup.uuid}`)}
                      disabled={restore.isPending}
                    >
                      Restaurer
                    </Button>
                  )}

                  {can('backup.delete') && backup.successful !== null && !backup.locked && (
                    <Button
                      variant="danger"
                      onClick={() => setConfirming(`delete:${backup.uuid}`)}
                      disabled={remove.isPending}
                    >
                      Supprimer
                    </Button>
                  )}
                </div>
              </div>

              {/* La restauration écrase le serveur : elle mérite une confirmation
                  qui dit exactement ce qui va disparaître, pas un « êtes-vous
                  sûr ? » que l'on valide sans lire. */}
              {confirming === `restore:${backup.uuid}` && (
                <div className="mt-3">
                  <Alert tone="info">
                    <p>
                      Tous les fichiers actuels du serveur seront supprimés puis remplacés par ceux
                      de cette sauvegarde. Le serveur doit être arrêté.
                    </p>
                    <div className="mt-3 flex gap-2">
                      <Button
                        variant="danger"
                        onClick={() => restore.mutate(backup.uuid)}
                        disabled={restore.isPending}
                      >
                        {restore.isPending ? 'Restauration…' : 'Restaurer et écraser'}
                      </Button>
                      <Button variant="ghost" onClick={() => setConfirming(null)}>
                        Annuler
                      </Button>
                    </div>
                  </Alert>
                </div>
              )}

              {confirming === `delete:${backup.uuid}` && (
                <div className="mt-3">
                  <Alert tone="danger">
                    <p>Cette archive sera définitivement supprimée du node.</p>
                    <div className="mt-3 flex gap-2">
                      <Button
                        variant="danger"
                        onClick={() => remove.mutate(backup.uuid)}
                        disabled={remove.isPending}
                      >
                        Supprimer définitivement
                      </Button>
                      <Button variant="ghost" onClick={() => setConfirming(null)}>
                        Annuler
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
  if (backup.successful === null) {
    return <Badge tone="warn">En cours…</Badge>;
  }

  return backup.successful ? (
    <Badge tone="online">Terminée</Badge>
  ) : (
    <Badge tone="danger">Échouée</Badge>
  );
}
