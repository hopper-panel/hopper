import { describe, expect, it } from 'vitest';
import { MAX_ALLOCATIONS_PER_REQUEST, expandPortRanges } from './nodes.dto.js';

describe('expandPortRanges', () => {
  it('accepte un port isolé', () => {
    expect(expandPortRanges(['25565'])).toEqual([25565]);
  });

  it('développe une plage', () => {
    expect(expandPortRanges(['25565-25568'])).toEqual([25565, 25566, 25567, 25568]);
  });

  it('combine plusieurs entrées et trie le résultat', () => {
    expect(expandPortRanges(['25570', '25565-25566'])).toEqual([25565, 25566, 25570]);
  });

  // Recouvrir deux plages est un geste courant quand on étend un node.
  it('déduplique les ports présents dans plusieurs plages', () => {
    expect(expandPortRanges(['25565-25567', '25566-25568'])).toEqual([25565, 25566, 25567, 25568]);
  });

  it('accepte une plage d’un seul port', () => {
    expect(expandPortRanges(['25565-25565'])).toEqual([25565]);
  });

  it.each([
    ['port zéro', '0'],
    ['port au-delà de 65535', '65536'],
    ['borne haute hors plage', '25565-70000'],
  ])('refuse un port hors plage : %s', (_label, entry) => {
    expect(() => expandPortRanges([entry])).toThrow(/hors plage/);
  });

  it('refuse une plage inversée', () => {
    expect(() => expandPortRanges(['25570-25565'])).toThrow(/inversée/);
  });

  // Sans cette borne, `1-65535` insérerait 65 000 lignes et bloquerait la base
  // plusieurs secondes — accessible à tout administrateur par simple faute de
  // frappe.
  it('refuse une plage plus large que la limite', () => {
    expect(() => expandPortRanges([`1-${MAX_ALLOCATIONS_PER_REQUEST + 1}`])).toThrow(/dépasse/);
  });

  it('refuse un total cumulé au-dessus de la limite', () => {
    const half = MAX_ALLOCATIONS_PER_REQUEST / 2;
    expect(() => expandPortRanges([`1000-${1000 + half}`, `20000-${20000 + half}`])).toThrow(
      /maximum/,
    );
  });

  it('accepte exactement la limite', () => {
    expect(expandPortRanges([`1000-${1000 + MAX_ALLOCATIONS_PER_REQUEST - 1}`])).toHaveLength(
      MAX_ALLOCATIONS_PER_REQUEST,
    );
  });
});
