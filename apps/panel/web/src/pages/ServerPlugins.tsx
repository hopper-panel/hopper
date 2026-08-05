import { useMutation, useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { PageHeader } from '../components/PageHeader';
import { Pagination } from '../components/Pagination';
import { PluginCard, type PluginHit } from '../components/PluginCard';
import { Alert, Badge, Button, Spinner } from '../components/ui';
import { useTranslation } from '../i18n';
import { api, ApiError } from '../lib/api';
import { useServerContext } from '../lib/server-context';

/** Matches what the panel returns; the search has been paged since v0.2.2. */
interface PluginSearchPage {
  data: PluginHit[];
  meta: { currentPage: number; perPage: number; lastPage: number; total: number };
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
  const [selected, setSelected] = useState<PluginHit | null>(null);
  const [installed, setInstalled] = useState<string | null>(null);
  const [page, setPage] = useState(1);

  // Runs with an empty query too. The catalogue then answers with what is most
  // downloaded for this server's loader, which beats a blank page and a box:
  // someone opening this tab for the first time has no name to type yet.
  const results = useQuery({
    queryKey: ['plugins', server.uuid, submitted, page],
    queryFn: () =>
      api.get<PluginSearchPage>(
        `/api/servers/${server.uuid}/plugins/search?query=${encodeURIComponent(submitted)}&page=${page}`,
      ),
    // The previous page stays on screen while the next one loads. Without it
    // the list empties and the layout jumps on every click, which reads as the
    // search having failed.
    placeholderData: (previous) => previous,
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
          setPage(1);
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
      {results.data && results.data.data.length > 0 ? (
        <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-content-subtle">
          {submitted ? t('plugins.results') : t('plugins.popular')}
        </h2>
      ) : null}

      {results.isPending ? <Spinner /> : null}

      {results.data?.data.length === 0 ? (
        <p className="text-sm text-content-muted">{t('plugins.noResults')}</p>
      ) : null}

      {/* Two columns once there is room. A single column of full-width cards
          showed four plugins on a laptop screen and made a catalogue of
          hundreds feel like a queue. */}
      <div className="grid gap-3 xl:grid-cols-2">
        {results.data?.data.map((hit) => (
          <PluginCard
            key={hit.projectId}
            hit={hit}
            expanded={selected?.projectId === hit.projectId}
            onToggle={() => setSelected(selected?.projectId === hit.projectId ? null : hit)}
          >
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
                      {version.loaders.join(', ')} · {version.gameVersions.slice(0, 3).join(', ')}
                    </span>
                  </span>

                  <div className="flex items-center gap-2">
                    {/* A version the catalogue publishes no checksum for is
                        installed all the same — refusing would rule out a good
                        part of the catalogue — but it is said, because the
                        daemon can then verify nothing. */}
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
          </PluginCard>
        ))}
      </div>
      {results.data ? (
        <Pagination
          currentPage={results.data.meta.currentPage}
          lastPage={results.data.meta.lastPage}
          perPage={results.data.meta.perPage}
          total={results.data.meta.total}
          onChange={(next) => {
            setSelected(null);
            setPage(next);
            // The bar is at the bottom of a long list; without this, clicking
            // "2" leaves the reader at the foot of a page they have not seen.
            window.scrollTo({ top: 0, behavior: 'smooth' });
          }}
        />
      ) : null}
    </>
  );
}
