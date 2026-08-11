import type { INestApplicationContext } from '@nestjs/common';
import {
  DEFAULT_SETTINGS,
  isSecretKey,
  updateInstanceSettingsSchema,
  type InstanceSettings,
} from '../../modules/instance-settings/definitions.js';
import { InstanceSettingsService } from '../../modules/instance-settings/instance-settings.service.js';
import { textOf, type Flags } from '../flags.js';
import { bold, dim, fatal, line } from '../output.js';

/**
 * Reading and writing the instance settings from a shell.
 *
 * Exists for the installer, which now asks what language the panel should
 * speak and what it should call itself. Both were already settings, editable
 * from the administration and defaulted in code — and therefore reachable only
 * by somebody who had already signed in, in English, to a panel called Hopper.
 *
 * Everything goes through `InstanceSettingsService`, so a value written here
 * lands validated, encrypted where it must be, and cached the same way the API
 * would have written it. The running panel keeps its own cache, though: a
 * change made while it is up is visible after it restarts, which the installer
 * does anyway.
 */

const KEYS = Object.keys(DEFAULT_SETTINGS) as (keyof InstanceSettings)[];

export async function settingsSet(context: INestApplicationContext, flags: Flags): Promise<void> {
  const settings = context.get(InstanceSettingsService);

  const key = textOf(flags, 'key');
  const value = textOf(flags, 'value');

  if (key === undefined || value === undefined) {
    fatal(`Missing --key or --value.\n  Known keys: ${KEYS.join(', ')}`);
  }

  if (!KEYS.includes(key as keyof InstanceSettings)) {
    // Named rather than merely refused: the caller is usually a script, and
    // "unknown setting" without the list is a trip to the source code.
    fatal(`Unknown setting: ${key}\n  Known keys: ${KEYS.join(', ')}`);
  }

  // Everything arrives as text from a shell. The schema knows which keys are
  // numbers and which are booleans; this is the one place that has to turn
  // `--value 5000` into 5000 rather than "5000", which would be refused.
  const parsed = updateInstanceSettingsSchema.safeParse({ [key]: coerce(key, value) });

  if (!parsed.success) {
    const details = parsed.error.issues
      .map((issue) => `${issue.path.join('.') || 'value'}: ${issue.message}`)
      .join('\n  ');

    fatal(`Invalid value for ${key}.\n  ${details}`);
  }

  await settings.update(parsed.data);

  line(`\n${bold('Setting saved')} — ${key} = ${isSecretKey(key) ? '••••••' : value}`);
  line(dim('  The panel reads its settings once: restart it to serve the new value.'));
}

export async function settingsList(context: INestApplicationContext): Promise<void> {
  const current = await context.get(InstanceSettingsService).all();

  line();

  for (const key of KEYS) {
    // A secret is never printed, even to root at a terminal: this output ends
    // up in installation logs and in pasted bug reports.
    const value = isSecretKey(key) ? (current[key] === '' ? '' : '••••••') : String(current[key]);

    line(`  ${key.padEnd(24)} ${value}`);
  }

  line();
}

/** Text from a shell into the type the schema expects. */
function coerce(key: string, value: string): unknown {
  const shape = updateInstanceSettingsSchema.shape[key as keyof InstanceSettings];
  const direct = shape.safeParse(value);

  if (direct.success) {
    return value;
  }

  if (value === 'true' || value === 'false') {
    return value === 'true';
  }

  const asNumber = Number(value);

  return Number.isFinite(asNumber) && value.trim() !== '' ? asNumber : value;
}
