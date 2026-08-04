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
  it('ne rend que ce qui a été envoyé', () => {
    // Le piège qui a coûté une configuration SMTP : `.partial()` sur un schéma
    // dont les champs portent un `.default()` réinjecte ces défauts pour les
    // clés absentes. Enregistrer le seul nom de l'instance réécrivait alors le
    // serveur SMTP avec une chaîne vide.
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
    // Un délai d'une milliseconde ferait passer tous les nodes pour morts.
    expect(updateInstanceSettingsSchema.safeParse({ nodeTimeoutMs: 1 }).success).toBe(false);
  });

  it('écarte les clés inconnues', () => {
    expect(updateInstanceSettingsSchema.parse({ appSecret: 'x' })).toEqual({});
  });
});

describe('instanceSettingsSchema', () => {
  it('remplit une instance neuve', () => {
    expect(DEFAULT_SETTINGS.panelName).toBe('Hopper');
    expect(DEFAULT_SETTINGS.mailEnabled).toBe(false);
    expect(DEFAULT_SETTINGS.nodeTimeoutMs).toBe(5000);
    // Zéro : purger le journal d'audit doit rester un choix explicite.
    expect(DEFAULT_SETTINGS.activityRetentionDays).toBe(0);
  });

  it('complète les valeurs manquantes', () => {
    expect(instanceSettingsSchema.parse({ panelName: 'Kronia' })).toEqual({
      ...DEFAULT_SETTINGS,
      panelName: 'Kronia',
    });
  });
});

describe('sérialisation', () => {
  it('fait l’aller-retour pour chaque type', () => {
    expect(deserializeSetting('panelName', serializeSetting('Kronia'))).toBe('Kronia');
    expect(deserializeSetting('mailEnabled', serializeSetting(true))).toBe(true);
    expect(deserializeSetting('mailEnabled', serializeSetting(false))).toBe(false);
    expect(deserializeSetting('mailPort', serializeSetting(2525))).toBe(2525);
    expect(deserializeSetting('twoFactorRequirement', serializeSetting('admins'))).toBe('admins');
  });

  it('rend undefined sur une valeur illisible', () => {
    // Une ligne corrompue doit être ignorée, pas faire échouer la lecture de
    // tous les autres paramètres.
    expect(deserializeSetting('mailPort', 'pas un nombre')).toBeUndefined();
  });
});

describe('isSecretKey', () => {
  it('ne désigne que le mot de passe SMTP', () => {
    expect(isSecretKey('mailPassword')).toBe(true);
    expect(isSecretKey('mailUsername')).toBe(false);
    expect(isSecretKey('panelName')).toBe(false);
  });
});
