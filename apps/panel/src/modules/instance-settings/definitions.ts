import { z } from 'zod';

/**
 * Paramètres de l'instance, modifiables depuis l'administration.
 *
 * Trois principes tiennent ce fichier :
 *
 * 1. **Une seule liste.** Clé, type, valeur par défaut et caractère secret sont
 *    déclarés ici, et rien d'autre n'a le droit d'en inventer.
 * 2. **Un défaut pour chacun.** Une instance qui n'a jamais ouvert cet écran
 *    doit fonctionner : la table de paramètres peut être vide.
 * 3. **Ce qui vit dans `.env` n'est pas ici.** L'URL publique, le secret
 *    d'application et l'accès à la base sont lus au démarrage et engagent le
 *    chiffrement de tout le reste : les rendre modifiables par une requête HTTP
 *    ferait dépendre l'intégrité de l'instance d'un formulaire.
 */

export const TWO_FACTOR_REQUIREMENTS = ['none', 'admins', 'all'] as const;
export const MAIL_ENCRYPTIONS = ['none', 'tls', 'starttls'] as const;

/**
 * Champs, **sans valeur par défaut**.
 *
 * Les défauts sont ajoutés plus bas, pour la lecture seulement. C'est
 * volontaire : `z.object({...}).partial()` conserve les `default()` des champs
 * absents et les réinjecte à l'analyse — une modification partielle réécrivait
 * alors tous les autres paramètres avec leur valeur d'origine. Le symptôme :
 * enregistrer le nom de l'instance effaçait la configuration SMTP.
 */
const FIELDS = {
  /** Nom affiché dans l'interface et dans les courriels envoyés. */
  panelName: z.string().min(1).max(60),

  /**
   * Qui doit activer la double authentification.
   *
   * L'exigence n'interdit pas la connexion — il faut être connecté pour
   * activer un second facteur — mais elle barre l'interface tant que ce n'est
   * pas fait.
   */
  twoFactorRequirement: z.enum(TWO_FACTOR_REQUIREMENTS),

  mailEnabled: z.boolean(),
  mailHost: z.string().max(255),
  mailPort: z.number().int().min(1).max(65535),
  mailEncryption: z.enum(MAIL_ENCRYPTIONS),
  mailUsername: z.string().max(255),
  mailPassword: z.string().max(500),
  mailFromAddress: z.string().max(255),
  mailFromName: z.string().max(100),

  /**
   * Délai d'attente des requêtes vers les daemons, en millisecondes.
   *
   * Trop court, un node chargé passe pour mort ; trop long, l'administration
   * met dix secondes à s'afficher quand une machine est réellement tombée.
   */
  nodeTimeoutMs: z.number().int().min(1000).max(60_000),

  /**
   * Rétention du journal d'activité, en jours. 0 conserve tout.
   *
   * Le journal est la mémoire de l'instance : le purger est un choix
   * d'exploitation — place disque contre capacité à enquêter — qui ne doit pas
   * se faire par défaut dans le dos de l'administrateur.
   */
  activityRetentionDays: z.number().int().min(0).max(3650),
} as const;

/** Valeurs par défaut, appliquées à la lecture d'une instance neuve. */
const DEFAULTS = {
  panelName: 'Hopper',
  twoFactorRequirement: 'none',
  mailEnabled: false,
  mailHost: '',
  mailPort: 587,
  mailEncryption: 'starttls',
  mailUsername: '',
  mailPassword: '',
  mailFromAddress: '',
  mailFromName: 'Hopper',
  nodeTimeoutMs: 5000,
  activityRetentionDays: 0,
} as const;

export const instanceSettingsSchema = z.object({
  panelName: FIELDS.panelName.default(DEFAULTS.panelName),
  twoFactorRequirement: FIELDS.twoFactorRequirement.default(DEFAULTS.twoFactorRequirement),
  mailEnabled: FIELDS.mailEnabled.default(DEFAULTS.mailEnabled),
  mailHost: FIELDS.mailHost.default(DEFAULTS.mailHost),
  mailPort: FIELDS.mailPort.default(DEFAULTS.mailPort),
  mailEncryption: FIELDS.mailEncryption.default(DEFAULTS.mailEncryption),
  mailUsername: FIELDS.mailUsername.default(DEFAULTS.mailUsername),
  mailPassword: FIELDS.mailPassword.default(DEFAULTS.mailPassword),
  mailFromAddress: FIELDS.mailFromAddress.default(DEFAULTS.mailFromAddress),
  mailFromName: FIELDS.mailFromName.default(DEFAULTS.mailFromName),
  nodeTimeoutMs: FIELDS.nodeTimeoutMs.default(DEFAULTS.nodeTimeoutMs),
  activityRetentionDays: FIELDS.activityRetentionDays.default(DEFAULTS.activityRetentionDays),
});

export type InstanceSettings = z.infer<typeof instanceSettingsSchema>;

/** Paramètres chiffrés au repos et jamais rendus en clair par l'API. */
export const SECRET_KEYS = ['mailPassword'] as const satisfies readonly (keyof InstanceSettings)[];

export type SecretKey = (typeof SECRET_KEYS)[number];

export function isSecretKey(key: string): key is SecretKey {
  return (SECRET_KEYS as readonly string[]).includes(key);
}

/**
 * Schéma d'écriture : tout est facultatif, et **aucun défaut n'est injecté**.
 *
 * Construit à partir de `FIELDS` et non par `instanceSettingsSchema.partial()`,
 * qui réintroduirait les valeurs par défaut des champs absents.
 */
export const updateInstanceSettingsSchema = z.object({
  panelName: FIELDS.panelName.optional(),
  twoFactorRequirement: FIELDS.twoFactorRequirement.optional(),
  mailEnabled: FIELDS.mailEnabled.optional(),
  mailHost: FIELDS.mailHost.optional(),
  mailPort: FIELDS.mailPort.optional(),
  mailEncryption: FIELDS.mailEncryption.optional(),
  mailUsername: FIELDS.mailUsername.optional(),
  mailPassword: FIELDS.mailPassword.optional(),
  mailFromAddress: FIELDS.mailFromAddress.optional(),
  mailFromName: FIELDS.mailFromName.optional(),
  nodeTimeoutMs: FIELDS.nodeTimeoutMs.optional(),
  activityRetentionDays: FIELDS.activityRetentionDays.optional(),
});

export type UpdateInstanceSettingsDto = z.infer<typeof updateInstanceSettingsSchema>;

export const DEFAULT_SETTINGS: InstanceSettings = instanceSettingsSchema.parse({});

/**
 * Sérialisation vers la table clé/valeur.
 *
 * Tout y est du texte : le typage vit dans le schéma ci-dessus, et une colonne
 * par paramètre imposerait une migration à chaque ajout.
 */
export function serializeSetting(value: unknown): string {
  return typeof value === 'string' ? value : JSON.stringify(value);
}

export function deserializeSetting(key: keyof InstanceSettings, raw: string): unknown {
  const shape = instanceSettingsSchema.shape[key];
  const parsed = shape.safeParse(raw);

  if (parsed.success) {
    return parsed.data;
  }

  // Les nombres et booléens ont été écrits en JSON : on retente après décodage.
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}
