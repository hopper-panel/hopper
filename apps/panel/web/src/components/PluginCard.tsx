import { Badge, Button, Card } from './ui';
import { useTranslation } from '../i18n';
import { formatCompact } from '../lib/format';

/**
 * One entry of the catalogue.
 *
 * Pulled out of the page because the page was mostly this, and because the
 * card is where the judgement calls live: which of Modrinth's many fields
 * actually help someone decide, and which are noise beside a name.
 */

export interface PluginHit {
  projectId: string;
  slug: string;
  title: string;
  description: string;
  downloads: number;
  iconUrl: string | null;
  categories: string[];
}

/**
 * Loaders are not categories, whatever the API calls them.
 *
 * Modrinth returns "paper", "fabric" and "utility" in one list. The first two
 * say whether the plugin can run at all; the third says what it does. Showing
 * them together made every card read like a pile of tags — and the loader,
 * the only one that can make an install fail, was lost in it.
 */
const LOADERS = new Set([
  'bukkit',
  'bungeecord',
  'fabric',
  'folia',
  'forge',
  'neoforge',
  'paper',
  'purpur',
  'quilt',
  'spigot',
  'sponge',
  'velocity',
  'waterfall',
]);

/** Rendered when the catalogue has no icon, instead of an empty grey square. */
function Initial({ title }: { title: string }) {
  return (
    <div
      aria-hidden
      className="flex size-12 shrink-0 items-center justify-center rounded-lg bg-surface text-lg font-semibold text-content-subtle"
    >
      {title.slice(0, 1).toUpperCase()}
    </div>
  );
}

export function PluginCard({
  hit,
  expanded,
  onToggle,
  children,
}: {
  hit: PluginHit;
  expanded: boolean;
  onToggle: () => void;
  children?: React.ReactNode;
}) {
  const { t, locale } = useTranslation();

  const loaders = hit.categories.filter((category) => LOADERS.has(category));
  const tags = hit.categories.filter((category) => !LOADERS.has(category)).slice(0, 3);

  return (
    <Card>
      <div className="flex items-start gap-3">
        {hit.iconUrl ? (
          <img
            src={hit.iconUrl}
            alt=""
            // Below the fold there are a dozen of these, and the operator will
            // read three of them.
            loading="lazy"
            // Modrinth learns that somebody wanted an icon, not which panel
            // they were looking at.
            referrerPolicy="no-referrer"
            className="size-12 shrink-0 rounded-lg bg-surface object-cover"
          />
        ) : (
          <Initial title={hit.title} />
        )}

        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
            <h3 className="font-medium text-content">{hit.title}</h3>

            {/* "68.7M downloads", not "68 699 360". Nobody compares two of
                those; the order of magnitude is the whole message. */}
            <span className="text-xs text-content-subtle">
              {t('plugins.downloads', { count: formatCompact(hit.downloads, locale) })}
            </span>
          </div>

          <p className="mt-1 line-clamp-2 text-sm text-content-muted">{hit.description}</p>

          {loaders.length > 0 || tags.length > 0 ? (
            <div className="mt-2 flex flex-wrap items-center gap-1.5">
              {/* The loaders first and highlighted: they are what decides
                  whether this can run on this server at all. */}
              {loaders.map((loader) => (
                <Badge key={loader} tone="online">
                  {loader}
                </Badge>
              ))}
              {tags.map((tag) => (
                <Badge key={tag}>{tag}</Badge>
              ))}
            </div>
          ) : null}
        </div>

        <div className="flex shrink-0 flex-col items-end gap-2">
          <Button onClick={onToggle}>
            {expanded ? t('plugins.hideVersions') : t('plugins.versions')}
          </Button>

          <a
            href={`https://modrinth.com/project/${hit.slug}`}
            target="_blank"
            rel="noreferrer noopener"
            className="text-xs text-content-subtle underline underline-offset-2 hover:text-content"
          >
            {t('plugins.viewOnModrinth')}
          </a>
        </div>
      </div>

      {expanded ? <div className="mt-4 border-t border-border-subtle pt-3">{children}</div> : null}
    </Card>
  );
}
