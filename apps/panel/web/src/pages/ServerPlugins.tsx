import { useMutation, useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { PageHeader } from '../components/PageHeader';
import { Alert, Badge, Button, Card, Spinner } from '../components/ui';
import { useTranslation } from '../i18n';
import { api, ApiError } from '../lib/api';
import { useServerContext } from '../lib/server-context';

interface SearchHit {
  projectId: string;
  slug: string;
  title: string;
  description: string;
  downloads: number;
  iconUrl: string | null;
}

interface PluginVersion {
  versionId: string;
  name: string;
  versionNumber: string;
  gameVersions: string[];
  loaders: string[];
  file: { filename: string; sizeBytes: number; sha512: string | null };
}

/**
 * Installing from the catalogue.
 *
 * Search is deliberately not live-as-you-type: every keystroke would be a
 * request the panel makes to Modrinth on the operator's behalf, and Modrinth
 * rate-limits per address — one impatient user would take the catalogue away
 * from everyone else on that panel.
 */
export function ServerPluginsPage() {
  const { server, can } = useServerContext();
  const { t } = useTranslation();
  const [query, setQuery] = useState('');
  const [submitted, setSubmitted] = useState('');
  const [selected, setSelected] = useState<SearchHit | null>(null);
  const [installed, setInstalled] = useState<string | null>(null);

  // Runs with an empty query too. The catalogue then answers with what is most
  // downloaded for this server's loader, which beats a blank page and a box:
  // someone opening this tab for the first time has no name to type yet.
  const results = useQuery({
    queryKey: ['plugins', server.uuid, submitted],
    queryFn: () =>
      api.get<SearchHit[]>(
        `/api/servers/${server.uuid}/plugins/search?query=${encodeURIComponent(submitted)}`,
      ),
    // A refusal is deterministic: a server that loads no plugins will load none
    // on the third attempt either, and retrying only delays the explanation.
    retry: (count, error) => !(error instanceof ApiError && error.status < 500) && count < 2,
  });

  const versions = useQuery({
    queryKey: ['plugins', server.uuid, 'versions', selected?.projectId],
    queryFn: () =>
      api.get<PluginVersion[]>(
        `/api/servers/${server.uuid}/plugins/${selected!.projectId}/versions`,
      ),
    enabled: selected !== null,
  });

  const install = useMutation({
    mutationFn: (versionId: string) =>
      api.post<{ installed: string }>(`/api/servers/${server.uuid}/plugins/install`, { versionId }),
    onSuccess: (data) => setInstalled(data.installed),
  });

  if (!can('file.create')) {
    return (
      <>
        <PageHeader title={t('plugins.title')} description={t('plugins.subtitle')} />
        <Alert>{t('plugins.denied')}</Alert>
      </>
    );
  }

  return (
    <>
      <PageHeader title={t('plugins.title')} description={t('plugins.subtitle')} />

      <form
        className="mb-4 flex gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          setSelected(null);
          setInstalled(null);
          setSubmitted(query.trim());
        }}
      >
        <input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder={t('plugins.searchPlaceholder')}
          className="flex-1 rounded-lg border border-border-subtle bg-surface px-3 py-2 text-sm text-content"
        />
        <Button type="submit" variant="primary" disabled={query.trim().length === 0}>
          {t('plugins.search')}
        </Button>
      </form>

      {/* The installed path, not just "done": an operator restarting the server
          needs to know a file appeared and where. */}
      {installed ? <Alert tone="info">{t('plugins.installed', { file: installed })}</Alert> : null}

      {install.error instanceof ApiError ? (
        <Alert tone="danger">{install.error.message}</Alert>
      ) : null}

      {/* The search's own failure, which used to go nowhere.

          A server whose template loads neither plugins nor mods is refused with
          a message naming what to run instead — and that message was written,
          returned, and thrown away: only the *install* error was rendered. The
          page came up blank, on the one screen whose whole job was to explain
          why there was nothing to show. */}
      {results.error instanceof ApiError ? (
        <Alert tone={results.error.status === 400 ? 'info' : 'danger'}>
          {results.error.message}
        </Alert>
      ) : null}

      {/* Named for what it is. A list sorted by downloads is not a list of
          search results, and letting someone believe otherwise makes the page
          look broken when their query is what returned nothing. */}
      {results.data && results.data.length > 0 ? (
        <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-content-subtle">
          {submitted ? t('plugins.results') : t('plugins.popular')}
        </h2>
      ) : null}

      {results.isPending ? <Spinner /> : null}

      {results.data?.length === 0 ? (
        <p className="text-sm text-content-muted">{t('plugins.noResults')}</p>
      ) : null}

      <div className="grid gap-3">
        {results.data?.map((hit) => (
          <Card key={hit.projectId}>
            <div className="flex items-start gap-3">
              {hit.iconUrl ? (
                <img src={hit.iconUrl} alt="" className="size-10 shrink-0 rounded-lg" />
              ) : (
                <div className="size-10 shrink-0 rounded-lg bg-surface" />
              )}

              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <h3 className="font-medium text-content">{hit.title}</h3>
                  <Badge>{hit.downloads.toLocaleString()}</Badge>
                </div>
                <p className="mt-1 text-sm text-content-muted">{hit.description}</p>
              </div>

              <Button
                onClick={() => setSelected(selected?.projectId === hit.projectId ? null : hit)}
              >
                {t('plugins.versions')}
              </Button>
            </div>

            {selected?.projectId === hit.projectId ? (
              <div className="mt-4 border-t border-border-subtle pt-3">
                {versions.isPending ? <Spinner /> : null}

                <ul className="grid gap-2">
                  {versions.data?.slice(0, 8).map((version) => (
                    <li
                      key={version.versionId}
                      className="flex flex-wrap items-center justify-between gap-2 text-sm"
                    >
                      <span className="text-content">
                        {version.versionNumber}
                        <span className="ml-2 text-content-subtle">
                          {version.loaders.join(', ')} ·{' '}
                          {version.gameVersions.slice(0, 3).join(', ')}
                        </span>
                      </span>

                      <div className="flex items-center gap-2">
                        {/* A version the catalogue publishes no checksum for is
                            installed all the same — refusing would rule out a
                            good part of the catalogue — but it is said, because
                            the daemon can then verify nothing. */}
                        {version.file.sha512 === null ? (
                          <Badge tone="warn">{t('plugins.noChecksum')}</Badge>
                        ) : null}

                        <Button
                          variant="primary"
                          disabled={install.isPending}
                          onClick={() => install.mutate(version.versionId)}
                        >
                          {install.isPending ? t('plugins.installing') : t('plugins.install')}
                        </Button>
                      </div>
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
          </Card>
        ))}
      </div>
    </>
  );
}
