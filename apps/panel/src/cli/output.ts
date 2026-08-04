/**
 * Sortie de la ligne de commande.
 *
 * Sans dépendance de coloration : six séquences ANSI suffisent, et une
 * bibliothèque de plus serait chargée à chaque démarrage du panel puisque la
 * CLI vit dans le même paquet.
 *
 * Les couleurs sont supprimées dès que la sortie n'est pas un terminal :
 * `hopper doctor > rapport.txt` doit produire un fichier lisible, et
 * l'installeur redirige la sortie.
 */
const enabled = process.stdout.isTTY === true && process.env.NO_COLOR === undefined;

function paint(code: number, text: string): string {
  return enabled ? `\u001B[${code}m${text}\u001B[0m` : text;
}

export const bold = (text: string): string => paint(1, text);
export const dim = (text: string): string => paint(2, text);
export const green = (text: string): string => paint(32, text);
export const red = (text: string): string => paint(31, text);
export const yellow = (text: string): string => paint(33, text);

export function heading(text: string): void {
  process.stdout.write(`\n${bold(text)}\n`);
}

export function line(text = ''): void {
  process.stdout.write(`${text}\n`);
}

/** Résultat d'une vérification de `doctor`. */
export type Level = 'ok' | 'warn' | 'fail';

export function report(level: Level, label: string, detail?: string): void {
  const badge = { ok: green('✓'), warn: yellow('!'), fail: red('✗') }[level];
  line(`  ${badge} ${label}${detail === undefined ? '' : ` ${dim(`— ${detail}`)}`}`);
}

/**
 * Message d'erreur fatale.
 *
 * Sur la sortie d'erreur, pour qu'un script qui capture la sortie standard
 * — l'installeur récupère ainsi un `daemon.yml` — ne se retrouve pas avec un
 * message d'erreur au milieu du fichier produit.
 */
export function fatal(message: string): never {
  process.stderr.write(`${red('✗')} ${message}\n`);
  process.exit(1);
}
