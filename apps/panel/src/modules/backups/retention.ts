/**
 * Politique de rétention des sauvegardes.
 *
 * Isolée du service pour être vérifiable : c'est la seule partie du module qui
 * **détruit des données**, et une erreur ici efface la sauvegarde que
 * l'utilisateur croyait garder. Elle ne touche ni à la base ni au réseau, elle
 * décide seulement — ce qui la rend testable exhaustivement.
 */

export interface RetainableBackup {
  uuid: string;
  locked: boolean;
  createdAt: Date;
}

export type RetentionPlan =
  | { kind: 'ok'; remove: RetainableBackup[] }
  | { kind: 'blocked'; lockedCount: number; limit: number };

/**
 * Décide quelles sauvegardes retirer pour faire place à une nouvelle.
 *
 * Le verrouillage prime sur l'ancienneté : c'est toute sa raison d'être. Mais
 * une sauvegarde verrouillée occupe bien un emplacement — un serveur dont tous
 * les emplacements sont verrouillés ne peut plus en créer, et il vaut mieux le
 * dire que d'effacer un verrou en silence.
 *
 * @param existing sauvegardes déjà enregistrées, ordre indifférent.
 * @param limit nombre d'emplacements ; 0 ou moins désactive les sauvegardes.
 */
export function planRetention(existing: readonly RetainableBackup[], limit: number): RetentionPlan {
  if (limit <= 0) {
    return { kind: 'blocked', lockedCount: 0, limit };
  }

  // Il faut de la place pour **une de plus** : avec 3 emplacements et 3
  // sauvegardes, il faut en retirer une, pas zéro.
  const surplus = existing.length - limit + 1;

  if (surplus <= 0) {
    return { kind: 'ok', remove: [] };
  }

  const removable = [...existing]
    .filter((backup) => !backup.locked)
    .sort((left, right) => left.createdAt.getTime() - right.createdAt.getTime());

  if (removable.length < surplus) {
    return {
      kind: 'blocked',
      lockedCount: existing.length - removable.length,
      limit,
    };
  }

  return { kind: 'ok', remove: removable.slice(0, surplus) };
}
