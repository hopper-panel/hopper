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
import { useTranslation } from '../i18n';
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

/** Extensions the editor happily opens. */
const EDITABLE = /\.(ya?ml|properties|json|txt|log|toml|conf|cfg|ini|sh|md|xml|csv)$/i;

export function ServerFilesPage() {
  const { uuid = '' } = useParams();
  // Permissions fournies par `ServerLayout` : les interroger de nouveau ici
  // repeated the same request on every tab change.
  const { can } = useServerContext();
  const { t } = useTranslation();
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
   * Moves several entries into the same folder.
   *
   * One request per entry, for want of a bulk operation on the daemon side. If
   * it fails halfway, what already moved stays moved: the listing is refreshed
   * either way, so what is displayed is what is on disk rather than what was
   * hoped for.
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
    const target = window.prompt(t('files.movePrompt', { count: selection.size }), directory);

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
   * File upload.
   *
   * One at a time rather than in parallel: on a home connection ten concurrent
   * uploads share the same bandwidth and all finish at the end, with none
   * visibly progressing in between.
   *
   * Plain `fetch` rather than the API client: the body is the file itself, with
   * no JSON envelope, and the browser streams it from disk — a two-gigabyte
   * modpack never goes through the tab's memory.
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
            detail?.message ??
              t('files.uploadFailed', { name: file.name, status: response.status }),
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

  // Escape clears the selection: the expected way out of a mode, and it saves
  // aiming for "Cancel" at the far end of the bar.
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
        {listing.error instanceof ApiError ? listing.error.message : t('files.listFailed')}{' '}
        <button className="underline" onClick={() => navigateTo('/')}>
          {t('files.backToRoot')}
        </button>
      </Alert>
    );
  }

  /**
   * Opens an entry: browse a folder, edit a readable file, download the rest.
   *
   * Called both from the name and from the whole row — they must do exactly the
   * same thing, or where you click would change what happens.
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
   * Click on the row, outside its own controls.
   *
   * The checkbox and the menu carry `data-row-control`: a click coming from
   * them must not open the entry, or ticking a box would leave the folder.
   *
   * A text-selection drag also ends in a `click`: it is ignored, otherwise
   * selecting a filename to copy it would open the file.
   */
  function handleRowClick(event: MouseEvent, entry: FileEntry): void {
    if ((event.target as HTMLElement).closest('[data-row-control]')) {
      return;
    }

    // The click is ignored only if a selection really is stretched.
    // `getSelection()` can return `null`, and a misplaced `?.` would then
    // swallow every click.
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
  // Scoped to the displayed folder: the selection is cleared on every
  // navigation, so it cannot hold an entry from elsewhere.
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
                    // Reset: without it, sending the same file twice would not
                    // fire a second `change`.
                    event.target.value = '';
                  }}
                />
                <Button
                  variant="primary"
                  onClick={() => fileInputRef.current?.click()}
                  disabled={upload.isPending}
                >
                  {upload.isPending ? t('files.uploading') : t('files.upload')}
                </Button>
              </>
            ) : null}
            <Button onClick={() => void listing.refetch()}>{t('files.refresh')}</Button>
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

      {/* A floating bar rather than a box above the list: it stays reachable
          wherever one has scrolled, while a box at the top of the page
          disappears as soon as the selection goes past the first screen. */}
      {selection.size > 0 ? (
        <div
          role="region"
          aria-label={t('files.selectionActions')}
          className="fixed bottom-6 left-1/2 z-30 -translate-x-1/2"
        >
          <div className="flex flex-wrap items-center gap-3 rounded-xl border border-border-subtle bg-surface-raised px-4 py-3 shadow-xl">
            <span className="text-sm text-content">
              {t('files.selected', { count: selection.size })}
            </span>

            {can('file.update') ? (
              <Button onClick={moveSelection} disabled={move.isPending}>
                {move.isPending ? t('files.moving') : t('files.move')}
              </Button>
            ) : null}

            {can('file.archive') ? (
              <Button onClick={() => compress.mutate([...selection])} disabled={compress.isPending}>
                {compress.isPending ? t('files.compressing') : t('files.compress')}
              </Button>
            ) : null}

            {can('file.delete') ? (
              <Button
                variant="danger"
                disabled={deleteMutation.isPending}
                onClick={() => {
                  if (window.confirm(t('files.deleteSelection', { count: selection.size }))) {
                    deleteMutation.mutate([...selection]);
                  }
                }}
              >
                {t('common.delete')}
              </Button>
            ) : null}

            <Button variant="ghost" onClick={() => setSelection(new Set())}>
              {t('common.cancel')}
            </Button>
          </div>
        </div>
      ) : null}

      {/* Drag and drop covers the whole listing area, empty folder included —
          that is precisely where one wants to drop something. */}
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
          // Otherwise the floating bar would cover the last rows, which are
          // precisely the ones just ticked on the way down.
          selection.size > 0 && 'pb-24',
        )}
      >
        {entries.length === 0 ? (
          <EmptyState
            title={t('files.emptyFolder')}
            description={can('file.create') ? t('files.dropHint') : t('files.nothingHere')}
          />
        ) : (
          <Card className="p-0">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border-subtle text-left text-xs text-content-muted">
                  <th className="w-10 px-4 py-3">
                    <input
                      type="checkbox"
                      aria-label={t('files.selectAll')}
                      checked={allSelected}
                      // The indeterminate state does not exist in HTML: it is
                      // set through the DOM. Without it a partial selection
                      // would read as "nothing selected".
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
                  <th className="px-4 py-3 font-medium">{t('files.columnSize')}</th>
                  <th className="px-4 py-3 font-medium">{t('files.columnPermissions')}</th>
                  <th className="px-4 py-3 font-medium">{t('files.columnModified')}</th>
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
                        aria-label={t('files.selectOne', { name: entry.name })}
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
                              label: t('files.rename'),
                              icon: '✎',
                              hidden: !can('file.update'),
                              onSelect: () => {
                                const name = window.prompt(t('files.renamePrompt'), entry.name);
                                if (name?.trim() && name.trim() !== entry.name) {
                                  rename.mutate({
                                    from: entry.path,
                                    to: joinPath(directory, name.trim()),
                                  });
                                }
                              },
                            },
                            {
                              label: t('files.repath'),
                              icon: '↱',
                              hidden: !can('file.update'),
                              onSelect: () => {
                                const target = window.prompt(
                                  t('files.repathPrompt'),
                                  `/${entry.path}`,
                                );
                                if (target?.trim() && target.trim() !== `/${entry.path}`) {
                                  rename.mutate({ from: entry.path, to: target.trim() });
                                }
                              },
                            },
                            {
                              label: t('files.copy'),
                              icon: '⧉',
                              hidden: !can('file.create'),
                              onSelect: () =>
                                copy.mutate({
                                  from: entry.path,
                                  to: joinPath(directory, copyNameFor(entry.name)),
                                }),
                            },
                            {
                              label: t('files.permissions'),
                              icon: '⚿',
                              hidden: !can('file.update'),
                              onSelect: () => {
                                const mode = window.prompt(
                                  t('files.permissionsPrompt', {
                                    name: entry.name,
                                    mode: entry.mode,
                                  }),
                                  entry.directory ? '755' : '644',
                                );
                                if (mode?.trim()) {
                                  chmod.mutate({ files: [entry.path], mode: mode.trim() });
                                }
                              },
                            },
                            {
                              label: t('files.download'),
                              icon: '↓',
                              hidden: entry.directory || !can('file.read-content'),
                              onSelect: () => {
                                window.location.href = downloadUrl(uuid, entry.path);
                              },
                            },
                            {
                              label: t('files.archive'),
                              icon: '🗜',
                              hidden: !can('file.archive'),
                              onSelect: () => compress.mutate([entry.path]),
                            },
                            {
                              label: t('files.extract'),
                              icon: '📦',
                              hidden:
                                entry.directory ||
                                !ARCHIVE.test(entry.name) ||
                                !can('file.archive'),
                              onSelect: () => decompress.mutate(entry.path),
                            },
                            {
                              label: t('common.delete'),
                              icon: '🗑',
                              destructive: true,
                              hidden: !can('file.delete'),
                              onSelect: () => {
                                if (window.confirm(t('files.deleteOne', { name: entry.name }))) {
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
  const { t } = useTranslation();

  return (
    <Button
      onClick={() => {
        const name = window.prompt(t('files.newFolderPrompt'));
        if (name?.trim()) {
          onCreate(name.trim());
        }
      }}
    >
      {t('files.newFolder')}
    </Button>
  );
}

/**
 * The name of an entry.
 *
 * The whole row already opens the entry, but the name stays a control of its
 * own: it carries keyboard focus, and it is a real link for a downloadable file
 * — middle click and "save as" have to work.
 *
 * Every control stops propagation: otherwise the row handler would fire too and
 * the entry would open twice.
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
  const { t } = useTranslation();
  const icon = entry.directory ? '📁' : entry.symlink ? '🔗' : '📄';

  const label = (
    <>
      <span aria-hidden className="mr-1.5">
        {icon}
      </span>
      {entry.name}
      {/* Symlinks are flagged: they may point elsewhere, and the daemon will
          refuse to open one that leaves the volume. */}
      {entry.symlink ? (
        <span className="ml-2">
          <Badge tone="warn">{t('files.symlink')}</Badge>
        </span>
      ) : null}
    </>
  );

  if (!entry.directory && !canRead) {
    return <span className="text-content-muted">{label}</span>;
  }

  // A non-editable file is a download: a real link, not a button.
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

/** `paper.yml` -> `paper copy.yml`, so the original is not overwritten. */
function copyNameFor(name: string): string {
  const dot = name.lastIndexOf('.');

  return dot > 0 ? `${name.slice(0, dot)} copy${name.slice(dot)}` : `${name} copy`;
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
