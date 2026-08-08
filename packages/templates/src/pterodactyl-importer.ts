import type { ConfigFile, ConfigParser, readinessSchema } from '@hopper/shared';
import { z } from 'zod';
import {
  JAVA_IMAGES,
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
  /** PTDL_v1: a single image. */
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
 * Image repositories Hopper ships itself, tag excluded.
 *
 * `JAVA_IMAGES` is the whole of it today, because the shipped catalogue is
 * still entirely Java. A second list added for another game has to be added
 * here too, or eggs naming its images will be flagged as bringing something
 * Hopper does not recognise. Reading it off the constant rather than spelling
 * the repository name out at least means a new tag or a new JRE never needs a
 * change in this file.
 *
 * The tag is dropped deliberately: `eclipse-temurin:8-jre-noble` and
 * `eclipse-temurin:21-jre-noble` are the same answer to the only question asked
 * below, which is whether Hopper has any idea what is inside the image.
 */
const CATALOGUE_REPOSITORIES = new Set(JAVA_IMAGES.map((option) => option.image.split(':')[0]!));

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

  // Hopper imposes the user, the capabilities and PID 1 on the container
  // itself, so an image from elsewhere is not less safe for being foreign. What
  // it can lack is what the server needs at runtime — and that question has no
  // single answer any more. A Java server wants a JRE of the right major
  // version; a Steam game wants the loader and the shared libraries its binary
  // was linked against. The importer cannot tell which it is looking at, so the
  // warning names the image and stops there. The previous wording asked the
  // reader to check the Java version, which fired on every egg that was not
  // Minecraft and told each of them to verify something irrelevant — advice
  // nobody can act on is how a warnings list stops being read at all.
  const unrecognised = images.filter(
    (option) => !CATALOGUE_REPOSITORIES.has(option.image.split(':')[0]!),
  );

  if (unrecognised.length > 0) {
    warnings.push(
      `This egg names images of its own (${unrecognised[0]!.image}). They will work — Hopper sets the user, drops every capability and supplies PID 1 regardless of the image — but nothing here checks that the image carries what this particular game needs to run, nor the tools its startup relies on if it downloads anything.`,
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

/**
 * Pterodactyl's parser names, against Hopper's.
 *
 * Four of them are the same vocabulary with a spelling in it: `yml` and `yaml`
 * are both written in the wild and mean the same file. Two are missing, and
 * each absence is a decision {@link convertConfigFiles} explains — `xml`
 * because the daemon's rewriter throws on it, and `file` because the two
 * projects mean different things by the name.
 */
const CONFIG_PARSERS: Record<string, ConfigParser> = {
  properties: 'properties',
  yaml: 'yaml',
  yml: 'yaml',
  json: 'json',
  ini: 'ini',
};

/**
 * Pterodactyl's variable spellings, against Hopper's.
 *
 * Inside a configuration file an egg writes an environment variable three
 * ways — `{{server.build.env.SERVER_PORT}}`, `{{env.SERVER_PORT}}`, and in a
 * few eggs the bare name. The daemon knows the bare one, and knows
 * `server.build.default.{ip,port}` and `server.build.memory` besides, because
 * those aliases were added for exactly these imports. What it has never seen is
 * the two prefixes, so they are stripped here rather than taught to the
 * substituter: they mean "an environment variable" and Hopper's environment
 * variables are named without a prefix.
 *
 * Measured over the 274 eggs in the public corpus: 523 uses of the first
 * spelling, 90 of the second, 147 of the `server.build.default.*` aliases the
 * daemon already answers.
 */
const ENVIRONMENT_PREFIX = /\{\{\s*(?:server\.build\.)?env\.([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g;

/**
 * The one namespace that cannot be carried over.
 *
 * `{{config.docker.interface}}` is the address of Pterodactyl's own Docker
 * bridge, read out of that daemon's configuration file. Hopper has no such
 * value to offer and inventing one would be worse than admitting it: four eggs
 * in the corpus use it, all of them a proxy rewriting `127.0.0.1` in a server
 * list, and every one of them would rather keep the address already in the file
 * than have it replaced by nothing.
 */
const UNRESOLVABLE_NAMESPACE = /\{\{\s*config\./;

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
 * The `config.files` block, which used to be thrown away with a warning.
 *
 * This is where an egg says how the allocated port reaches the game. Measured
 * over the 274 eggs in the public corpus: **159 declare configuration files,
 * and in 115 of them a file is the only place the port is written** — their
 * startup command names no port at all, because there is nothing to name. So an
 * import that dropped this block produced a template whose server listened on
 * whatever port its last operator had typed into a file, on a panel that had
 * just allocated it a different one. The warning said "check that the listening
 * port is applied at startup", which is a fair description of a problem and no
 * help at all in fixing it.
 *
 * The formats turn out to be the same idea twice over — a file, a parser, and a
 * set of matches with what to write — so most of this function is spelling. The
 * parts that are not:
 *
 *  - **A value can be an object**, and it is Pterodactyl's conditional form:
 *    `{"127.0.0.1": "…", "localhost": "…"}` means *replace this key's value
 *    only where it currently reads `127.0.0.1`, and separately where it reads
 *    `localhost`*. That is exactly Hopper's `ifValue`, one replacement per
 *    entry, so the object expands rather than being refused.
 *  - **A value can be a bare `true` or `0`.** JSON keeps the type; the
 *    replacement is text either way.
 *  - **`xml` is refused**, per file, loudly. The daemon's rewriter throws on
 *    it, and a template carrying one would import cleanly and then fail on the
 *    first start of the first server built from it. Seven eggs in the corpus.
 *  - **`file` is refused too, and this one is not obvious**, because both
 *    projects have a parser by that name and they do not mean the same thing.
 *    Hopper's rewrites *the value* on a matching line and keeps the key, the
 *    delimiter and the spacing — that is what the Velocity template asks of it.
 *    Pterodactyl's matches a line by prefix and replaces **the whole line**, so
 *    an egg writes `"DISCORD_TOKEN": "DISCORD_TOKEN={{env.discord_token}}"` and
 *    the value carries the key. Carried across unchanged that is not a no-op,
 *    it is corruption: Hopper would keep its own prefix and write
 *    `DISCORD_TOKEN=DISCORD_TOKEN=…`. Measured over the corpus, **255 of the
 *    265 `file` replacements have a value that repeats its key**, and 75 name a
 *    match already carrying the `=`, which Hopper's pattern cannot match at
 *    all. A parser with Pterodactyl's semantics is worth adding — 27 templates
 *    write their port this way — and it is a contract change rather than an
 *    importer one, so it is not smuggled in here.
 *
 * What is *not* attempted: nothing here reads the file the egg is describing,
 * so a `match` that names a key the game does not have is carried over as
 * written. That is the same contract Hopper's own templates work under.
 */
function convertConfigFiles(raw: unknown, warnings: string[]): ConfigFile[] {
  const block = parseJsonBlock(raw);
  const files: ConfigFile[] = [];
  const skippedFiles: string[] = [];
  const skippedKeys: string[] = [];
  let sameNameDifferentParser = false;

  for (const [file, rawSpec] of Object.entries(block)) {
    if (!rawSpec || typeof rawSpec !== 'object') {
      skippedFiles.push(file);
      continue;
    }

    const spec = rawSpec as { parser?: unknown; find?: unknown };
    const declared = typeof spec.parser === 'string' ? spec.parser.toLowerCase() : '';
    const parser: ConfigParser | undefined = CONFIG_PARSERS[declared];

    if (!parser) {
      // Named with its parser, because an operator can act on this: the file is
      // real and the replacements are readable, they just have to be redone by
      // hand in a format the daemon writes.
      skippedFiles.push(declared === '' ? file : `${file} (${declared})`);

      if (declared === 'file') {
        sameNameDifferentParser = true;
      }

      continue;
    }

    const find = spec.find;
    const replacements: ConfigFile['replacements'] = [];

    if (find && typeof find === 'object') {
      for (const [match, value] of Object.entries(find as Record<string, unknown>)) {
        if (value && typeof value === 'object' && !Array.isArray(value)) {
          for (const [ifValue, conditional] of Object.entries(value as Record<string, unknown>)) {
            const replaceWith = convertConfigValue(conditional);

            if (replaceWith === undefined) {
              skippedKeys.push(`${file}: ${match}`);
              continue;
            }

            replacements.push({ match, ifValue, replaceWith });
          }

          continue;
        }

        const replaceWith = convertConfigValue(value);

        if (replaceWith === undefined) {
          skippedKeys.push(`${file}: ${match}`);
          continue;
        }

        replacements.push({ match, replaceWith });
      }
    }

    // A file with nothing left to write is not carried: the daemon would open
    // it, rewrite it byte for byte and report having done something.
    if (replacements.length > 0) {
      files.push({ file, parser, replacements });
    }
  }

  if (skippedFiles.length > 0) {
    warnings.push(
      `These configuration files were not carried over, and Hopper writes nothing into them: ${skippedFiles.join(', ')}. If one of them is where this game reads its port, the servers created from this template will listen on the wrong one until it is edited by hand.`,
    );
  }

  if (sameNameDifferentParser) {
    // Said separately because it is the one refusal an administrator would
    // otherwise read as a bug: Hopper has a `file` parser, so why is a `file`
    // one refused? Because the two projects mean different things by the name,
    // and doing it anyway writes the key twice.
    warnings.push(
      "Hopper has a `file` parser of its own and it is not this one: it rewrites the value on a matching line and keeps the key, where Pterodactyl's replaces the whole line — which is why those eggs write the key into the value. Carrying them across unchanged would write it twice.",
    );
  }

  if (skippedKeys.length > 0) {
    warnings.push(
      `These replacements name a value Hopper cannot supply and were left out, so what the file already holds stays: ${skippedKeys.join(', ')}. Pterodactyl's {{config.*}} reads its own daemon's configuration, which Hopper has no equivalent of.`,
    );
  }

  return files;
}

/**
 * One replacement's value, or `undefined` for one that must not be written.
 *
 * The refusal is the point. An unresolvable variable is not an error to the
 * daemon's rewriter — it substitutes an empty string, says so on the console
 * and carries on, which is the right call for a stale key in
 * `server.properties` and the wrong one here: the four eggs that reach this
 * case are proxies rewriting an address, and blanking an address is worse for
 * the operator than leaving the one already in the file.
 */
function convertConfigValue(value: unknown): string | undefined {
  if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') {
    return undefined;
  }

  const text = String(value).replace(ENVIRONMENT_PREFIX, '{{$1}}');

  return UNRESOLVABLE_NAMESPACE.test(text) ? undefined : text;
}

/** What an egg's `done` markers become on the template. */
interface ConvertedReadiness {
  /**
   * The deprecated single pattern, still filled in.
   *
   * A node running a daemon older than the readiness union reads this field and
   * nothing else. An import that stopped emitting it would leave every one of
   * those nodes with a server stuck in "starting", which is precisely the
   * lockstep upgrade the contract was written to avoid.
   */
  startupDetection: string | undefined;
  /**
   * The strategy as this function writes it, before the schema has run.
   *
   * `z.input` and not `Readiness`: the latter is what comes *out* of the
   * schema, with `protocol` and `delayMs` already filled in from their
   * defaults, and this importer has an opinion on neither.
   *
   * It has no opinion on `timeoutMs` either, and that omission is the
   * deliberate part. An egg says nothing whatever about deadlines, and a
   * deadline is what makes a start capable of failing: inventing one here
   * would hand every egg ever imported a stop its author never asked for, on a
   * workload nothing in this file has seen. So the strategy travels without
   * one and the import keeps the open-ended wait it has always had. An
   * administrator who wants the server given up on after so long adds the
   * field to the template by hand, which is the one place the figure can be
   * chosen by somebody who knows the game.
   */
  readiness: z.input<typeof readinessSchema>;
}

/**
 * Extracts what the egg says about becoming ready.
 *
 * Pterodactyl stores markers as substrings to look for, not as regular
 * expressions. They are escaped before being handed to Hopper, which compiles
 * them: an egg containing `Done (` would otherwise produce an invalid regex,
 * and the server would never go "online".
 *
 * Both fields come out of the same markers and both are emitted. The `log`
 * strategy carries every marker the egg declares; `startupDetection` carries
 * the first of them, because one string is all it can hold. That truncation is
 * the whole reason `log.patterns` is a list: eggs for games outside Minecraft
 * routinely declare several, either because the announcing line changed between
 * builds or because the game reaches "ready" through more than one path, and
 * the importer used to keep one of them and warn that it had discarded the
 * rest. A discarded marker is a server that never leaves "starting" whenever
 * the build in question happens to print the other line.
 */
function convertReadiness(raw: unknown, warnings: string[]): ConvertedReadiness {
  const block = parseJsonBlock(raw);
  const done = block.done;

  // A single string in older eggs, a list in newer ones. Blank entries are
  // dropped rather than escaped: an empty pattern compiles to a regex matching
  // every line, so keeping one would mean the first thing the server printed —
  // a copyright banner, a deprecation notice — counted as "ready".
  const markers = (Array.isArray(done) ? done : [done]).filter(
    (marker): marker is string => typeof marker === 'string' && marker.trim() !== '',
  );

  if (markers.length === 0) {
    // Chosen rather than fallen into. The daemon already treats an absent
    // strategy this way, so nothing changes about when the server is called
    // running; what changes is that the template now says so. An operator
    // looking at a server that went green before it had loaded anything can
    // read `immediate` and know it was decided at import, instead of hunting
    // for the console pattern that was never there.
    warnings.push(
      'This egg declares no startup marker, so the template asks for the "immediate" strategy: the server counts as running as soon as its container does, without waiting for it to accept connections. If the game announces itself on the console, add the pattern to the template by hand.',
    );

    return { startupDetection: undefined, readiness: { type: 'immediate' } };
  }

  const patterns = markers.map(escapeRegExp);

  // The first marker, which is the one this importer has always picked. Keeping
  // that choice matters beyond tidiness: an egg re-imported today has to leave
  // an old node behaving exactly as the same egg did before this field existed.
  return { startupDetection: patterns[0]!, readiness: { type: 'log', patterns } };
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

  const configFiles = convertConfigFiles(egg.config?.files, warnings);
  const dockerImages = convertImages(egg, warnings);
  const stopCommand = convertStop(egg.config?.stop, warnings);
  // Two fields out of one read of the egg, so it cannot be called inline like
  // its neighbours. It stays in their order all the same, because the warnings
  // an administrator reads are in the order they were pushed.
  const { startupDetection, readiness } = convertReadiness(egg.config?.startup, warnings);

  const template = templateDefinitionSchema.parse({
    key: options.key ?? slugify(egg.name),
    group: options.group,
    name: egg.name,
    description: egg.description ?? '',
    author: egg.author ?? 'Imported from Pterodactyl',
    dockerImages,
    startup: egg.startup.trim(),
    stopCommand,
    startupDetection,
    readiness,
    configFiles,
    fileDenylist: [],
    installContainer: installation.container ?? 'debian:bookworm-slim',
    installEntrypoint: installation.entrypoint ?? '/bin/bash',
    // Pterodactyl mounts the volume on /mnt/server, as Hopper does: the
    // scripts are directly compatible.
    installScript: installation.script,
    variables: convertVariables(egg, warnings),
    importedFromEgg: egg.uuid,
  });

  return { template, warnings };
}

/** Turns "Paper (1.8)" into "paper-1-8". */
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
