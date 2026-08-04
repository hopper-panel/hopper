import type { ReactNode } from 'react';

/**
 * Conteneur de page : largeur maximale et marges.
 *
 * Cette contrainte vivait dans `Layout`, ce qui rendait impossible toute bande
 * pleine largeur sous l'en-tête — la barre d'onglets d'un serveur, par exemple,
 * se serait arrêtée au bord du contenu au lieu de courir d'un côté à l'autre.
 * La mise en page ne contraint donc plus rien, et chaque écran applique ce
 * conteneur là où il en a besoin.
 */
export function Page({ children }: { children: ReactNode }) {
  return <div className="mx-auto max-w-7xl px-4 py-8">{children}</div>;
}
