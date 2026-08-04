/**
 * Construction de la commande de démarrage d'un serveur.
 *
 * C'est le point le plus sensible du daemon : le gabarit vient d'un template, et
 * les valeurs des variables viennent en partie de l'utilisateur. Une
 * concaténation naïve suivie d'un `sh -c` donnerait à quiconque peut éditer une
 * variable la possibilité d'exécuter n'importe quoi dans le conteneur.
 *
 * La parade tient en une règle : **on découpe d'abord, on substitue ensuite.**
 *
 *   1. Le gabarit est découpé en arguments, en respectant les guillemets.
 *   2. Les `{{VARIABLES}}` sont remplacées *à l'intérieur* de chaque argument.
 *   3. Le tableau obtenu est passé tel quel à Docker, sans interpréteur.
 *
 * Une valeur contenant un espace reste donc un seul argument ; une valeur
 * contenant `;`, `&&`, `$(...)` ou un retour à la ligne n'est jamais interprétée,
 * puisque aucun shell ne voit jamais la commande.
 */

/** Motif d'une variable dans un gabarit : `{{NOM}}`, espaces tolérés. */
const VARIABLE_PATTERN = /\{\{\s*([A-Za-z_][A-Za-z0-9_.]*)\s*\}\}/g;

export class InvocationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvocationError';
  }
}

/**
 * Découpe une ligne de commande en arguments.
 *
 * Reproduit le comportement d'un shell sur les guillemets simples et doubles,
 * et rien d'autre : ni expansion de variables, ni globbing, ni substitution de
 * commande. Ce qui n'est pas implémenté ici ne peut pas être exploité.
 */
export function tokenize(input: string): string[] {
  const tokens: string[] = [];
  let current = '';
  let started = false;
  let quote: '"' | "'" | null = null;

  for (let index = 0; index < input.length; index += 1) {
    const char = input[index]!;

    if (quote) {
      if (char === quote) {
        quote = null;
      } else {
        current += char;
      }
      continue;
    }

    if (char === '"' || char === "'") {
      quote = char;
      // Un argument vide explicite (`""`) doit produire un argument, pas rien.
      started = true;
      continue;
    }

    if (char === ' ' || char === '\t' || char === '\n' || char === '\r') {
      if (started) {
        tokens.push(current);
        current = '';
        started = false;
      }
      continue;
    }

    current += char;
    started = true;
  }

  if (quote) {
    throw new InvocationError(`Guillemet ${quote} non fermé dans la commande de démarrage.`);
  }

  if (started) {
    tokens.push(current);
  }

  return tokens;
}

export interface InvocationContext {
  /** Variables du template, déjà validées côté panel. */
  environment: Record<string, string>;
  /** Mémoire allouée, en mébioctets — c'est l'unité qu'attend `-Xmx`. */
  memoryMib: number;
  ip: string;
  port: number;
}

/**
 * Marge laissée en dehors du tas, en mébioctets.
 *
 * Deux postes s'y cachent, et oublier le second est le piège :
 *
 *  - **le hors-tas de la JVM** : métaespace, cache de code, piles de threads, et
 *    les tampons directs de Netty qui portent le trafic réseau. Mesuré à ~250
 *    Mio sur un Paper 1.21.4 au repos ;
 *  - **le cache de pages**, qui est compté dans le cgroup au même titre que la
 *    mémoire anonyme. Un serveur Minecraft lit ses fichiers de région en
 *    permanence ; s'il ne reste rien pour les cacher, le noyau évince tout — et
 *    une fois qu'il n'a plus rien à reprendre, il tue le processus.
 *
 * Une mesure sur la machine de test le montre sans ambiguïté : conteneur de
 * 1024 Mio, `-Xmx768M`. Le serveur démarre complètement, puis reste collé au
 * plafond pendant que le cache tombe de 127 Mio à 0, et meurt en code 137.
 * L'anonyme seul atteignait 1018 Mio — la marge de 256 Mio couvrait la JVM,
 * mais ne laissait pas un octet au cache.
 */
const JVM_OVERHEAD_MIB = 384;

/**
 * Part maximale de la limite attribuable au tas.
 *
 * Prend le relais sur les grosses allocations : les structures du GC et les
 * tampons de Netty croissent avec le tas et avec le nombre de joueurs, si bien
 * qu'une marge fixe finirait par être dépassée. Le plafond garde une
 * proportion constante quelle que soit la taille.
 */
export const MAX_HEAP_RATIO = 0.8;

/**
 * Budget de tas d'une JVM, à partir de la limite du conteneur.
 *
 * Donner la limite entière à `-Xmx` est le piège classique de l'hébergement
 * Minecraft : le tas peut alors à lui seul remplir le cgroup, et le noyau tue
 * le processus dès que la JVM alloue hors tas. Le serveur meurt en code 137,
 * sans rien dans ses journaux — il était en train de générer son monde, tout
 * allait bien, et il disparaît.
 *
 * On réserve donc la marge ci-dessus, en la plafonnant à une fraction de la
 * limite pour que les petites allocations gardent elles aussi de l'air.
 */
export function heapBudgetMib(limitMib: number): number {
  if (limitMib <= 0) {
    return 0;
  }

  const withOverhead = limitMib - JVM_OVERHEAD_MIB;
  const withRatio = Math.floor(limitMib * MAX_HEAP_RATIO);

  // 128 Mio est le plancher en dessous duquel une JVM ne démarre pas.
  return Math.max(128, Math.min(withOverhead, withRatio));
}

/**
 * Variables fournies par Hopper en plus de celles du template.
 * Elles priment : un template ne doit pas pouvoir redéfinir le port d'écoute.
 */
function builtinVariables(context: InvocationContext): Record<string, string> {
  const heap = heapBudgetMib(context.memoryMib);

  return {
    // `SERVER_MEMORY` désigne le budget de **tas**, pas la limite du conteneur.
    // C'est ce que les templates passent à `-Xmx`, et c'est la valeur qui doit
    // laisser de la marge.
    SERVER_MEMORY: String(heap),
    // La limite brute reste disponible pour les templates qui en ont besoin —
    // un script d'installation qui dimensionne un cache, par exemple.
    SERVER_MEMORY_LIMIT: String(context.memoryMib),
    SERVER_IP: context.ip,
    SERVER_PORT: String(context.port),
    // Alias couramment utilisés par les eggs Pterodactyl importés.
    'server.build.default.ip': context.ip,
    'server.build.default.port': String(context.port),
    'server.build.memory': String(heap),
  };
}

/**
 * Remplace les variables dans une chaîne.
 *
 * Une variable inconnue est remplacée par une chaîne vide, comme le ferait un
 * shell — et signalée par l'appelant, car c'est presque toujours une faute de
 * frappe dans le template.
 */
export function substitute(
  input: string,
  context: InvocationContext,
): { value: string; missing: string[] } {
  const variables = { ...context.environment, ...builtinVariables(context) };
  const missing: string[] = [];

  const value = input.replace(VARIABLE_PATTERN, (_match, name: string) => {
    const replacement = variables[name];

    if (replacement === undefined) {
      missing.push(name);
      return '';
    }

    return replacement;
  });

  return { value, missing };
}

export interface BuiltInvocation {
  /** Arguments prêts pour Docker. Le premier élément est l'exécutable. */
  argv: string[];
  /** Variables référencées par le gabarit mais absentes du contexte. */
  missingVariables: string[];
}

/**
 * Transforme un gabarit de démarrage en tableau d'arguments.
 *
 * @throws {InvocationError} si le gabarit est vide, mal guillemeté, ou ne
 *   produit aucun exécutable une fois substitué.
 */
export function buildInvocation(template: string, context: InvocationContext): BuiltInvocation {
  // Découpage AVANT substitution : c'est ce qui empêche une valeur de variable
  // d'introduire un argument supplémentaire.
  const tokens = tokenize(template);

  if (tokens.length === 0) {
    throw new InvocationError('La commande de démarrage est vide.');
  }

  const missing = new Set<string>();
  const argv: string[] = [];

  for (const token of tokens) {
    const result = substitute(token, context);
    result.missing.forEach((name) => missing.add(name));

    // Un argument devenu vide est retiré : `-Xmx{{SERVER_MEMORY}}M` avec une
    // mémoire illimitée donnerait `-XmxM`, que la JVM refuse. Mais un argument
    // vide écrit explicitement (`""`) a été conservé par le tokenizer et doit
    // le rester — d'où le test sur le token d'origine.
    if (result.value === '' && token !== '') {
      continue;
    }

    argv.push(result.value);
  }

  if (argv.length === 0 || argv[0] === '') {
    throw new InvocationError(
      'La commande de démarrage ne désigne aucun exécutable une fois les variables résolues.',
    );
  }

  return { argv, missingVariables: [...missing] };
}

/**
 * Variables d'environnement injectées dans le conteneur.
 *
 * Les noms ne respectant pas la syntaxe POSIX sont écartés : `docker` les
 * accepterait, mais un `export` dans un script d'installation échouerait, et le
 * message d'erreur serait incompréhensible.
 */
export function buildEnvironment(context: InvocationContext): string[] {
  const merged = { ...context.environment, ...builtinVariables(context) };

  return Object.entries(merged)
    .filter(([name]) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(name))
    .map(([name, value]) => `${name}=${value}`);
}
