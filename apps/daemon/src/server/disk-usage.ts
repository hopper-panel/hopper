import { lstat, readdir } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * Taille occupée par un volume de serveur.
 *
 * Parcours itératif plutôt que récursif : une arborescence de modpack descend
 * profondément, et une pile explicite ne risque pas de saturer celle du moteur.
 *
 * Les liens symboliques ne sont **pas** suivis. Un joueur peut en créer par
 * SFTP : les suivre compterait le contenu visé — potentiellement hors du volume,
 * ou plusieurs fois le même dossier — et un lien qui pointe sur son propre
 * parent ferait tourner la mesure indéfiniment.
 *
 * Les erreurs par entrée sont ignorées : un fichier supprimé pendant le
 * parcours est la norme sur un serveur qui tourne, et vaut mieux qu'une mesure
 * abandonnée.
 */
export async function directorySize(root: string): Promise<number> {
  const pending = [root];
  let total = 0;

  while (pending.length > 0) {
    const current = pending.pop()!;

    let entries;
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      const path = join(current, entry.name);

      if (entry.isDirectory()) {
        pending.push(path);
        continue;
      }

      // `Dirent` distingue déjà les liens des fichiers ordinaires : tout ce qui
      // n'est pas un fichier régulier — lien, socket, tube — n'occupe rien qui
      // vaille d'être compté.
      if (!entry.isFile()) {
        continue;
      }

      try {
        // `lstat` et non `stat` : entre le `readdir` et ici, l'entrée a pu être
        // remplacée par un lien, dont on mesurerait alors la cible.
        total += (await lstat(path)).size;
      } catch {
        continue;
      }
    }
  }

  return total;
}
