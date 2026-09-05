import { useMutation, useQuery } from '@tanstack/react-query';
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { FileBreadcrumb } from '../components/FileBreadcrumb';
import { PageHeader } from '../components/PageHeader';
import { Alert, Badge, Button, Card, Spinner } from '../components/ui';
import { useTranslation } from '../i18n';
import { ApiError, api } from '../lib/api';
import { useServerContext } from '../lib/server-context';

/**
 * File editor, on a page of its own.
 *
 * It used to live in a card slipped above the listing: the file's content ended
 * up squeezed between the header and the tree, and the listing stayed on show
 * below serving no purpose. A separate page gives the text the full height and,
 * above all, a **URL** — an open file can be reloaded, bookmarked and passed
 * on.
 *
 * The path travels as a query parameter rather than a URL segment: it contains
 * slashes, which would otherwise cut the route up.
 */
/**
 * The daemon's refusal to treat a file as text, told apart from every other
 * read failure.
 *
 * It is not an error the user made: the file manager offers anything it cannot
 * prove is binary, so landing here is a normal outcome — and the useful answer
 * is a download, not a status code.
 */
class NotTextError extends Error {}

export function ServerFileEditPage() {
  const { t } = useTranslation();
  const { uuid = '' } = useParams();
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const { can } = useServerContext();

  const path = params.get('f') ?? '';
  const canWrite = can('file.update');

  const [draft, setDraft] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<Date | null>(null);
  const gutterRef = useRef<HTMLDivElement>(null);

  const load = useQuery({
    queryKey: ['server', uuid, 'file', path],
    queryFn: async () => {
      const response = await fetch(
        `/api/servers/${uuid}/files/contents?file=${encodeURIComponent(path)}`,
        { credentials: 'include' },
      );

      if (!response.ok) {
        const detail = (await response.json().catch(() => null)) as {
          error?: { code?: string; message?: string };
        } | null;

        if (detail?.error?.code === 'file_not_text') {
          throw new NotTextError(t('fileEdit.notText'));
        }

        throw new Error(
          detail?.error?.message ?? t('fileEdit.readFailed', { status: response.status }),
        );
      }

      return response.text();
    },
    enabled: path !== '',
    // An open file must not reload under the fingers of whoever is editing it:
    // coming back to the tab would overwrite their changes.
    refetchOnWindowFocus: false,
  });

  const original = load.data ?? '';
  const content = draft ?? original;
  const dirty = draft !== null && draft !== original;

  const save = useMutation({
    mutationFn: (value: string) =>
      api.post<void>(`/api/servers/${uuid}/files/write`, { file: path, content: value }),
    onSuccess: () => {
      // The draft becomes the new reference: without it the file would stay
      // marked as edited right after being saved.
      setDraft(null);
      setSavedAt(new Date());
      setError(null);
      void load.refetch();
    },
    onError: (caught) =>
      setError(caught instanceof ApiError ? caught.message : t('common.operationFailed')),
  });

  // Recomputed on every keystroke, but it is a plain join of numbers: the cost
  // is nothing next to rendering one element per line.
  const lineNumbers = useMemo(() => {
    const count = content.split('\n').length;

    return Array.from({ length: count }, (_, index) => index + 1).join('\n');
  }, [content]);

  const directory = parentOf(path);
  const filesUrl = `/server/${uuid}/files?d=${encodeURIComponent(directory)}`;

  // Warns before closing the tab or reloading when unsaved work would be lost.
  // The browser imposes its own message.
  useEffect(() => {
    if (!dirty) {
      return;
    }

    const warn = (event: BeforeUnloadEvent): void => {
      event.preventDefault();
    };

    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);

  function close(): void {
    if (dirty && !window.confirm(t('fileEdit.discardConfirm'))) {
      return;
    }

    void navigate(filesUrl);
  }

  function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>): void {
    // Ctrl+S — or Cmd+S — saves, as in any editor. Without it the shortcut
    // would offer to save the HTML page.
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
      event.preventDefault();

      if (canWrite && !save.isPending) {
        save.mutate(content);
      }
    }
  }

  if (path === '') {
    return <Alert>{t('fileEdit.noFile')}</Alert>;
  }

  return (
    <>
      <PageHeader
        title={
          <FileBreadcrumb
            directory={directory}
            file={nameOf(path)}
            onNavigate={(target) =>
              void navigate(`/server/${uuid}/files?d=${encodeURIComponent(target)}`)
            }
          />
        }
        action={
          <div className="flex flex-wrap items-center gap-2">
            {dirty ? <Badge tone="warn">{t('fileEdit.modified')}</Badge> : null}
            {!dirty && savedAt ? <Badge tone="online">{t('fileEdit.saved')}</Badge> : null}

            {canWrite ? (
              <Button
                variant="primary"
                onClick={() => save.mutate(content)}
                disabled={save.isPending || !dirty}
              >
                {save.isPending ? t('common.saving') : t('common.save')}
              </Button>
            ) : null}

            <Button variant="ghost" onClick={close}>
              {t('common.close')}
            </Button>
          </div>
        }
      />

      {error ? (
        <div className="mb-4">
          <Alert>{error}</Alert>
        </div>
      ) : null}

      {load.error ? (
        <div className="mb-4">
          <Alert>
            {load.error instanceof Error ? load.error.message : t('common.loadFailed')}{' '}
            {load.error instanceof NotTextError ? (
              <a
                className="underline"
                href={`/api/servers/${uuid}/files/download?file=${encodeURIComponent(path)}`}
              >
                {t('fileEdit.download')}
              </a>
            ) : null}{' '}
            <button className="underline" onClick={() => void navigate(filesUrl)}>
              {t('fileEdit.backToFiles')}
            </button>
          </Alert>
        </div>
      ) : null}

      {load.isLoading ? (
        <Spinner label={t('fileEdit.loading')} />
      ) : load.error ? null : (
        <Card className="p-0">
          {/* The height is carried by the container, not by the text. On a
              flex row, a child is not squeezed below the height of its content:
              the gutter of a ten-thousand-line file would have stretched the
              card over all of it. */}
          <div className="flex h-[calc(100vh-22rem)] min-h-96 overflow-hidden rounded-lg bg-[#14161c]">
            {/* The gutter is a single text node, not one line per number: a
                configuration file of any length holds several thousand, and
                that many elements would freeze the tab. */}
            <div
              ref={gutterRef}
              aria-hidden
              className="h-full shrink-0 select-none overflow-hidden border-r border-border-subtle py-4 pl-4 pr-3"
            >
              <pre className="text-right font-mono text-xs leading-relaxed text-content-subtle">
                {lineNumbers}
              </pre>
            </div>

            <textarea
              value={content}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={handleKeyDown}
              onScroll={(event) => {
                // The gutter follows the text's vertical scroll. It is
                // `overflow-hidden`, which does not stop it from being
                // scrolled programmatically.
                if (gutterRef.current) {
                  gutterRef.current.scrollTop = event.currentTarget.scrollTop;
                }
              }}
              readOnly={!canWrite}
              spellCheck={false}
              autoComplete="off"
              // Soft wrapping would break the match between the displayed
              // lines and their numbers: a long line would take two and
              // everything below would shift. So it scrolls horizontally, as a
              // code editor does.
              wrap="off"
              aria-label={t('fileEdit.editorLabel', { name: nameOf(path) })}
              // Height relative to the window: an editor growing with its
              // content would force scrolling the whole page to reach the
              // bottom of any sizeable file.
              className="h-full w-full resize-none border-0 bg-transparent p-4 font-mono text-xs leading-relaxed text-content focus:outline-none"
            />
          </div>
        </Card>
      )}

      {!canWrite ? (
        <p className="mt-3 text-xs text-content-muted">{t('fileEdit.readOnly')}</p>
      ) : (
        <p className="mt-3 text-xs text-content-muted">
          <kbd className="rounded border border-border-subtle px-1">Ctrl</kbd> +{' '}
          <kbd className="rounded border border-border-subtle px-1">S</kbd>{' '}
          {t('fileEdit.saveShortcut')}
        </p>
      )}
    </>
  );
}

function nameOf(path: string): string {
  return path.split('/').filter(Boolean).pop() ?? path;
}

function parentOf(path: string): string {
  const segments = path.split('/').filter(Boolean);
  segments.pop();

  return segments.length === 0 ? '/' : `/${segments.join('/')}`;
}
