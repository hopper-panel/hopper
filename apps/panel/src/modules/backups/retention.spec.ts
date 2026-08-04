import { describe, expect, it } from 'vitest';
import { planRetention, type RetainableBackup } from './retention.js';

function backup(uuid: string, day: number, locked = false): RetainableBackup {
  return { uuid, locked, createdAt: new Date(2026, 7, day) };
}

describe('planRetention', () => {
  it('ne retire rien tant qu’il reste un emplacement', () => {
    const plan = planRetention([backup('a', 1), backup('b', 2)], 3);

    expect(plan).toEqual({ kind: 'ok', remove: [] });
  });

  // Le cas courant, et le plus facile à écrire de travers : avec 3 emplacements
  // et 3 sauvegardes, il faut en retirer **une**, pas zéro. Un `>` au lieu d'un
  // `>=` ferait dépasser la limite d'une unité à chaque cycle.
  it('libère un emplacement quand la limite est atteinte', () => {
    const plan = planRetention([backup('a', 1), backup('b', 2), backup('c', 3)], 3);

    expect(plan.kind).toBe('ok');
    expect(plan.kind === 'ok' && plan.remove.map((entry) => entry.uuid)).toEqual(['a']);
  });

  it('retire la plus ancienne, quel que soit l’ordre reçu', () => {
    const plan = planRetention([backup('recent', 9), backup('ancien', 1), backup('milieu', 5)], 2);

    expect(plan.kind === 'ok' && plan.remove.map((entry) => entry.uuid)).toEqual([
      'ancien',
      'milieu',
    ]);
  });

  it('rattrape un dépassement laissé par une baisse de la limite', () => {
    const existing = [backup('a', 1), backup('b', 2), backup('c', 3), backup('d', 4)];

    const plan = planRetention(existing, 2);

    // Quatre présentes, deux emplacements, une à venir : il faut en retirer trois.
    expect(plan.kind === 'ok' && plan.remove.map((entry) => entry.uuid)).toEqual(['a', 'b', 'c']);
  });

  // Toute la raison d'être du verrou : il tient face à la rétention.
  describe('verrouillage', () => {
    it('épargne une sauvegarde verrouillée et prend la suivante', () => {
      const plan = planRetention([backup('a', 1, true), backup('b', 2), backup('c', 3)], 3);

      expect(plan.kind === 'ok' && plan.remove.map((entry) => entry.uuid)).toEqual(['b']);
    });

    // Un verrou ne libère pas d'emplacement : plutôt que d'effacer en silence
    // ce que l'utilisateur a explicitement protégé, on refuse et on le dit.
    it('refuse quand tous les emplacements sont verrouillés', () => {
      const plan = planRetention([backup('a', 1, true), backup('b', 2, true)], 2);

      expect(plan).toEqual({ kind: 'blocked', lockedCount: 2, limit: 2 });
    });

    it('refuse aussi quand les non verrouillées ne suffisent pas', () => {
      const existing = [backup('a', 1, true), backup('b', 2, true), backup('c', 3)];

      const plan = planRetention(existing, 2);

      // Trois présentes, deux emplacements : il faudrait en retirer deux, or
      // une seule est libre.
      expect(plan.kind).toBe('blocked');
    });
  });

  it('traite une limite nulle comme des sauvegardes désactivées', () => {
    expect(planRetention([], 0).kind).toBe('blocked');
    expect(planRetention([], -1).kind).toBe('blocked');
  });

  it('accepte un serveur sans aucune sauvegarde', () => {
    expect(planRetention([], 1)).toEqual({ kind: 'ok', remove: [] });
  });

  // Une limite de 1 signifie « garder seulement la dernière » : chaque nouvelle
  // sauvegarde remplace la précédente.
  it('remplace la précédente avec une limite de 1', () => {
    const plan = planRetention([backup('a', 1)], 1);

    expect(plan.kind === 'ok' && plan.remove.map((entry) => entry.uuid)).toEqual(['a']);
  });
});
