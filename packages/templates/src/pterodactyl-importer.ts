import { z } from 'zod';
import {
  templateDefinitionSchema,
  type DockerImageOption,
  type TemplateDefinition,
  type TemplateVariableDefinition,
} from './definition.js';

/**
 * Converting a Pterodactyl egg into a Hopper template.
 *
 * The point is practical: hundreds of eggs exist, maintained by the community,
 * for games and modpacks Hopper will never ship itself. Redoing them by hand
 * would be absurd.
 *
 * The egg format has varied a great deal. This importer accepts the PTDL_v1 and
 * PTDL_v2 revisions, and tolerates missing fields rather than demand a perfect
 * file: an incomplete egg should produce a usable template an administrator
 * will fix, not an error that sends them back to their editor.
 */

/** Lenient schema: anything not indispensable is optional. */
const eggSchema = z.object({
  _comment: z.string().optional(),
  meta: z.object({ version: z.string().optional() }).optional(),
  name: z.string().min(1),
  author: z.string().optional(),
  description: z.string().optional(),
  uuid: z.string().optional(),

  /** PTDL_v2: object { "Java 21": "image" }. PTDL_v1: array of strings. */
  docker_images: z.union([z.record(z.string(), z.string()), z.array(z.string())]).optional(),
  /** PTDL_v1 : une seule image. */
  image: z.string().optional(),

  startup: z.string().optional(),

  config: z
    .object({
      files: z.union([z.string(), z.record(z.string(), z.unknown())]).optional(),
      startup: z.union([z.string(), z.record(z.string(), z.unknown())]).optional(),
      stop: z.string().optional(),
      logs: z.union([z.string(), z.record(z.string(), z.unknown())]).optional(),
    })
    .optional(),

  scripts: z
    .object({
      installation: z
        .object({
          script: z.string().optional(),
          container: z.string().optional(),
          entrypoint: z.string().optional(),
        })
        .optional(),
    })
    .optional(),

  variables: z
    .array(
      z.object({
        name: z.string().optional(),
        description: z.string().optional(),
        env_variable: z.string().min(1),
        default_value: z.union([z.string(), z.number(), z.boolean(), z.null()]).optional(),
        user_viewable: z.union([z.boolean(), z.number()]).optional(),
        user_editable: z.union([z.boolean(), z.number()]).optional(),
        rules: z.string().optional(),
      }),
    )
    .optional(),
});

export type PterodactylEgg = z.infer<typeof eggSchema>;

export class EggImportError extends Error {
  constructor(
    message: string,
    readonly issues: string[] = [],
  ) {
    super(message);
    this.name = 'EggImportError';
  }
}

export interface EggImportResult {
  template: TemplateDefinition;
  /**
   * Points needing a human read-through.
   *
   * An imported egg is almost never usable as is: the Docker images point at
   * Pterodactyl's own, and exotic stop commands do not always translate.
   * Flagging them beats letting the administrator find the problem on the first
   * start.
   */
  warnings: string[];
}

/** Pterodactyl writes booleans sometimes, 0/1 other times. */
function toBoolean(value: unknown, fallback: boolean): boolean {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  return fallback;
}

/**
 * Normalises the Docker images.
 *
 * A JSON object would lose its order in the database: an array is produced,
 * keeping the egg's declaration order, which reflects its author's intent (the
 * first is the one they recommend).
 */
function convertImages(egg: PterodactylEgg, warnings: string[]): DockerImageOption[] {
  const images: DockerImageOption[] = [];

  if (Array.isArray(egg.docker_images)) {
    egg.docker_images.forEach((image) => images.push({ name: image, image }));
  } else if (egg.docker_images && typeof egg.docker_images === 'object') {
    Object.entries(egg.docker_images).forEach(([name, image]) => images.push({ name, image }));
  }

  if (images.length === 0 && egg.image) {
    images.push({ name: egg.image, image: egg.image });
  }

  if (images.length === 0) {
    throw new EggImportError('This egg declares no Docker image.');
  }

  const foreign = images.filter((option) => !option.image.startsWith('ghcr.io/hopper-panel/'));

  if (foreign.length > 0) {
    warnings.push(
      `This egg's images come from elsewhere (${foreign[0]!.image}). They will work, but they do not benefit from the hardening of Hopper's images: check that they run a non-root user with UID 988.`,
    );
  }

  return images;
}

/**
 * Translates the stop command.
 *
 * Pterodactyl accepts a raw command (`stop`) or a prefixed signal (`^C` for
 * SIGINT in older eggs).
 */
function convertStop(raw: string | undefined, warnings: string[]): string {
  const value = raw?.trim();

  if (!value) {
    warnings.push(
      'No stop command: the server will receive SIGTERM. If the game does not save on that signal, specify its stop command.',
    );
    return 'signal:SIGTERM';
  }

  if (value === '^C' || value.toUpperCase() === 'SIGINT') {
    return 'signal:SIGINT';
  }

  if (value.toUpperCase() === 'SIGTERM') {
    return 'signal:SIGTERM';
  }

  if (value.toUpperCase() === 'SIGKILL') {
    warnings.push(
      'The egg asks for a SIGKILL stop, which cuts the process without saving. A clean stop command is preferable.',
    );
    return 'signal:SIGKILL';
  }

  return `command:${value}`;
}

/** An egg's `config` block is sometimes an object, sometimes a JSON string. */
function parseJsonBlock(raw: unknown): Record<string, unknown> {
  if (raw && typeof raw === 'object') {
    return raw as Record<string, unknown>;
  }

  if (typeof raw === 'string' && raw.trim() !== '') {
    try {
      return JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return {};
    }
  }

  return {};
}

/**
 * Extracts the startup detection line.
 *
 * Pterodactyl stores it as a substring to look for, not as a regular
 * expression. It is therefore escaped before being handed to Hopper, which
 * compiles it: an egg containing `Done (` would otherwise produce an invalid
 * regex, and the server would never go "online".
 */
function convertStartupDetection(raw: unknown, warnings: string[]): string | undefined {
  const block = parseJsonBlock(raw);
  const done = block.done;

  const value = Array.isArray(done)
    ? typeof done[0] === 'string'
      ? done[0]
      : undefined
    : typeof done === 'string'
      ? done
      : undefined;

  if (!value || value.trim() === '') {
    warnings.push(
      'No startup marker: the server will count as "online" as soon as its container runs, without waiting for it to accept connections.',
    );
    return undefined;
  }

  if (Array.isArray(done) && done.length > 1) {
    warnings.push(
      `The egg declares several startup markers; only the first ("${value}") is kept.`,
    );
  }

  return escapeRegExp(value);
}

export function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function convertVariables(egg: PterodactylEgg, warnings: string[]): TemplateVariableDefinition[] {
  const variables: TemplateVariableDefinition[] = [];

  for (const variable of egg.variables ?? []) {
    // A name that does not follow POSIX would fail the `export` in the install
    // script, with a message nobody connects back to the egg.
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(variable.env_variable)) {
      warnings.push(
        `Variable "${variable.env_variable}" ignored: its name is not a valid environment identifier.`,
      );
      continue;
    }

    variables.push({
      name: variable.name ?? variable.env_variable,
      description: variable.description ?? '',
      envVariable: variable.env_variable,
      defaultValue: variable.default_value == null ? '' : String(variable.default_value),
      userViewable: toBoolean(variable.user_viewable, true),
      userEditable: toBoolean(variable.user_editable, false),
      rules: variable.rules ?? 'nullable|string',
    });
  }

  return variables;
}

export interface ImportOptions {
  /** Group the imported template lands in. */
  group: string;
  /** Template key. Derived from the egg's name if absent. */
  key?: string;
}

export function importPterodactylEgg(raw: unknown, options: ImportOptions): EggImportResult {
  const parsed = eggSchema.safeParse(raw);

  if (!parsed.success) {
    throw new EggImportError(
      'This file does not look like a Pterodactyl egg.',
      parsed.error.issues.map(
        (issue) => `${issue.path.join('.') || '(racine)'} : ${issue.message}`,
      ),
    );
  }

  const egg = parsed.data;
  const warnings: string[] = [];

  const version = egg.meta?.version;
  if (version && version !== 'PTDL_v1' && version !== 'PTDL_v2') {
    warnings.push(
      `Unknown egg revision (${version}). The import was attempted, but read the result over.`,
    );
  }

  const installation = egg.scripts?.installation;

  if (!installation?.script || installation.script.trim() === '') {
    throw new EggImportError('This egg contains no install script.');
  }

  if (!egg.startup || egg.startup.trim() === '') {
    throw new EggImportError('This egg declares no startup command.');
  }

  const configFiles = parseJsonBlock(egg.config?.files);
  if (Object.keys(configFiles).length > 0) {
    warnings.push(
      "This egg's configuration files were not carried over: their format differs from Hopper's. Check that the listening port is applied at startup.",
    );
  }

  const template = templateDefinitionSchema.parse({
    key: options.key ?? slugify(egg.name),
    group: options.group,
    name: egg.name,
    description: egg.description ?? '',
    author: egg.author ?? 'Imported from Pterodactyl',
    dockerImages: convertImages(egg, warnings),
    startup: egg.startup.trim(),
    stopCommand: convertStop(egg.config?.stop, warnings),
    startupDetection: convertStartupDetection(egg.config?.startup, warnings),
    configFiles: [],
    fileDenylist: [],
    installContainer: installation.container ?? 'debian:bookworm-slim',
    installEntrypoint: installation.entrypoint ?? '/bin/bash',
    // Pterodactyl monte le volume sur /mnt/server, comme Hopper : les scripts
    // sont directement compatibles.
    installScript: installation.script,
    variables: convertVariables(egg, warnings),
    importedFromEgg: egg.uuid,
  });

  return { template, warnings };
}

/** Transforme « Paper (1.8) » en « paper-1-8 ». */
export function slugify(value: string): string {
  const slug = value
    .normalize('NFD')
    // Strips the diacritics left by the decomposition: "é" becomes "e" rather
    // than being removed entirely.
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);

  // A name made entirely of non-Latin characters — Cyrillic, ideograms — would
  // reduce to an empty string, which the schema refuses. A key is then derived
  // from the name itself: two imports of the same egg have to produce the same
  // key, without which the upsert would create a duplicate every time.
  return slug === '' ? `egg-${fingerprint(value)}` : slug;
}

/** Short, stable digest of a string, in base 36. */
function fingerprint(value: string): string {
  let hash = 2166136261;

  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }

  return (hash >>> 0).toString(36);
}
