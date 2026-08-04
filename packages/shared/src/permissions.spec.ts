import { describe, expect, it } from 'vitest';
import {
  ALL_PERMISSIONS,
  DANGEROUS_PERMISSIONS,
  PERMISSION_GROUPS,
  PERMISSIONS,
  isPermission,
  permissionSchema,
  sanitizePermissions,
} from './permissions.js';

describe('permissions', () => {
  it('expose des valeurs uniques', () => {
    expect(new Set(ALL_PERMISSIONS).size).toBe(ALL_PERMISSIONS.length);
  });

  it('respecte le format <domaine>.<action>', () => {
    for (const permission of ALL_PERMISSIONS) {
      expect(permission).toMatch(/^[a-z]+\.[a-z-]+$/);
    }
  });

  it('valide via le schéma Zod dérivé', () => {
    for (const permission of ALL_PERMISSIONS) {
      expect(permissionSchema.safeParse(permission).success).toBe(true);
    }
    expect(permissionSchema.safeParse('file.chmod').success).toBe(false);
  });

  // Une permission oubliée dans PERMISSION_GROUPS serait invisible dans
  // l'interface : impossible à accorder, et surtout impossible à retirer.
  it('classe toute permission dans un groupe affichable', () => {
    const grouped = new Set(Object.values(PERMISSION_GROUPS).flatMap((g) => g.permissions));
    const ungrouped = ALL_PERMISSIONS.filter(
      (p) => p !== PERMISSIONS.WEBSOCKET_CONNECT && !grouped.has(p),
    );
    expect(ungrouped).toEqual([]);
  });

  it('ne référence que des permissions existantes dans la liste des dangereuses', () => {
    for (const permission of DANGEROUS_PERMISSIONS) {
      expect(isPermission(permission)).toBe(true);
    }
  });
});

describe('sanitizePermissions', () => {
  it('conserve les permissions connues', () => {
    expect(sanitizePermissions([PERMISSIONS.CONTROL_START, PERMISSIONS.FILE_READ])).toEqual([
      PERMISSIONS.CONTROL_START,
      PERMISSIONS.FILE_READ,
    ]);
  });

  // Une permission retirée du code dans une version ultérieure reste en base :
  // le chargement du sous-utilisateur doit continuer à fonctionner.
  it('écarte silencieusement une permission inconnue', () => {
    expect(sanitizePermissions(['control.start', 'legacy.permission', 'file.read'])).toEqual([
      'control.start',
      'file.read',
    ]);
  });

  it("n'accorde rien à partir d'une liste vide", () => {
    expect(sanitizePermissions([])).toEqual([]);
  });
});
