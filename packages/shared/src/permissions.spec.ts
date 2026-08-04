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
  it('exposes unique values', () => {
    expect(new Set(ALL_PERMISSIONS).size).toBe(ALL_PERMISSIONS.length);
  });

  it('follows the <domain>.<action> format', () => {
    for (const permission of ALL_PERMISSIONS) {
      expect(permission).toMatch(/^[a-z]+\.[a-z-]+$/);
    }
  });

  it('validates through the derived Zod schema', () => {
    for (const permission of ALL_PERMISSIONS) {
      expect(permissionSchema.safeParse(permission).success).toBe(true);
    }
    expect(permissionSchema.safeParse('file.chmod').success).toBe(false);
  });

  // A permission forgotten in PERMISSION_GROUPS would be invisible in the
  // interface: impossible to grant, and above all impossible to revoke.
  it('places every permission in a displayable group', () => {
    const grouped = new Set(Object.values(PERMISSION_GROUPS).flatMap((g) => g.permissions));
    const ungrouped = ALL_PERMISSIONS.filter(
      (p) => p !== PERMISSIONS.WEBSOCKET_CONNECT && !grouped.has(p),
    );
    expect(ungrouped).toEqual([]);
  });

  it('references only existing permissions in the dangerous list', () => {
    for (const permission of DANGEROUS_PERMISSIONS) {
      expect(isPermission(permission)).toBe(true);
    }
  });
});

describe('sanitizePermissions', () => {
  it('keeps the known permissions', () => {
    expect(sanitizePermissions([PERMISSIONS.CONTROL_START, PERMISSIONS.FILE_READ])).toEqual([
      PERMISSIONS.CONTROL_START,
      PERMISSIONS.FILE_READ,
    ]);
  });

  // A permission removed from the code in a later version stays in the
  // database: loading the subuser has to keep working.
  it('silently drops an unknown permission', () => {
    expect(sanitizePermissions(['control.start', 'legacy.permission', 'file.read'])).toEqual([
      'control.start',
      'file.read',
    ]);
  });

  it('grants nothing from an empty list', () => {
    expect(sanitizePermissions([])).toEqual([]);
  });
});
