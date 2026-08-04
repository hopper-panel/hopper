/**
 * Expressions cron : analyse et calcul de la prochaine occurrence.
 *
 * Écrit ici plutôt qu'emprunté à une bibliothèque, pour deux raisons.
 *
 * D'abord, le champ à couvrir est étroit et connu : cinq champs, la syntaxe que
 * tout le monde écrit dans une crontab. Les bibliothèques du domaine y ajoutent
 * les secondes, les années, les fuseaux, `L`, `W`, `#`, des dialectes Quartz —
 * autant de comportements qu'il faudrait documenter et dont aucun n'est
 * demandé.
 *
 * Ensuite et surtout, c'est du code qui **décide quand un serveur redémarre**.
 * Une erreur ici ne se voit pas : elle se manifeste par un redémarrage qui
 * n'arrive pas, ou qui arrive au mauvais moment, des semaines plus tard. Le
 * garder court et entièrement testé vaut mieux que de faire confiance à une
 * dépendance dont on n'exercerait qu'un dixième.
 *
 * Syntaxe reconnue, par champ :
 *
 *   `*`        toutes les valeurs
 *   `5`        une valeur
 *   `1,3,5`    une liste
 *   `1-5`      un intervalle
 *   une etoile suivie de `/15` : un pas, depuis le debut du domaine
 *   `10-30/5`  un pas, sur un intervalle
 */

export class CronError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CronError';
  }
}

export interface CronExpression {
  minute: string;
  hour: string;
  dayOfMonth: string;
  month: string;
  dayOfWeek: string;
}

interface FieldRange {
  readonly min: number;
  readonly max: number;
  readonly label: string;
}

const FIELDS = {
  minute: { min: 0, max: 59, label: 'minute' },
  hour: { min: 0, max: 23, label: 'heure' },
  dayOfMonth: { min: 1, max: 31, label: 'jour du mois' },
  month: { min: 1, max: 12, label: 'mois' },
  dayOfWeek: { min: 0, max: 6, label: 'jour de la semaine' },
} as const satisfies Record<keyof CronExpression, FieldRange>;

/**
 * Développe un champ en l'ensemble des valeurs qu'il désigne.
 *
 * @throws {CronError} sur toute syntaxe non reconnue : mieux vaut refuser à la
 *   création qu'accepter une expression qui ne se déclenchera jamais.
 */
export function parseField(raw: string, field: keyof CronExpression): number[] {
  const range = FIELDS[field];
  const trimmed = raw.trim();

  if (trimmed === '') {
    throw new CronError(`Champ « ${range.label} » vide.`);
  }

  const values = new Set<number>();

  for (const part of trimmed.split(',')) {
    for (const value of parsePart(part.trim(), range)) {
      values.add(value);
    }
  }

  // `7` est accepté pour dimanche, comme dans la plupart des crontabs, et
  // ramené sur `0` — sans quoi il ne correspondrait jamais à `getDay()`.
  if (field === 'dayOfWeek' && values.delete(7)) {
    values.add(0);
  }

  return [...values].sort((left, right) => left - right);
}

function parsePart(part: string, range: FieldRange): number[] {
  const [spec, stepText, ...extra] = part.split('/');

  if (extra.length > 0 || spec === undefined) {
    throw new CronError(`Expression « ${part} » invalide pour le champ ${range.label}.`);
  }

  let step = 1;

  if (stepText !== undefined) {
    step = Number.parseInt(stepText, 10);

    if (!Number.isInteger(step) || step < 1) {
      throw new CronError(`Pas « ${stepText} » invalide pour le champ ${range.label}.`);
    }
  }

  const [from, to] = boundsOf(spec, range, part);
  const values: number[] = [];

  for (let value = from; value <= to; value += step) {
    values.push(value);
  }

  return values;
}

function boundsOf(spec: string, range: FieldRange, part: string): [number, number] {
  if (spec === '*') {
    return [range.min, range.max];
  }

  const [fromText, toText, ...extra] = spec.split('-');

  if (extra.length > 0 || fromText === undefined) {
    throw new CronError(`Expression « ${part} » invalide pour le champ ${range.label}.`);
  }

  const from = toNumber(fromText, range, part);

  // `5/15` sans borne haute explicite parcourt le reste du domaine, comme dans
  // une crontab — et non la seule valeur 5.
  const to =
    toText === undefined ? (part.includes('/') ? range.max : from) : toNumber(toText, range, part);

  if (to < from) {
    throw new CronError(
      `Intervalle « ${part} » décroissant pour le champ ${range.label} : les intervalles qui ` +
        'repassent par zéro ne sont pas gérés, écrivez-en deux séparés par une virgule.',
    );
  }

  return [from, to];
}

function toNumber(text: string, range: FieldRange, part: string): number {
  const value = Number.parseInt(text, 10);

  if (!/^\d+$/.test(text.trim()) || !Number.isInteger(value)) {
    throw new CronError(`« ${text} » n'est pas un nombre (champ ${range.label}).`);
  }

  // Le domaine du jour de la semaine accepte 7, ramené à 0 plus haut.
  const max = range.label === 'jour de la semaine' ? 7 : range.max;

  if (value < range.min || value > max) {
    throw new CronError(
      `« ${value} » hors des bornes ${range.min}–${range.max} du champ ${range.label} ` +
        `(expression « ${part} »).`,
    );
  }

  return value;
}

/** Vérifie une expression entière. Lève au premier champ fautif. */
export function validateCron(expression: CronExpression): void {
  for (const field of Object.keys(FIELDS) as (keyof CronExpression)[]) {
    parseField(expression[field], field);
  }
}

/**
 * Nombre maximal de minutes explorées à la recherche d'une occurrence.
 *
 * Quatre ans et un jour, pour couvrir le 29 février d'une année bissextile.
 * Au-delà, l'expression ne correspond à rien — `0 0 30 2 *`, le 30 février —
 * et il vaut mieux le dire que boucler.
 */
const SEARCH_LIMIT_MINUTES = 4 * 366 * 24 * 60;

/**
 * Prochaine occurrence strictement postérieure à `from`.
 *
 * Avance minute par minute plutôt que de calculer la date directement. C'est
 * plus lent — au pire quelques centaines de milliers d'itérations sur des
 * comparaisons d'entiers, soit quelques millisecondes — mais cela évite toute
 * la combinatoire des mois de longueurs différentes, des années bissextiles et
 * du croisement jour-du-mois / jour-de-semaine. Le calcul n'a lieu qu'une fois
 * par exécution de tâche planifiée.
 *
 * @throws {CronError} si l'expression ne correspond à aucune date atteignable.
 */
export function nextOccurrence(expression: CronExpression, from: Date): Date {
  const minutes = parseField(expression.minute, 'minute');
  const hours = parseField(expression.hour, 'hour');
  const daysOfMonth = parseField(expression.dayOfMonth, 'dayOfMonth');
  const months = parseField(expression.month, 'month');
  const daysOfWeek = parseField(expression.dayOfWeek, 'dayOfWeek');

  // Un jour du mois et un jour de semaine tous deux restreints se combinent en
  // **ou**, et non en **et** : `0 0 1 * 1` se déclenche le 1er du mois *et*
  // chaque lundi. C'est le comportement de cron, contre-intuitif mais celui que
  // toute crontab existante suppose.
  const dayOfMonthRestricted = expression.dayOfMonth.trim() !== '*';
  const dayOfWeekRestricted = expression.dayOfWeek.trim() !== '*';

  const candidate = new Date(from.getTime());
  candidate.setSeconds(0, 0);
  candidate.setMinutes(candidate.getMinutes() + 1);

  for (let step = 0; step < SEARCH_LIMIT_MINUTES; step += 1) {
    const matchesDayOfMonth = daysOfMonth.includes(candidate.getDate());
    const matchesDayOfWeek = daysOfWeek.includes(candidate.getDay());

    const dayMatches =
      dayOfMonthRestricted && dayOfWeekRestricted
        ? matchesDayOfMonth || matchesDayOfWeek
        : matchesDayOfMonth && matchesDayOfWeek;

    if (
      minutes.includes(candidate.getMinutes()) &&
      hours.includes(candidate.getHours()) &&
      months.includes(candidate.getMonth() + 1) &&
      dayMatches
    ) {
      return candidate;
    }

    candidate.setMinutes(candidate.getMinutes() + 1);
  }

  throw new CronError('Cette expression ne correspond à aucune date des quatre prochaines années.');
}

/** Rend l'expression sous sa forme habituelle, pour l'affichage et les journaux. */
export function formatCron(expression: CronExpression): string {
  return [
    expression.minute,
    expression.hour,
    expression.dayOfMonth,
    expression.month,
    expression.dayOfWeek,
  ].join(' ');
}
