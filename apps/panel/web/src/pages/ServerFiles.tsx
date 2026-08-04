import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState, type DragEvent, type MouseEvent } from 'react';

import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { FileBreadcrumb } from '../components/FileBreadcrumb';
import { KebabMenu } from '../components/KebabMenu';
import { PageHeader } from '../components/PageHeader';
import { Alert, Badge, Button, Card, EmptyState, Spinner } from '../components/ui';
import { ApiError, api } from '../lib/api';
import { cx } from '../lib/cx';
import { formatBytes, formatDate } from '../lib/format';
import { useServerContext } from '../lib/server-context';

interface FileEntry {
  name: string;
  path: string;
  directory: boolean;
  symlink: boolean;
  sizeBytes: number;
  mode: string;
  modifiedAt: string;
}

interface ListResponse {
  directory: string;
  entries: FileEntry[];
}

interface UploadProgress {
  name: string;
  done: number;
  total: number;
}

/** Extensions reconnues comme archives extractibles par le daemon. */
const ARCHIVE = /\.(tar\.gz|tgz)$/i;

/** Extensions que l'éditeur ouvre volontiers. */
const EDITABLE = /\.(ya?ml|properties|json|txt|log|toml|conf|cfg|ini|sh|md|xml|csv)$/i;

export function ServerFilesPage() {
  const { uuid = '' } = useParams();
  // Permissions fournies par `ServerLayout` : les interroger de nouveau ici
  // refaisait la même requête à chaque changement d'onglet.
  const { can } = useServerContext();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const directory = params.get('d') ?? '/';
  const queryClient = useQueryClient();

  const [selection, setSelection] = useState<Set<string>>(new Set());
  const [uploading, setUploading] = useState<UploadProgress | null>(null);
  const [dropping, setDropping] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const listing = useQuery({
    queryKey: ['server', uuid, 'files', directory],
    queryFn: () =>
      api.get<ListResponse>(
        `/api/servers/${uuid}/files/list?directory=${encodeURIComponent(directory)}`,
      ),
  });

  const refresh = (): void => {
    void queryClient.invalidateQueries({ queryKey: ['server', uuid, 'files'] });
    setSelection(new Set());
  };

  const deleteMutation = useMutation({
    mutationFn: (files: string[]) => api.post<void>(`/api/servers/${uuid}/files/delete`, { files }),
    onSuccess: refresh,
  });

  const createDirectory = useMutation({
    mutationFn: (name: string) =>
      api.post<void>(`/api/servers/${uuid}/files/create-directory`, {
        directory: joinPath(directory, name),
      }),
    onSuccess: refresh,
  });

  const compress = useMutation({
    mutationFn: (files: string[]) =>
      api.post<FileEntry>(`/api/servers/${uuid}/files/compress`, { files, directory }),
    onSuccess: refresh,
  });

  const decompress = useMutation({
    mutationFn: (file: string) =>
      api.post<{ entries: number }>(`/api/servers/${uuid}/files/decompress`, { file, directory }),
    onSuccess: refresh,
  });

  const rename = useMutation({
    mutationFn: (input: { from: string; to: string }) =>
      api.post<void>(`/api/servers/${uuid}/files/rename`, input),
    onSuccess: refresh,
  });

  const copy = useMutation({
    mutationFn: (input: { from: string; to: string }) =>
      api.post<void>(`/api/servers/${uuid}/files/copy`, input),
    onSuccess: refresh,
  });

  /**
   * Déplace plusieurs entrées vers un même dossier.
   *
   * Une requête par entrée, faute d'opération groupée côté daemon. En cas
   * d'échec à mi-parcours, ce qui a déjà bougé reste déplacé : la liste est
   * rafraîchie dans tous les cas pour que l'état affiché soit celui du disque,
   * et non celui qu'on espérait.
   */
  const move = useMutation({
    mutationFn: async (input: { files: string[]; target: string }) => {
      for (const file of input.files) {
        await api.post<void>(`/api/servers/${uuid}/files/rename`, {
          from: file,
          to: joinPath(input.target, basenameOf(file)),
        });
      }
    },
    onSettled: refresh,
  });

  function moveSelection(): void {
    const target = window.prompt(
      `Déplacer ${selection.size} élément(s) vers quel dossier ?`,
      directory,
    );

    if (target?.trim()) {
      move.mutate({ files: [...selection], target: target.trim() });
    }
  }

  const chmod = useMutation({
    mutationFn: (input: { files: string[]; mode: string }) =>
      api.post<void>(`/api/servers/${uuid}/files/chmod`, input),
    onSuccess: refresh,
  });

  /**
   * Envoi de fichiers.
   *
   * Un par un, et non tous en parallèle : sur une connexion domestique, dix
   * envois simultanés se partagent la bande passante et n'aboutissent qu'à la
   * fin, sans qu'aucun ne progresse visiblement entre-temps.
   *
   * `fetch` direct plutôt que le client de l'API : le corps est le fichier
   * lui-même, sans enveloppe JSON, et le navigateur le lit en flux depuis le
   * disque — un modpack de deux gigaoctets ne passe jamais par la mémoire de
   * l'onglet.
   */
  const upload = useMutation({
    mutationFn: async (files: File[]) => {
      for (const [index, file] of files.entries()) {
        setUploading({ name: file.name, done: index, total: files.length });

        const response = await fetch(
          `/api/servers/${uuid}/files/upload` +
            `?directory=${encodeURIComponent(directory)}&name=${encodeURIComponent(file.name)}`,
          {
            method: 'POST',
            credentials: 'include',
            headers: { 'Content-Type': 'application/octet-stream' },
            body: file,
          },
        );

        if (!response.ok) {
          const detail = (await response.json().catch(() => null)) as { message?: string } | null;
          throw new ApiError(
            response.status,
            detail?.message ?? `Envoi de « ${file.name} » impossible (HTTP ${response.status}).`,
          );
        }
      }
    },
    onSettled: () => setUploading(null),
    onSuccess: refresh,
  });

  function sendFiles(list: FileList | null): void {
    const files = [...(list ?? [])];

    if (files.length > 0) {
      upload.mutate(files);
    }
  }

  // Échap annule la sélection : c'est le geste attendu pour sortir d'un mode,
  // et cela évite de viser « Annuler » à l'autre bout de la barre.
  useEffect(() => {
    if (selection.size === 0) {
      return;
    }

    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        setSelection(new Set());
      }
    };

    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [selection.size]);

  if (listing.isLoading) {
    return <Spinner />;
  }

  if (listing.error) {
    return (
      <Alert>
        {listing.error instanceof ApiError
          ? listing.error.message
          : 'Impossible de lister ce dossier.'}{' '}
        <button className="underline" onClick={() => navigateTo('/')}>
          Revenir à la racine
        </button>
      </Alert>
    );
  }

  /**
   * Ouvre une entrée : parcourir un dossier, éditer un fichier lisible,
   * télécharger le reste.
   *
   * Appelée aussi bien par le nom que par la ligne entière — les deux doivent
   * faire exactement la même chose, sans quoi la cible du clic changerait le
   * résultat.
   */
  function openEntry(entry: FileEntry): void {
    if (entry.directory) {
      navigateTo(`/${entry.path}`);
      return;
    }

    if (!can('file.read-content')) {
      return;
    }

    if (EDITABLE.test(entry.name)) {
      void navigate(`/server/${uuid}/files/edit?f=${encodeURIComponent(entry.path)}`);
      return;
    }

    window.location.href = downloadUrl(uuid, entry.path);
  }

  /**
   * Clic sur la ligne, en dehors de ses commandes propres.
   *
   * La case à cocher et le menu portent `data-row-control` : un clic qui en
   * provient ne doit pas ouvrir l'entrée, sans quoi cocher une case
   * quitterait le dossier.
   *
   * Un glissement de sélection de texte se termine aussi par un `click` : on
   * l'ignore, faute de quoi sélectionner un nom de fichier pour le copier
   * ouvrirait le fichier.
   */
  function handleRowClick(event: MouseEvent, entry: FileEntry): void {
    if ((event.target as HTMLElement).closest('[data-row-control]')) {
      return;
    }

    // On n'ignore le clic que s'il existe **vraiment** une sélection étendue.
    // `getSelection()` peut rendre `null`, et un `?.` mal placé ferait alors
    // ignorer tous les clics.
    const selection = window.getSelection();

    if (selection && !selection.isCollapsed) {
      return;
    }

    openEntry(entry);
  }

  function navigateTo(target: string): void {
    setParams({ d: target });
    setSelection(new Set());
  }

  const entries = listing.data?.entries ?? [];
  // Ne porte que sur le dossier affiché : la sélection est vidée à chaque
  // navigation, elle ne peut donc pas contenir d'entrée venue d'ailleurs.
  const allSelected = entries.length > 0 && entries.every((entry) => selection.has(entry.path));
  const someSelected = selection.size > 0 && !allSelected;
  const mutationError = [
    move.error,
    deleteMutation.error,
    createDirectory.error,
    compress.error,
    decompress.error,
    rename.error,
    copy.error,
    chmod.error,
    upload.error,
  ].find((error): error is ApiError => error instanceof ApiError);

  return (
    <>
      <PageHeader
        title={<FileBreadcrumb directory={directory} onNavigate={navigateTo} />}
        action={
          <div className="flex flex-wrap gap-2">
            {can('file.create') ? (
              <CreateDirectoryButton onCreate={(name) => createDirectory.mutate(name)} />
            ) : null}
            {can('file.create') ? (
              <>
                <input
                  ref={fileInputRef}
                  type="file"
                  multiple
                  className="hidden"
                  onChange={(event) => {
                    sendFiles(event.target.files);
                    // Remis à zéro : sans cela, renvoyer deux fois le même
                    // fichier n'émettrait pas de second `change`.
                    event.target.value = '';
                  }}
                />
                <Button
                  variant="primary"
                  onClick={() => fileInputRef.current?.click()}
                  disabled={upload.isPending}
                >
                  {upload.isPending ? 'Envoi…' : 'Envoyer'}
                </Button>
              </>
            ) : null}
            <Button onClick={() => void listing.refetch()}>Actualiser</Button>
          </div>
        }
      />

      {mutationError ? (
        <div className="mb-4">
          <Alert>{mutationError.message}</Alert>
        </div>
      ) : null}

      {uploading ? (
        <Card className="mb-4">
          <p className="text-sm text-content">
            Envoi de <span className="font-mono">{uploading.name}</span>
            {uploading.total > 1 ? ` — ${uploading.done + 1} sur ${uploading.total}` : null}
          </p>
        </Card>
      ) : null}

      {/* Barre flottante plutôt qu'encart au-dessus de la liste : elle reste
          atteignable quel que soit l'endroit où l'on a fait défiler, alors
          qu'un encart en tête de page disparaît dès qu'on sélectionne
          au-delà du premier écran. */}
      {selection.size > 0 ? (
        <div
          role="region"
          aria-label="Actions sur la sélection"
          className="fixed bottom-6 left-1/2 z-30 -translate-x-1/2"
        >
          <div className="flex flex-wrap items-center gap-3 rounded-xl border border-border-subtle bg-surface-raised px-4 py-3 shadow-xl">
            <span className="text-sm text-content">
              {selection.size} élément{selection.size > 1 ? 's' : ''} sélectionné
              {selection.size > 1 ? 's' : ''}
            </span>

            {can('file.update') ? (
              <Button onClick={moveSelection} disabled={move.isPending}>
                {move.isPending ? 'Déplacement…' : 'Déplacer'}
              </Button>
            ) : null}

            {can('file.archive') ? (
              <Button onClick={() => compress.mutate([...selection])} disabled={compress.isPending}>
                {compress.isPending ? 'Compression…' : 'Compresser'}
              </Button>
            ) : null}

            {can('file.delete') ? (
              <Button
                variant="danger"
                disabled={deleteMutation.isPending}
                onClick={() => {
                  if (window.confirm(`Supprimer définitivement ${selection.size} élément(s) ?`)) {
                    deleteMutation.mutate([...selection]);
                  }
                }}
              >
                Supprimer
              </Button>
            ) : null}

            <Button variant="ghost" onClick={() => setSelection(new Set())}>
              Annuler
            </Button>
          </div>
        </div>
      ) : null}

      {/* Le glisser-déposer couvre toute la zone de liste, y compris un dossier
          vide — c'est justement là qu'on veut déposer quelque chose. */}
      <div
        onDragOver={(event: DragEvent) => {
          if (!can('file.create')) return;
          event.preventDefault();
          setDropping(true);
        }}
        onDragLeave={() => setDropping(false)}
        onDrop={(event: DragEvent) => {
          if (!can('file.create')) return;
          event.preventDefault();
          setDropping(false);
          sendFiles(event.dataTransfer.files);
        }}
        className={cx(
          'rounded-lg transition-colors',
          dropping && 'outline-dashed outline-2 outline-offset-4 outline-accent',
          // La barre flottante recouvrirait sinon les dernières lignes, qui
          // sont précisément celles qu'on vient de cocher en descendant.
          selection.size > 0 && 'pb-24',
        )}
      >
        {entries.length === 0 ? (
          <EmptyState
            title="Dossier vide"
            description={
              can('file.create')
                ? 'Glissez des fichiers ici pour les envoyer.'
                : 'Rien à afficher ici.'
            }
          />
        ) : (
          <Card className="p-0">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border-subtle text-left text-xs text-content-muted">
                  <th className="w-10 px-4 py-3">
                    <input
                      type="checkbox"
                      aria-label="Tout sélectionner dans ce dossier"
                      checked={allSelected}
                      // L'état intermédiaire n'existe pas en HTML : il se pose
                      // par le DOM. Sans lui, une sélection partielle
                      // s'afficherait comme « rien de sélectionné ».
                      ref={(element) => {
                        if (element) {
                          element.indeterminate = someSelected;
                        }
                      }}
                      onChange={(event) =>
                        setSelection(
                          event.target.checked
                            ? new Set(entries.map((entry) => entry.path))
                            : new Set(),
                        )
                      }
                    />
                  </th>
                  <th className="px-4 py-3 font-medium">Nom</th>
                  <th className="px-4 py-3 font-medium">Taille</th>
                  <th className="px-4 py-3 font-medium">Permissions</th>
                  <th className="px-4 py-3 font-medium">Modifié</th>
                  <th className="px-4 py-3" />
                </tr>
              </thead>
              <tbody>
                {directory !== '/' && directory !== '.' ? (
                  <tr
                    onClick={() => navigateTo(parentOf(directory))}
                    className="cursor-pointer border-b border-border-subtle/50 transition-colors hover:bg-surface-hover"
                  >
                    <td />
                    <td className="px-4 py-2">
                      <button
                        className="text-content-muted hover:text-content"
                        onClick={(event) => {
                          event.stopPropagation();
                          navigateTo(parentOf(directory));
                        }}
                      >
                        ← dossier parent
                      </button>
                    </td>
                    <td colSpan={4} />
                  </tr>
                ) : null}

                {entries.map((entry) => (
                  <tr
                    key={entry.path}
                    onClick={(event) => handleRowClick(event, entry)}
                    className="cursor-pointer border-b border-border-subtle/50 transition-colors last:border-0 hover:bg-surface-hover"
                  >
                    <td className="px-4 py-2" data-row-control>
                      <input
                        type="checkbox"
                        aria-label={`Sélectionner ${entry.name}`}
                        checked={selection.has(entry.path)}
                        onChange={(event) => {
                          const next = new Set(selection);
                          if (event.target.checked) next.add(entry.path);
                          else next.delete(entry.path);
                          setSelection(next);
                        }}
                      />
                    </td>

                    <td className="px-4 py-2">
                      <FileName
                        entry={entry}
                        serverUuid={uuid}
                        canRead={can('file.read-content')}
                        onOpen={() => openEntry(entry)}
                      />
                    </td>

                    <td className="px-4 py-2 text-content-muted">
                      {entry.directory ? '—' : formatBytes(entry.sizeBytes)}
                    </td>
                    <td className="px-4 py-2 font-mono text-xs text-content-muted">{entry.mode}</td>
                    <td className="px-4 py-2 text-content-muted">{formatDate(entry.modifiedAt)}</td>

                    <td className="px-4 py-2 text-right" data-row-control>
                      <div className="flex justify-end">
                        <KebabMenu
                          label={`Actions sur ${entry.name}`}
                          actions={[
                            {
                              label: 'Renommer',
                              icon: '✎',
                              hidden: !can('file.update'),
                              onSelect: () => {
                                const name = window.prompt('Nouveau nom', entry.name);
                                if (name?.trim() && name.trim() !== entry.name) {
                                  rename.mutate({
                                    from: entry.path,
                                    to: joinPath(directory, name.trim()),
                                  });
                                }
                              },
                            },
                            {
                              label: 'Déplacer',
                              icon: '↱',
                              hidden: !can('file.update'),
                              onSelect: () => {
                                const target = window.prompt(
                                  'Nouveau chemin, depuis la racine du serveur',
                                  `/${entry.path}`,
                                );
                                if (target?.trim() && target.trim() !== `/${entry.path}`) {
                                  rename.mutate({ from: entry.path, to: target.trim() });
                                }
                              },
                            },
                            {
                              label: 'Copier',
                              icon: '⧉',
                              hidden: !can('file.create'),
                              onSelect: () =>
                                copy.mutate({
                                  from: entry.path,
                                  to: joinPath(directory, copyNameFor(entry.name)),
                                }),
                            },
                            {
                              label: 'Permissions',
                              icon: '⚿',
                              hidden: !can('file.update'),
                              onSelect: () => {
                                const mode = window.prompt(
                                  `Droits de « ${entry.name} », en octal (actuellement ${entry.mode})`,
                                  entry.directory ? '755' : '644',
                                );
                                if (mode?.trim()) {
                                  chmod.mutate({ files: [entry.path], mode: mode.trim() });
                                }
                              },
                            },
                            {
                              label: 'Télécharger',
                              icon: '↓',
                              hidden: entry.directory || !can('file.read-content'),
                              onSelect: () => {
                                window.location.href = downloadUrl(uuid, entry.path);
                              },
                            },
                            {
                              label: 'Archiver',
                              icon: '🗜',
                              hidden: !can('file.archive'),
                              onSelect: () => compress.mutate([entry.path]),
                            },
                            {
                              label: 'Extraire',
                              icon: '📦',
                              hidden:
                                entry.directory ||
                                !ARCHIVE.test(entry.name) ||
                                !can('file.archive'),
                              onSelect: () => decompress.mutate(entry.path),
                            },
                            {
                              label: 'Supprimer',
                              icon: '🗑',
                              destructive: true,
                              hidden: !can('file.delete'),
                              onSelect: () => {
                                if (
                                  window.confirm(`Supprimer définitivement « ${entry.name} » ?`)
                                ) {
                                  deleteMutation.mutate([entry.path]);
                                }
                              },
                            },
                          ]}
                        />
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>
        )}
      </div>
    </>
  );
}

function CreateDirectoryButton({ onCreate }: { onCreate: (name: string) => void }) {
  return (
    <Button
      onClick={() => {
        const name = window.prompt('Nom du nouveau dossier');
        if (name?.trim()) {
          onCreate(name.trim());
        }
      }}
    >
      Nouveau dossier
    </Button>
  );
}

/**
 * Nom d'un fichier, cliquable.
 *
 * La ligne entière ouvre déjà l'entrée, mais le nom reste une commande à part
 * entière : c'est lui qui porte le focus au clavier, et c'est un vrai lien pour
 * un fichier téléchargeable — le clic du milieu et « enregistrer sous »
 * fonctionnent alors comme partout ailleurs. Une ligne cliquable seule
 * n'offrirait rien de tout cela.
 *
 * Chaque commande arrête la propagation : sans quoi le gestionnaire de la ligne
 * se déclencherait à son tour et l'entrée s'ouvrirait deux fois.
 *
 * Le nom n'est pas souligné : c'est le surlignage de la ligne qui indique
 * qu'elle est cliquable. Souligner en plus ne marquait que le texte, alors que
 * toute la ligne réagit — l'affordance désignait une cible plus petite que la
 * vraie.
 */
function FileName({
  entry,
  serverUuid,
  canRead,
  onOpen,
}: {
  entry: FileEntry;
  serverUuid: string;
  canRead: boolean;
  onOpen: () => void;
}) {
  const icon = entry.directory ? '📁' : entry.symlink ? '🔗' : '📄';

  const label = (
    <>
      <span aria-hidden className="mr-1.5">
        {icon}
      </span>
      {entry.name}
      {/* Un lien est signalé : son contenu peut pointer ailleurs, et le daemon
          refusera de l'ouvrir s'il sort du volume. */}
      {entry.symlink ? (
        <span className="ml-2">
          <Badge tone="warn">lien</Badge>
        </span>
      ) : null}
    </>
  );

  if (!entry.directory && !canRead) {
    return <span className="text-content-muted">{label}</span>;
  }

  // Un fichier non éditable est un téléchargement : un vrai lien, pas un bouton.
  if (!entry.directory && !EDITABLE.test(entry.name)) {
    return (
      <a
        className="text-content"
        href={downloadUrl(serverUuid, entry.path)}
        onClick={(event) => event.stopPropagation()}
      >
        {label}
      </a>
    );
  }

  return (
    <button
      className="text-content"
      onClick={(event) => {
        event.stopPropagation();
        onOpen();
      }}
    >
      {label}
    </button>
  );
}

function downloadUrl(serverUuid: string, path: string): string {
  return `/api/servers/${serverUuid}/files/download?file=${encodeURIComponent(path)}`;
}

/** `paper.yml` → `paper copie.yml`, pour ne pas écraser l'original. */
function copyNameFor(name: string): string {
  const dot = name.lastIndexOf('.');

  return dot > 0 ? `${name.slice(0, dot)} copie${name.slice(dot)}` : `${name} copie`;
}

/** Dernier segment d'un chemin : `plugins/Essentials.jar` → `Essentials.jar`. */
function basenameOf(path: string): string {
  return path.split('/').filter(Boolean).pop() ?? path;
}

function joinPath(directory: string, name: string): string {
  return `${directory.replace(/\/+$/, '')}/${name}`;
}

function parentOf(directory: string): string {
  const segments = directory.split('/').filter(Boolean);
  segments.pop();
  return segments.length === 0 ? '/' : '/' + segments.join('/');
}
