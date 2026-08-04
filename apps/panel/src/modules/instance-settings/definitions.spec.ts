import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SETTINGS,
  deserializeSetting,
  instanceSettingsSchema,
  isSecretKey,
  serializeSetting,
  updateInstanceSettingsSchema,
} from './definitions.js';

describe('updateInstanceSettingsSchema', () => {
  it('returns only what was sent', () => {
    // The trap that cost an SMTP configuration: `.partial()` on a schema whose
    // fields carry a `.default()` reinjects those defaults for the absent keys.
    // Saving the instance name alone then rewrote the SMTP server with an empty
    // string.
    const parsed = updateInstanceSettingsSchema.parse({ panelName: 'Kronia' });

    expect(Object.keys(parsed)).toEqual(['panelName']);
    expect(parsed).not.toHaveProperty('mailHost');
    expect(parsed).not.toHaveProperty('mailEnabled');
  });

  it('accepte une modification vide', () => {
    expect(updateInstanceSettingsSchema.parse({})).toEqual({});
  });

  it('valide ce qu’elle accepte', () => {
    expect(updateInstanceSettingsSchema.safeParse({ panelName: '' }).success).toBe(false);
    expect(updateInstanceSettingsSchema.safeParse({ mailPort: 70_000 }).success).toBe(false);
    expect(updateInstanceSettingsSchema.safeParse({ twoFactorRequirement: 'parfois' }).success).toBe(
      false,
    );
    // A one-millisecond timeout would make every node look dead.
    expect(updateInstanceSettingsSchema.safeParse({ nodeTimeoutMs: 1 }).success).toBe(false);
  });

  it('drops the unknown keys', () => {
    expect(updateInstanceSettingsSchema.parse({ appSecret: 'x' })).toEqual({});
  });
});

describe('instanceSettingsSchema', () => {
  it('remplit une instance neuve', () => {
    expect(DEFAULT_SETTINGS.panelName).toBe('Hopper');
    expect(DEFAULT_SETTINGS.mailEnabled).toBe(false);
    expect(DEFAULT_SETTINGS.nodeTimeoutMs).toBe(5000);
    // Zero: purging the audit log has to stay an explicit choice.
    expect(DEFAULT_SETTINGS.activityRetentionDays).toBe(0);
  });

  it('fills in the missing values', () => {
    expect(instanceSettingsSchema.parse({ panelName: 'Kronia' })).toEqual({
      ...DEFAULT_SETTINGS,
      panelName: 'Kronia',
    });
  });
});

describe('serialisation', () => {
  it('round-trips for every type', () => {
    expect(deserializeSetting('panelName', serializeSetting('Kronia'))).toBe('Kronia');
    expect(deserializeSetting('mailEnabled', serializeSetting(true))).toBe(true);
    expect(deserializeSetting('mailEnabled', serializeSetting(false))).toBe(false);
    expect(deserializeSetting('mailPort', serializeSetting(2525))).toBe(2525);
    expect(deserializeSetting('twoFactorRequirement', serializeSetting('admins'))).toBe('admins');
  });

  it('rend undefined sur une valeur illisible', () => {
    // A corrupt row has to be ignored, not fail the reading of every other
    // setting.
    expect(deserializeSetting('mailPort', 'pas un nombre')).toBeUndefined();
  });
});

describe('isSecretKey', () => {
  it('names the SMTP password only', () => {
    expect(isSecretKey('mailPassword')).toBe(true);
    expect(isSecretKey('mailUsername')).toBe(false);
    expect(isSecretKey('panelName')).toBe(false);
  });
});
