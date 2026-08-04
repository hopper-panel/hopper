import { constants as fsConstants } from 'node:fs';
import {
  access,
  chmod,
  chown,
  lstat,
  mkdir,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { dirname, isAbsolute, join, normalize, posix, relative, resolve, sep } from 'node:path';

/**
 * Accès au système de fichiers d'un serveur, confiné à son volume.
 *
 * **Toute** opération sur les fichiers d'un serveur passe par cette classe.
 * C'est la règle la plus importante du daemon : un `fs.readFile` direct sur un
 * chemin venu d'une requête suffit à donner à l'utilisateur d'un serveur
 * Minecraft la lecture de `/etc/shadow` ou l'écriture dans `/etc/cron.d`.
 *
 * Trois mécanismes se superposent, parce qu'aucun ne suffit seul :
 *
 *  1. **Normalisation** — `../../etc/passwd` est réduit puis comparé à la
 *     racine. Élimine la traversée naïve.
 *  2. **Résolution réelle** — le chemin est résolu à travers les liens
 *     symboliques. Sans elle, `ln -s / evasion` puis `evasion/etc/passwd`
 *     passerait la normalisation sans problème, et l'utilisateur peut créer ce
 *     lien lui-même depuis sa console.
 *  3. **Liste noire** — certains fichiers restent interdits même à l'intérieur
 *     du volume : le secret de redirection d'un proxy, par exemple, permettrait
 *     d'usurper l'identité de n'importe quel joueur.
 *
 * Les chemins manipulés à l'extérieur de cette classe sont toujours **relatifs
 * au volume et en séparateurs POSIX** (`plugins/config.yml`). Le chemin absolu
 * sur l'hôte ne sort jamais d'ici : il apparaîtrait sinon dans un message
 * d'erreur renvoyé à l'utilisateur, révélant l'arborescence de la machine.
 */

export class PathEscapeError extends Error {
  constructor(readonly requestedPath: string) {
    super('Chemin hors du répertoire du serveur.');
    this.name = 'PathEscapeError';
  }
}

export class DeniedFileError extends Error {
  constructor(readonly requestedPath: string) {
    super('Ce fichier est protégé et ne peut pas être consulté ni modifié.');
    this.name = 'DeniedFileError';
  }
}

export class NotFoundError extends Error {
  constructor(readonly requestedPath: string) {
    super('Fichier ou dossier introuvable.');
    this.name = 'NotFoundError';
  }
}

export interface FileEntry {
  name: string;
  /** Chemin relatif au volume, séparateurs POSIX. */
  path: string;
  directory: boolean;
  /** Vrai pour un lien symbolique, quelle que soit sa cible. */
  symlink: boolean;
  sizeBytes: number;
  mode: string;
  modifiedAt: Date;
}

export interface JailOptions {
  /** Racine du volume sur l'hôte. */
  root: string;
  /** Motifs glob interdits, relatifs à la racine. */
  denylist?: string[];
  /**
   * Utilisateur du conteneur, propriétaire de tout ce qui est créé ici.
   *
   * Le daemon écrit en root ; le serveur, lui, tourne en uid non privilégié.
   * Sans cette reprise de propriété, tout chemin **créé** par le gestionnaire
   * de fichiers — un dossier de plugin, une archive extraite, un fichier
   * envoyé — appartenait à root et devenait illisible pour le serveur. Le
   * symptôme apparaît bien plus tard, sous la forme d'un plugin qui n'arrive
   * pas à écrire sa configuration.
   *
   * Absent sous Windows, où `chown` n'a pas de sens.
   */
  ownership?: { uid: number; gid: number };
}

export class JailedFilesystem {
  private readonly denylist: RegExp[];
  /** Racine résolue, calculée une fois : elle-même peut être un lien. */
  private resolvedRoot: string | null = null;

  constructor(private readonly options: JailOptions) {
    this.denylist = (options.denylist ?? []).map(globToRegExp);
  }

  private async root(): Promise<string> {
    if (this.resolvedRoot === null) {
      await mkdir(this.options.root, { recursive: true });
      this.resolvedRoot = await realpath(this.options.root);
    }

    return this.resolvedRoot;
  }

  // -------------------------------------------------------------------------
  // Résolution
  // -------------------------------------------------------------------------

  /**
   * Traduit un chemin fourni par l'utilisateur en chemin absolu sur l'hôte.
   *
   * @throws {PathEscapeError} si le chemin sort du volume, directement ou via
   *   un lien symbolique.
   * @throws {DeniedFileError} si le chemin figure dans la liste noire.
   */
  async resolvePath(userPath: string): Promise<string> {
    const root = await this.root();
    const relativePath = this.toRelative(userPath);

    this.assertNotDenied(relativePath);

    const candidate = resolve(root, relativePath);

    // Première barrière : après normalisation, le chemin doit rester sous la
    // racine. Attrape `../../etc/passwd` et les chemins absolus.
    if (!isInside(root, candidate)) {
      throw new PathEscapeError(userPath);
    }

    // Seconde barrière : la résolution réelle. Le fichier visé peut ne pas
    // exister encore — on résout donc le plus long ancêtre existant, puis on
    // vérifie que le reste ne ressort pas.
    const resolved = await this.realpathOfLongestExistingPrefix(candidate);

    if (!isInside(root, resolved)) {
      throw new PathEscapeError(userPath);
    }

    // C'est le chemin **résolu** qui est rendu, pas celui fourni.
    //
    // Rendre le chemin d'origine laisserait le système de fichiers retraverser
    // les liens au moment de l'opération, donc une seconde fois après la
    // vérification. Un utilisateur qui remplace le lien entre les deux — il en
    // a les moyens, par sa console comme par SFTP — ferait porter l'écriture
    // sur une cible que personne n'a contrôlée. En travaillant sur le chemin
    // déjà résolu, il n'y a plus de lien à retraverser.
    return resolved;
  }

  /**
   * Résout les liens symboliques sur la portion existante d'un chemin.
   *
   * `realpath` échoue sur un chemin inexistant, or on doit pouvoir écrire un
   * fichier qui n'existe pas encore. On remonte donc jusqu'au premier ancêtre
   * existant, on le résout, et on rattache le reste.
   */
  private async realpathOfLongestExistingPrefix(candidate: string): Promise<string> {
    let existing = candidate;
    const missing: string[] = [];

    for (;;) {
      try {
        await access(existing, fsConstants.F_OK);
        break;
      } catch {
        const parent = dirname(existing);

        // Racine du système atteinte : plus rien à remonter.
        if (parent === existing) {
          return candidate;
        }

        missing.unshift(existing.slice(parent.length + 1));
        existing = parent;
      }
    }

    return join(await realpath(existing), ...missing);
  }

  /** Normalise un chemin utilisateur en chemin relatif sûr à manipuler. */
  private toRelative(userPath: string): string {
    // Les séparateurs Windows sont acceptés en entrée : un client SFTP ou un
    // navigateur peut en envoyer, et les refuser n'apporterait rien.
    const unified = userPath.replace(/\\/g, '/');

    // Un octet nul tronque le chemin dans les appels système en C : `a\0../..`
    // serait vu comme `a` par la vérification et comme autre chose par le
    // noyau. Node lève déjà sur ce cas, mais on refuse explicitement.
    // `includes` sur la chaîne plutôt qu'une expression régulière : chercher un
    // caractère de contrôle dans une regex déclenche `no-control-regex`, et une
    // exception de lint attirerait l'attention sur la mauvaise chose.
    if (unified.includes('\0')) {
      throw new PathEscapeError(userPath);
    }

    const normalized = posix.normalize(unified);
    const withoutLeadingSlash = normalized.replace(/^\/+/, '');

    return withoutLeadingSlash === '' ? '.' : withoutLeadingSlash;
  }

  private assertNotDenied(relativePath: string): void {
    const posixPath = relativePath.split(sep).join('/');

    if (this.denylist.some((pattern) => pattern.test(posixPath))) {
      throw new DeniedFileError(relativePath);
    }
  }

  /** Chemin relatif au volume, en séparateurs POSIX, pour l'extérieur. */
  private async toUserPath(absolute: string): Promise<string> {
    const root = await this.root();
    return relative(root, absolute).split(sep).join('/');
  }

  // -------------------------------------------------------------------------
  // Lecture
  // -------------------------------------------------------------------------

  async list(userPath: string): Promise<FileEntry[]> {
    const absolute = await this.resolvePath(userPath);

    let entries;
    try {
      entries = await readdir(absolute, { withFileTypes: true });
    } catch {
      throw new NotFoundError(userPath);
    }

    const results: FileEntry[] = [];

    for (const entry of entries) {
      const entryPath = join(absolute, entry.name);
      const relativePath = await this.toUserPath(entryPath);

      // Un fichier de la liste noire n'apparaît pas non plus dans la liste :
      // le montrer sans permettre de le lire ne ferait qu'attirer l'attention.
      if (this.denylist.some((pattern) => pattern.test(relativePath))) {
        continue;
      }

      // `lstat` et non `stat` : on veut décrire le lien lui-même, pas sa cible.
      // Suivre la cible ferait apparaître la taille d'un fichier situé hors du
      // volume.
      const stats = await lstat(entryPath).catch(() => null);

      if (!stats) {
        continue;
      }

      results.push({
        name: entry.name,
        path: relativePath,
        directory: stats.isDirectory(),
        symlink: stats.isSymbolicLink(),
        sizeBytes: stats.isDirectory() ? 0 : stats.size,
        mode: formatMode(stats.mode),
        modifiedAt: stats.mtime,
      });
    }

    // Dossiers d'abord, puis ordre alphabétique : c'est ce qu'affichent tous
    // les gestionnaires de fichiers, et l'écart surprendrait.
    return results.sort((a, b) => {
      if (a.directory !== b.directory) {
        return a.directory ? -1 : 1;
      }
      return a.name.localeCompare(b.name, 'fr');
    });
  }

  async stat(userPath: string): Promise<FileEntry> {
    const absolute = await this.resolvePath(userPath);
    const stats = await lstat(absolute).catch(() => null);

    if (!stats) {
      throw new NotFoundError(userPath);
    }

    return {
      name: absolute.split(sep).pop() ?? '',
      path: await this.toUserPath(absolute),
      directory: stats.isDirectory(),
      symlink: stats.isSymbolicLink(),
      sizeBytes: stats.isDirectory() ? 0 : stats.size,
      mode: formatMode(stats.mode),
      modifiedAt: stats.mtime,
    };
  }

  /** Chemin absolu sur l'hôte, pour les appels qui ouvrent un flux. */
  async absolutePathFor(userPath: string): Promise<string> {
    return this.resolvePath(userPath);
  }

  // -------------------------------------------------------------------------
  // Écriture
  // -------------------------------------------------------------------------

  async writeFile(userPath: string, content: string | Buffer): Promise<void> {
    const absolute = await this.resolvePath(userPath);

    await mkdir(dirname(absolute), { recursive: true });
    await writeFile(absolute, content);
    await this.applyOwnership(absolute);
  }

  async createDirectory(userPath: string): Promise<void> {
    const absolute = await this.resolvePath(userPath);
    await mkdir(absolute, { recursive: true });
    await this.applyOwnership(absolute);
  }

  /**
   * Donne un chemin déjà résolu à l'utilisateur du conteneur.
   *
   * Public car les écritures en flux — envoi d'un fichier, extraction d'une
   * archive — produisent leurs chemins elles-mêmes et doivent pouvoir en
   * reprendre la propriété. Un échec est ignoré : sur un système de fichiers
   * sans propriétaires, perdre l'appartenance vaut mieux que perdre l'écriture.
   */
  async applyOwnership(absolutePath: string): Promise<void> {
    const ownership = this.options.ownership;

    if (!ownership) {
      return;
    }

    await chown(absolutePath, ownership.uid, ownership.gid).catch(() => undefined);
  }

  /**
   * Change les droits d'un chemin.
   *
   * Les bits `setuid`/`setgid` ne sont pas atteignables : le schéma du contrat
   * n'accepte que trois chiffres octaux. Un binaire setuid déposé dans un
   * volume s'exécuterait avec les droits de son propriétaire et annulerait le
   * cloisonnement du conteneur.
   */
  async chmod(userPath: string, mode: number): Promise<void> {
    const absolute = await this.resolvePath(userPath);
    await chmod(absolute, mode & 0o777);
  }

  async delete(userPaths: string[]): Promise<void> {
    for (const userPath of userPaths) {
      const absolute = await this.resolvePath(userPath);
      const root = await this.root();

      // Supprimer la racine viderait le serveur d'un coup, sans passer par la
      // suppression du serveur elle-même.
      if (absolute === root) {
        throw new PathEscapeError(userPath);
      }

      await rm(absolute, { recursive: true, force: true });
    }
  }

  /**
   * Vide le volume sans le supprimer.
   *
   * Réservé à la restauration d'une sauvegarde : `delete` refuse la racine, et
   * à raison — aucune opération de l'utilisateur ne doit pouvoir effacer un
   * serveur d'un seul appel. Restaurer est le seul cas où c'est l'intention,
   * et le point d'entrée distinct rend cette intention explicite plutôt que de
   * relâcher la garde de `delete`.
   *
   * Le répertoire lui-même est conservé : il porte les droits `uid:gid` que le
   * conteneur attend, et le recréer les perdrait.
   */
  async emptyRoot(): Promise<void> {
    const root = await this.root();

    for (const entry of await readdir(root)) {
      await rm(join(root, entry), { recursive: true, force: true });
    }
  }

  async rename(fromPath: string, toPath: string): Promise<void> {
    const from = await this.resolvePath(fromPath);
    const to = await this.resolvePath(toPath);

    await mkdir(dirname(to), { recursive: true });
    await rename(from, to);
  }

  async copy(fromPath: string, toPath: string): Promise<void> {
    const from = await this.resolvePath(fromPath);
    const to = await this.resolvePath(toPath);

    const stats = await stat(from).catch(() => null);

    if (!stats) {
      throw new NotFoundError(fromPath);
    }

    await mkdir(dirname(to), { recursive: true });

    const { cp } = await import('node:fs/promises');
    // `dereference: false` : copier un lien le recopie comme lien, sans
    // rapatrier le contenu de sa cible — qui pourrait être hors du volume.
    await cp(from, to, { recursive: true, dereference: false, force: true });
  }

  // -------------------------------------------------------------------------
  // Archives
  // -------------------------------------------------------------------------

  /**
   * Vérifie qu'une entrée d'archive peut être extraite.
   *
   * C'est la protection contre le « zip-slip » : une archive peut contenir une
   * entrée nommée `../../etc/cron.d/backdoor`, et beaucoup de bibliothèques
   * d'extraction l'écrivent sans broncher. Chaque entrée passe donc par la
   * même résolution que n'importe quel chemin utilisateur.
   *
   * @returns le chemin absolu de destination.
   * @throws {PathEscapeError} si l'entrée sort du répertoire de destination.
   */
  async resolveArchiveEntry(destination: string, entryName: string): Promise<string> {
    const destinationPath = await this.resolvePath(destination);
    const root = await this.root();

    const target = resolve(destinationPath, this.toRelative(entryName));

    // Double contrôle : sous la racine du volume *et* sous la destination
    // demandée. Une archive ne doit pas non plus écrire ailleurs dans le
    // volume que là où l'utilisateur a demandé de l'extraire.
    if (!isInside(root, target) || !isInside(destinationPath, target)) {
      throw new PathEscapeError(entryName);
    }

    this.assertNotDenied(await this.toUserPath(target));

    return target;
  }
}

/** `rwxr-xr-x` à partir du mode POSIX. */
export function formatMode(mode: number): string {
  const permissions = ['r', 'w', 'x'];

  return Array.from({ length: 9 }, (_unused, index) => {
    const bit = 1 << (8 - index);
    return (mode & bit) === 0 ? '-' : permissions[index % 3]!;
  }).join('');
}

/**
 * Un chemin est-il à l'intérieur d'un répertoire ?
 *
 * La comparaison inclut le séparateur : sans lui, `/var/lib/hopper-evil`
 * passerait pour être sous `/var/lib/hopper`.
 */
export function isInside(parent: string, candidate: string): boolean {
  if (candidate === parent) {
    return true;
  }

  const normalizedParent = parent.endsWith(sep) ? parent : parent + sep;
  return candidate.startsWith(normalizedParent);
}

/**
 * Traduit un motif glob simple en expression régulière.
 *
 * Volontairement limité à `*` (un segment) et `**` (plusieurs) : les listes
 * noires de templates n'utilisent rien d'autre, et une implémentation complète
 * de glob serait une surface d'erreur inutile à un endroit où une faute se paie
 * en fichier exposé.
 */
export function globToRegExp(pattern: string): RegExp {
  const escaped = pattern
    .split(sep)
    .join('/')
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    // `**` est mis de côté avant `*`, sinon le remplacement de `*` le
    // découperait en deux. Le marqueur temporaire est un octet nul plutôt
    // qu'une espace : une espace peut apparaître dans un nom de fichier
    // légitime — « Mon Monde/** » — et serait alors transformée en `.*`,
    // élargissant le motif bien au-delà de ce que son auteur voulait.
    .replace(/\*\*/g, '\0')
    .replace(/\*/g, '[^/]*')
    .replace(/\0/g, '.*')
    .replace(/\?/g, '[^/]');

  return new RegExp(`^${escaped}$`);
}

/** Un chemin utilisateur est-il absolu, sous une forme ou une autre ? */
export function looksAbsolute(userPath: string): boolean {
  return (
    isAbsolute(userPath) || /^[a-zA-Z]:[\\/]/.test(userPath) || normalize(userPath).startsWith('/')
  );
}
