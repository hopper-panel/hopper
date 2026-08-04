import type { ReactNode } from 'react';

/**
 * Page header: title, subtitle and primary action.
 *
 * In its own file rather than alongside `Layout`: a module exporting several
 * components breaks Vite's hot reload, which needs one export per file to know
 * what to remount.
 */
export function PageHeader({
  title,
  description,
  action,
}: {
  /** Texte, ou contenu riche — un fil d'Ariane par exemple. */
  title: ReactNode;
  /** Texte, ou contenu riche — un fil d'Ariane cliquable par exemple. */
  description?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="mb-6 flex items-start justify-between gap-4">
      <div>
        <h1 className="text-xl font-semibold text-content">{title}</h1>
        {description ? <p className="mt-1 text-sm text-content-muted">{description}</p> : null}
      </div>
      {action}
    </div>
  );
}
