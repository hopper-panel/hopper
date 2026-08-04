import { Fragment } from 'react';

/**
 * Chemin d'un dossier, segment par segment.
 *
 * Partagé entre la liste et l'éditeur : les deux écrans doivent situer
 * l'utilisateur de la même façon, et deux implémentations finiraient par
 * diverger sur le traitement de la racine.
 *
 * `/home/container` est le chemin **dans le conteneur**, pas sur l'hôte. Il est
 * affiché parce que c'est celui qu'on retrouve dans les journaux du serveur et
 * dans les fichiers de configuration des plugins : le masquer obligerait à
 * traduire mentalement entre ce que dit le panel et ce que dit Minecraft.
 * `home` n'est pas cliquable — il n'existe rien au-dessus du volume.
 */
export function FileBreadcrumb({
  directory,
  file,
  onNavigate,
}: {
  /** Dossier courant, relatif au volume. */
  directory: string;
  /** Nom du fichier ouvert, ajouté en fin de chemin et non cliquable. */
  file?: string;
  onNavigate: (path: string) => void;
}) {
  const segments = directory.split('/').filter(Boolean);

  return (
    <nav aria-label="Chemin" className="flex flex-wrap items-center gap-1.5 font-mono text-sm">
      <Separator />
      <span className="text-content-subtle">home</span>
      <Separator />

      <button
        type="button"
        className="text-content-muted transition-colors hover:text-content hover:underline"
        onClick={() => onNavigate('/')}
      >
        container
      </button>

      {segments.map((segment, index) => (
        <Fragment key={`${segment}-${index}`}>
          <Separator />
          <button
            type="button"
            className="text-content-muted transition-colors hover:text-content hover:underline"
            onClick={() => onNavigate('/' + segments.slice(0, index + 1).join('/'))}
          >
            {segment}
          </button>
        </Fragment>
      ))}

      {file ? (
        <>
          <Separator />
          {/* Le fichier ouvert termine le chemin sans être un lien : il désigne
              l'endroit où l'on est déjà. */}
          <span className="font-semibold text-content">{file}</span>
        </>
      ) : null}
    </nav>
  );
}

function Separator() {
  return (
    <span aria-hidden className="text-content-subtle">
      /
    </span>
  );
}
