import { useTranslation } from '../i18n';
import { NextIcon, PreviousIcon } from './icons';

/**
 * Page navigation for a list the server pages through.
 *
 * Written once, here, because the catalogue is not the only list that outgrew
 * its first page — the administration's servers, users and nodes all fetch
 * `perPage=100` and hope.
 */

/**
 * The page numbers to show, with gaps.
 *
 * Ninety-five thousand results is three thousand pages, and a bar listing them
 * all is not a bar. The rule: always the first and the last, always the
 * current with a neighbour either side, and a gap where numbers were dropped.
 *
 * A gap is only worth drawing when it hides more than one page. Replacing a
 * single number with an ellipsis costs the same width and takes away somewhere
 * to click, so 1 … 3 is written 1 2 3.
 *
 * Exported and pure: the arithmetic is fiddly at the edges — near the start,
 * near the end, and when the whole thing fits — and every edge is a bar that
 * looks broken.
 */
export type PageItem = number | 'gap';

export function pageItems(current: number, last: number): PageItem[] {
  if (last <= 1) {
    return [1];
  }

  const wanted = new Set<number>([1, last, current]);

  for (const page of [current - 1, current + 1]) {
    if (page >= 1 && page <= last) {
      wanted.add(page);
    }
  }

  const pages = [...wanted].sort((a, b) => a - b);
  const items: PageItem[] = [];

  for (const [index, page] of pages.entries()) {
    const previous = pages[index - 1];

    if (previous !== undefined) {
      if (page - previous === 2) {
        items.push(previous + 1);
      } else if (page - previous > 2) {
        items.push('gap');
      }
    }

    items.push(page);
  }

  return items;
}

const BUTTON =
  'inline-flex h-8 min-w-8 items-center justify-center rounded-lg px-2 text-sm transition-colors';

export function Pagination({
  currentPage,
  lastPage,
  perPage,
  total,
  onChange,
}: {
  currentPage: number;
  lastPage: number;
  perPage: number;
  total: number;
  onChange: (page: number) => void;
}) {
  const { t, locale } = useTranslation();

  // Nothing to navigate. A bar reading "page 1 of 1" is furniture.
  if (lastPage <= 1) {
    return null;
  }

  const number = (value: number): string => new Intl.NumberFormat(locale).format(value);

  const from = (currentPage - 1) * perPage + 1;
  // The last page is rarely full, and claiming 95 390 of 95 363 is the kind of
  // detail that makes someone doubt the rest of the screen.
  const to = Math.min(currentPage * perPage, total);

  return (
    <nav
      aria-label={t('pagination.label')}
      className="mt-4 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border-subtle bg-surface-raised px-4 py-3"
    >
      <p className="text-sm text-content-muted">
        {t('pagination.showing', { from: number(from), to: number(to), total: number(total) })}
      </p>

      <div className="flex items-center gap-1">
        <button
          type="button"
          aria-label={t('pagination.previous')}
          disabled={currentPage <= 1}
          onClick={() => onChange(currentPage - 1)}
          className={`${BUTTON} text-content-muted hover:bg-surface disabled:opacity-40 disabled:hover:bg-transparent`}
        >
          <PreviousIcon className="size-4" />
        </button>

        {pageItems(currentPage, lastPage).map((item, index) =>
          item === 'gap' ? (
            // Not a button: there is no single page it could mean.
            <span key={`gap-${index}`} aria-hidden className="px-1 text-sm text-content-subtle">
              …
            </span>
          ) : (
            <button
              key={item}
              type="button"
              aria-current={item === currentPage ? 'page' : undefined}
              onClick={() => onChange(item)}
              className={
                item === currentPage
                  ? `${BUTTON} bg-accent font-medium text-surface`
                  : `${BUTTON} text-content-muted hover:bg-surface`
              }
            >
              {number(item)}
            </button>
          ),
        )}

        <button
          type="button"
          aria-label={t('pagination.next')}
          disabled={currentPage >= lastPage}
          onClick={() => onChange(currentPage + 1)}
          className={`${BUTTON} text-content-muted hover:bg-surface disabled:opacity-40 disabled:hover:bg-transparent`}
        >
          <NextIcon className="size-4" />
        </button>
      </div>
    </nav>
  );
}
