/**
 * Options de la ligne de commande.
 *
 * Dans son propre module et non dans `main.ts` : ce dernier lance la commande
 * dès son import, ce qui rendrait l'analyseur intestable.
 */
export type Flags = Map<string, string | true>;

/**
 * Analyse `--clé valeur`, `--clé=valeur` et `--drapeau`.
 *
 * Écrit à la main plutôt qu'avec une bibliothèque d'arguments : cinq commandes
 * et une dizaine d'options ne justifient pas une dépendance de plus dans un
 * paquet qui sert aussi de serveur.
 */
export function parseFlags(argv: string[]): Flags {
  const flags: Flags = new Map();

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]!;

    if (!argument.startsWith('--')) {
      continue;
    }

    const [key, inlineValue] = argument.slice(2).split(/=(.*)/s, 2);

    if (key === undefined || key === '') {
      continue;
    }

    if (inlineValue !== undefined) {
      flags.set(key, inlineValue);
      continue;
    }

    const next = argv[index + 1];

    // Une valeur qui commence par `--` est l'option suivante, pas la valeur de
    // celle-ci : `--admin --username x` ne doit pas donner `admin=--username`,
    // ce qui créerait un compte nommé `x` sans les droits demandés.
    if (next === undefined || next.startsWith('--')) {
      flags.set(key, true);
      continue;
    }

    flags.set(key, next);
    index += 1;
  }

  return flags;
}

/**
 * Valeur textuelle d'une option.
 *
 * `undefined` quand elle est absente **ou** nue : `--password` sans valeur ne
 * doit pas passer pour un mot de passe vide, qui serait accepté par le schéma
 * puis haché.
 */
export function textOf(flags: Flags, key: string): string | undefined {
  const value = flags.get(key);
  return typeof value === 'string' ? value : undefined;
}
