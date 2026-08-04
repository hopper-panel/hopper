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
 * Éditeur de fichier, sur sa propre page.
 *
 * Il vivait dans une carte glissée au-dessus de la liste : le contenu du
 * fichier se retrouvait comprimé entre l'en-tête et l'arborescence, et la liste
 * restait affichée en dessous sans servir à rien. Une page distincte donne toute
 * la hauteur au texte et, surtout, une **URL** — un fichier ouvert se recharge,
 * se met en favori et se transmet.
 *
 * Le chemin passe en paramètre de requête plutôt qu'en segment d'URL : il
 * contient des barres obliques, qui découperaient sinon la route.
 */
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
          error?: { message?: string };
        } | null;

        throw new Error(
          detail?.error?.message ?? t('fileEdit.readFailed', { status: response.status }),
        );
      }

      return response.text();
    },
    enabled: path !== '',
    // Un fichier ouvert ne doit pas se recharger sous les doigts de celui qui
    // l'édite : un retour sur l'onglet écraserait ses modifications.
    refetchOnWindowFocus: false,
  });

  const original = load.data ?? '';
  const content = draft ?? original;
  const dirty = draft !== null && draft !== original;

  const save = useMutation({
    mutationFn: (value: string) =>
      api.post<void>(`/api/servers/${uuid}/files/write`, { file: path, content: value }),
    onSuccess: () => {
      // Le brouillon devient la nouvelle référence : sans cela le fichier
      // resterait marqué comme modifié juste après avoir été enregistré.
      setDraft(null);
      setSavedAt(new Date());
      setError(null);
      void load.refetch();
    },
    onError: (caught) =>
      setError(caught instanceof ApiError ? caught.message : t('common.operationFailed')),
  });

  // Recalculé à chaque frappe, mais c'est une simple jointure de nombres : le
  // coût est sans commune mesure avec le rendu d'un élément par ligne.
  const lineNumbers = useMemo(() => {
    const count = content.split('\n').length;

    return Array.from({ length: count }, (_, index) => index + 1).join('\n');
  }, [content]);

  const directory = parentOf(path);
  const filesUrl = `/server/${uuid}/files?d=${encodeURIComponent(directory)}`;

  // Prévient la fermeture de l'onglet ou le rechargement quand un travail non
  // enregistré serait perdu. Le navigateur impose son propre message.
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
            <button className="underline" onClick={() => void navigate(filesUrl)}>
              Revenir aux fichiers
            </button>
          </Alert>
        </div>
      ) : null}

      {load.isLoading ? (
        <Spinner label={t('fileEdit.loading')} />
      ) : load.error ? null : (
        <Card className="p-0">
          {/* La hauteur est portée par le conteneur, et non par le texte. Sur
              une rangée flex, un enfant n'est pas comprimé sous la hauteur de
              son contenu : la gouttière d'un fichier de dix mille lignes
              aurait étiré la carte sur toute cette hauteur. */}
          <div className="flex h-[calc(100vh-22rem)] min-h-96 overflow-hidden rounded-lg bg-[#14161c]">
            {/* La gouttière est un seul nœud de texte, et non une ligne par
                numéro : un fichier de configuration un peu long en compte
                plusieurs milliers, et autant d'éléments figeraient l'onglet. */}
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
                // La gouttière suit le défilement vertical du texte. Elle est
                // en `overflow-hidden`, ce qui n'empêche pas de la faire
                // défiler par programme.
                if (gutterRef.current) {
                  gutterRef.current.scrollTop = event.currentTarget.scrollTop;
                }
              }}
              readOnly={!canWrite}
              spellCheck={false}
              autoComplete="off"
              // Le retour à la ligne automatique romprait la correspondance
              // entre les lignes affichées et leurs numéros : une ligne longue
              // en occuperait deux et tout le reste serait décalé. On défile
              // donc horizontalement, comme dans un éditeur de code.
              wrap="off"
              aria-label={`Contenu de ${path}`}
              // Hauteur relative à la fenêtre : un éditeur qui grandit avec son
              // contenu obligerait à faire défiler la page entière pour
              // atteindre le bas d'un fichier un peu long.
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
          <kbd className="rounded border border-border-subtle px-1">S</kbd> pour enregistrer.
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
