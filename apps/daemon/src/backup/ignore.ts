/**
 * Liste d'exclusion d'une sauvegarde, à la syntaxe `.gitignore`.
 *
 * Ce choix n'est pas gratuit : c'est la seule syntaxe d'exclusion que la
 * plupart des gens connaissent déjà, et les templates de serveurs Minecraft
 * circulent avec des listes écrites pour elle. En inventer une autre aurait
 * garanti des exclusions silencieusement inopérantes — le pire défaut possible
 * ici, puisqu'il ne se voit qu'au moment de restaurer.
 *
 * Sous-ensemble implémenté, volontairement restreint :
 *
 *   - `#` en début de ligne : commentaire ; lignes vides ignorées ;
 *   - `!motif` : réintègre ce qu'une règle précédente avait exclu ;
 *   - `*` ne traverse pas `/`, `**` le traverse ;
 *   - `motif/` ne vise que les répertoires ;
 *   - un motif sans `/` s'applique à n'importe quelle profondeur, comme dans
 *     `.gitignore` — `*.log` exclut aussi `plugins/x/latest.log` ;
 *   - un motif contenant `/` est ancré à la racine du volume.
 *
 * La dernière règle qui correspond l'emporte, ce qui est ce qui rend `!` utile.
 */

import { globToRegExp } from '../fs/jailed-filesystem.js';

interface Rule {
  readonly regex: RegExp;
  readonly negated: boolean;
  readonly directoryOnly: boolean;
}

export class IgnoreList {
  private readonly rules: readonly Rule[];

  constructor(patterns: readonly string[]) {
    this.rules = patterns.map(parsePattern).filter((rule): rule is Rule => rule !== null);
  }

  get isEmpty(): boolean {
    return this.rules.length === 0;
  }

  /**
   * Le chemin doit-il être écarté de l'archive ?
   *
   * @param relativePath chemin relatif à la racine du volume, séparé par `/`.
   * @param isDirectory un motif en `/` ne vise que les répertoires.
   */
  ignores(relativePath: string, isDirectory = false): boolean {
    const normalized = normalizeRelative(relativePath);

    if (normalized === '') {
      return false;
    }

    let ignored = false;

    // Pas de sortie anticipée : c'est la **dernière** règle correspondante qui
    // décide, sans quoi `!important.log` placé après `*.log` n'aurait aucun
    // effet.
    for (const rule of this.rules) {
      if (rule.directoryOnly && !isDirectory) {
        continue;
      }

      if (rule.regex.test(normalized)) {
        ignored = !rule.negated;
      }
    }

    return ignored;
  }

  /**
   * Un répertoire entier peut-il être sauté sans l'ouvrir ?
   *
   * Descendre dans `cache/` pour n'en retenir aucun fichier coûte un appel
   * système par entrée ; sur un serveur qui en compte des dizaines de milliers,
   * cela domine le temps de sauvegarde. On ne peut toutefois l'élaguer que si
   * aucune règle de réintégration ne peut ressortir quelque chose de son
   * contenu.
   */
  canPrune(relativePath: string): boolean {
    return this.ignores(relativePath, true) && !this.rules.some((rule) => rule.negated);
  }
}

function normalizeRelative(path: string): string {
  const normalized = path.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '');

  // La racine du volume, quelle que soit la façon de l'écrire. Un motif large
  // comme `**` ne doit pas pouvoir l'exclure : la sauvegarde serait vide, et
  // ce vide passerait pour un succès.
  return normalized === '.' ? '' : normalized;
}

function parsePattern(raw: string): Rule | null {
  let pattern = raw.trim();

  if (pattern === '' || pattern.startsWith('#')) {
    return null;
  }

  const negated = pattern.startsWith('!');
  if (negated) {
    pattern = pattern.slice(1);
  }

  const directoryOnly = pattern.endsWith('/');
  if (directoryOnly) {
    pattern = pattern.slice(0, -1);
  }

  pattern = pattern.replace(/^\/+/, '');

  if (pattern === '') {
    return null;
  }

  // Un motif ancré ne vaut qu'à la racine ; un motif nu vaut à toute
  // profondeur. Dans les deux cas le motif couvre aussi le contenu de ce qu'il
  // désigne : exclure `logs` doit exclure `logs/latest.log`, sans quoi la
  // règle ne ferait presque rien.
  const anchored = raw.trim().replace(/^!/, '').includes('/');
  const prefix = anchored ? '' : '(?:.*/)?';
  const body = globToRegExp(pattern).source.replace(/^\^/, '').replace(/\$$/, '');

  return {
    regex: new RegExp(`^${prefix}${body}(?:/.*)?$`),
    negated,
    directoryOnly,
  };
}

/**
 * Exclusions appliquées à toute sauvegarde, quelles que soient celles du
 * template.
 *
 * Ces chemins ne sont pas seulement inutiles : archiver `session.lock` pendant
 * que le serveur tourne produit une archive dont la restauration fait croire au
 * moteur de monde qu'une autre instance y écrit déjà.
 */
export const ALWAYS_IGNORED: readonly string[] = [
  'session.lock',
  '*.jfr',
  'core.*',
  'hs_err_pid*.log',
];
