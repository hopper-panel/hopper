/**
 * Concatène des classes CSS en ignorant les valeurs conditionnelles fausses.
 *
 * Dans son propre module plutôt que dans `components/ui.tsx` : un fichier qui
 * exporte à la fois des composants et des fonctions casse le rafraîchissement à
 * chaud de Vite.
 */
export function cx(...classes: (string | false | null | undefined)[]): string {
  return classes.filter(Boolean).join(' ');
}
