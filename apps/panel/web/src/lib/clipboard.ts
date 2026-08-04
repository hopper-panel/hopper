/**
 * Copie un texte dans le presse-papiers.
 *
 * `navigator.clipboard` n'existe **que dans un contexte sécurisé** : HTTPS, ou
 * `localhost`. Un panel servi en HTTP simple — installation interne, ou avant
 * la mise en place du reverse proxy — n'y a donc pas accès du tout, et un
 * bouton « copier » qui s'appuierait dessus ne ferait rien, sans erreur
 * visible.
 *
 * D'où le repli sur `execCommand`, officiellement obsolète mais toujours
 * implémenté partout et le seul disponible hors contexte sécurisé.
 */
export async function copyText(text: string): Promise<boolean> {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // Permission refusée ou document sans focus : on tente le repli.
    }
  }

  return copyWithSelection(text);
}

function copyWithSelection(text: string): boolean {
  const holder = document.createElement('textarea');

  holder.value = text;
  // Hors écran plutôt que masqué : un élément en `display: none` ne peut pas
  // être sélectionné, et la copie échouerait silencieusement.
  holder.style.position = 'fixed';
  holder.style.top = '-1000px';
  holder.setAttribute('readonly', '');

  document.body.appendChild(holder);

  try {
    holder.select();
    return document.execCommand('copy');
  } catch {
    return false;
  } finally {
    document.body.removeChild(holder);
  }
}
