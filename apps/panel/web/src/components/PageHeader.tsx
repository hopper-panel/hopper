import type { ReactNode } from 'react';

/**
 * En-tête de page : titre, sous-titre et action principale.
 *
 * Dans son propre fichier plutôt qu'aux côtés de `Layout` : un module qui
 * exporte plusieurs composants casse le rafraîchissement à chaud de Vite, qui a
 * besoin d'un export par fichier pour savoir quoi remonter.
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
