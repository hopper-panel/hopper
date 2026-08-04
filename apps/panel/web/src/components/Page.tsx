import type { ReactNode } from 'react';

/**
 * Page container: maximum width and margins.
 *
 * This constraint used to live in `Layout`, which made any full-width band
 * under the header impossible — a server's tab bar, for instance, would have
 * stopped at the edge of the content instead of running side to side. The
 * layout therefore constrains nothing any more, and each screen applies this
 * container where it needs it.
 */
export function Page({ children }: { children: ReactNode }) {
  return <div className="mx-auto max-w-7xl px-4 py-8">{children}</div>;
}
