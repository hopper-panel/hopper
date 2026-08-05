import { z } from 'zod';

/**
 * Instance settings, editable from the administration.
 *
 * Three principles hold this file together:
 *
 * 1. **One single list.** Key, type, default value and secrecy are declared
 *    here, and nothing else is allowed to invent any.
 * 2. **A default for each.** An instance that never opened this screen has to
 *    work: the settings table may be empty.
 * 3. **What lives in `.env` is not here.** The public URL, the application
 *    secret and the database access are read at startup and underpin the
 *    encryption of everything else: making them editable through an HTTP
 *    request would make the instance's integrity depend on a form.
 */

export const TWO_FACTOR_REQUIREMENTS = ['none', 'admins', 'all'] as const;
export const MAIL_ENCRYPTIONS = ['none', 'tls', 'starttls'] as const;

/** Interface languages. English is the source language; the rest are translations. */
export const LOCALES = ['en', 'fr', 'es', 'de', 'ru'] as const;

/**
 * Fields, **with no default value**.
 *
 * The defaults are added further down, for reading only. That is deliberate:
 * `z.object({...}).partial()` keeps the `default()` of absent fields and
 * reinjects them on parse — a partial update then rewrote every other setting
 * with its original value. The symptom: saving the instance name wiped the SMTP
 * configuration.
 */
const FIELDS = {
  /** Name shown in the interface and in the emails sent out. */
  panelName: z.string().min(1).max(60),

  /**
   * Who has to turn two-factor authentication on.
   *
   * The requirement does not forbid signing in — one has to be signed in to
   * turn a second factor on — but it bars the interface until it is done.
   */
  twoFactorRequirement: z.enum(TWO_FACTOR_REQUIREMENTS),

  /** Language served to visitors who have not picked one themselves. */
  defaultLocale: z.enum(LOCALES),

  mailEnabled: z.boolean(),
  mailHost: z.string().max(255),
  mailPort: z.number().int().min(1).max(65535),
  mailEncryption: z.enum(MAIL_ENCRYPTIONS),
  mailUsername: z.string().max(255),
  mailPassword: z.string().max(500),
  mailFromAddress: z.string().max(255),
  mailFromName: z.string().max(100),

  /**
   * Timeout for requests to the daemons, in milliseconds.
   *
   * Too short and a busy node passes for dead; too long and the administration
   * takes ten seconds to render when a machine really has gone down.
   */
  nodeTimeoutMs: z.number().int().min(1000).max(60_000),

  /**
   * Activity log retention, in days. 0 keeps everything.
   *
   * The log is the instance's memory: purging it is an operational choice —
   * disk space against the ability to investigate — that must not happen by
   * default behind the administrator's back.
   */
  activityRetentionDays: z.number().int().min(0).max(3650),
} as const;

/** Default values, applied when reading a fresh instance. */
const DEFAULTS = {
  panelName: 'Hopper',
  twoFactorRequirement: 'none',
  defaultLocale: 'en',
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
  defaultLocale: FIELDS.defaultLocale.default(DEFAULTS.defaultLocale),
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

/** Settings encrypted at rest and never returned in the clear by the API. */
export const SECRET_KEYS = ['mailPassword'] as const satisfies readonly (keyof InstanceSettings)[];

export type SecretKey = (typeof SECRET_KEYS)[number];

export function isSecretKey(key: string): key is SecretKey {
  return (SECRET_KEYS as readonly string[]).includes(key);
}

/**
 * Write schema: everything is optional, and **no default is injected**.
 *
 * Built from `FIELDS` rather than by `instanceSettingsSchema.partial()`, which
 * would reintroduce the defaults of the absent fields.
 */
export const updateInstanceSettingsSchema = z.object({
  panelName: FIELDS.panelName.optional(),
  twoFactorRequirement: FIELDS.twoFactorRequirement.optional(),
  defaultLocale: FIELDS.defaultLocale.optional(),
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
 * Serialisation into the key/value table.
 *
 * Everything there is text: the typing lives in the schema above, and one
 * column per setting would force a migration on every addition.
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

  // Numbers and booleans were written as JSON: retry after decoding.
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}
