import type { ConfigFile, Readiness, StopConfiguration } from '@hopper/shared';
import type { TemplateDefinition } from './definition.js';

/**
 * Turning a Hopper template back into a Pterodactyl egg.
 *
 * The mirror of `pterodactyl-importer.ts`, and it exists for the reason the
 * importer does, pointed the other way: an operator who has spent an afternoon
 * getting a template right should be able to hand it to somebody, or to their
 * own second installation, without either of them opening a database.
 *
 * Two audiences, and they want different things from the same file.
 *
 *  - **Another Hopper.** It wants the template back exactly as it was. Nothing
 *    less will do: a stop that loses its RCON password variable comes back as a
 *    SIGTERM through the save it was chosen to protect.
 *  - **Pterodactyl, or a panel that reads its format.** It wants a valid
 *    PTDL_v2 egg, and it has no field for half of what a Hopper template says.
 *
 * So the file is a real egg with a `hopper` block beside it. Every field that
 * translates is translated, in the shape the format actually uses — measured
 * against the 274 eggs of the public corpus rather than guessed at, which is
 * how the string-not-object question below got answered. Every field the egg
 * format cannot hold is in the block, and the importer reads the block first,
 * so a Hopper → file → Hopper round trip changes nothing. A panel that has
 * never heard of the block ignores an unknown key and gets the egg.
 */

/**
 * The revision of the `hopper` block this version writes and understands.
 *
 * Bumped only when a reader would get something *wrong* by treating a new file
 * as an old one — not when a field is added, because an unknown field is
 * already ignored and the template simply arrives without it. A file whose
 * block is newer than this is read as far as it goes, with a warning saying so.
 */
export const HOPPER_BLOCK_VERSION = 1;

export interface PterodactylEggExport {
  _comment: string;
  meta: { version: 'PTDL_v2'; update_url: null };
  exported_at: string;
  /**
   * The egg this template was imported from, when it was imported from one.
   *
   * Provenance travels with the file rather than being reset by the trip
   * through it: `importedFromEgg` is what the panel shows for "this came from
   * somewhere else", and an export that dropped it would launder an imported
   * egg into something that looked hand-written. Absent on a template Hopper's
   * own catalogue installed or an administrator typed, because there is no egg
   * to name and inventing a uuid would be the same laundering backwards.
   */
  uuid?: string;
  name: string;
  author: string;
  description: string;
  /**
   * Pterodactyl's own feature flags — `eula`, `java_version`, `steam_disk_space`.
   * Hopper has no equivalent and does not invent one: 150 of the 274 eggs in
   * the corpus write `null` here.
   */
  features: null;
  docker_images: Record<string, string>;
  file_denylist: string[];
  startup: string;
  /**
   * Three JSON documents, each carried as a **string**.
   *
   * Not an object, which is what it looks like it should be and what a first
   * draft of this file emitted. All 274 eggs in the corpus write all three as
   * strings, and Pterodactyl's own importer casts them; an object here is read
   * by some tooling and not by others. Hopper's importer accepts either, so
   * this choice costs nothing on the way back and is the difference between a
   * file another panel takes and one it argues with.
   */
  config: { files: string; startup: string; logs: string; stop: string };
  scripts: { installation: { script: string; container: string; entrypoint: string } };
  variables: PterodactylEggVariable[];
  /** Everything an egg has no field for. Ignored by any panel but this one. */
  hopper: HopperEggBlock;
}

export interface PterodactylEggVariable {
  name: string;
  description: string;
  env_variable: string;
  default_value: string;
  user_viewable: boolean;
  user_editable: boolean;
  rules: string;
  /** Pterodactyl 1.x. Present on 1840 of the corpus's 1855 variables. */
  field_type: 'text';
}

/**
 * What an egg cannot say.
 *
 * Deliberately an **overlay** and not a second copy of the template. Every
 * field here is one the egg format has no place for, so the importer can apply
 * the block on top of what it read from the egg and the two never disagree
 * about the same value. Duplicating the whole template would be simpler to
 * write and would introduce the one bug this shape cannot have: a file whose
 * egg half and Hopper half say different things, with nothing to say which is
 * right.
 *
 * `stopCommand` is not here, and its absence is the test of the rule:
 * `command:stop` ↔ `stop` and `signal:SIGINT` ↔ `^C` round-trip through
 * `config.stop` exactly, so putting it in the block would be storing it twice.
 *
 * `group` is here and is deliberately **not** read back: where an imported
 * template lands is the choice of whoever is importing it, made in the
 * interface at the time. It travels as a note about where the file came from.
 */
export interface HopperEggBlock {
  /**
   * The block's own revision, so a file written today can be read by a Hopper
   * that has learnt more fields since. Bumped only when a reader would get
   * something wrong by treating a new file as an old one.
   */
  version: 1;
  key: string;
  group: string;
  /** Exact, as a regular expression — `config.startup.done` holds a substring. */
  startupDetection?: string;
  readiness?: Readiness;
  stop?: StopConfiguration;
  stopTimeoutSeconds?: number;
  /** Exact, including the parsers `config.files` cannot carry. */
  configFiles: ConfigFile[];
  installInactivityTimeoutMs?: number;
  installRequiredDiskBytes?: number;
}

/**
 * The parsers both projects mean the same thing by.
 *
 * The inverse of the importer's map, and short for the same two reasons.
 * `xml` is in Hopper's contract and the daemon has no rewriter for it, so
 * exporting one would hand another panel a configuration file Hopper itself
 * leaves untouched — a template that looks portable and is not.
 * `file` is worse than untranslatable, it is *silently different*: Hopper's
 * rewrites the value on a matching line and Pterodactyl's replaces the whole
 * line, so a Hopper template exported with its `file` entries intact would
 * have Pterodactyl write `server-port` where the value belongs. Both stay out
 * of `config.files`; both are exact in `hopper.configFiles`.
 */
const EXPORTABLE_PARSERS = new Set(['properties', 'yaml', 'json', 'ini']);

export interface ExportOptions {
  /**
   * Passed in rather than read off the clock, because a pure function that
   * calls `Date.now()` cannot be compared against its own output in a test —
   * and comparing an export against its own re-import is the whole of how this
   * file is checked.
   */
  exportedAt: string;
}

export function exportPterodactylEgg(
  template: TemplateDefinition,
  options: ExportOptions,
): PterodactylEggExport {
  return {
    _comment:
      'Exported from Hopper. The "hopper" block carries what the egg format has no field for; any other panel ignores it.',
    meta: { version: 'PTDL_v2', update_url: null },
    exported_at: options.exportedAt,
    ...(template.importedFromEgg === undefined ? {} : { uuid: template.importedFromEgg }),
    name: template.name,
    author: template.author,
    description: template.description,
    features: null,
    docker_images: dockerImagesOf(template),
    file_denylist: [...template.fileDenylist],
    startup: template.startup,
    config: {
      files: JSON.stringify(configFilesOf(template.configFiles), null, 4),
      startup: JSON.stringify({ done: doneMarkersOf(template) }, null, 4),
      // Pterodactyl's log location block. Hopper reads a container's stdout and
      // has nothing to point at, and 266 of the corpus's 274 eggs write exactly
      // this.
      logs: '{}',
      stop: stopOf(template.stopCommand),
    },
    scripts: {
      installation: {
        script: template.installScript,
        container: template.installContainer,
        entrypoint: template.installEntrypoint,
      },
    },
    variables: template.variables.map((variable) => ({
      name: variable.name,
      description: variable.description,
      env_variable: variable.envVariable,
      default_value: variable.defaultValue,
      user_viewable: variable.userViewable,
      user_editable: variable.userEditable,
      rules: variable.rules,
      field_type: 'text',
    })),
    hopper: {
      version: 1,
      key: template.key,
      group: template.group,
      ...(template.startupDetection === undefined
        ? {}
        : { startupDetection: template.startupDetection }),
      ...(template.readiness === undefined ? {} : { readiness: template.readiness }),
      ...(template.stop === undefined ? {} : { stop: template.stop }),
      ...(template.stopTimeoutSeconds === undefined
        ? {}
        : { stopTimeoutSeconds: template.stopTimeoutSeconds }),
      configFiles: template.configFiles,
      ...(template.installInactivityTimeoutMs === undefined
        ? {}
        : { installInactivityTimeoutMs: template.installInactivityTimeoutMs }),
      ...(template.installRequiredDiskBytes === undefined
        ? {}
        : { installRequiredDiskBytes: template.installRequiredDiskBytes }),
    },
  };
}

/**
 * An ordered list into an object, which loses the order.
 *
 * That loss is the format's and not this function's: `docker_images` is a JSON
 * object, and the importer reads its entries back in declaration order because
 * every JSON parser in use preserves insertion order for string keys. The one
 * thing worth guarding is a duplicate label — two images named "latest" would
 * silently become one, and the template would come back with fewer images than
 * it left with.
 */
function dockerImagesOf(template: TemplateDefinition): Record<string, string> {
  const images: Record<string, string> = {};

  for (const option of template.dockerImages) {
    const label = option.name in images ? `${option.name} (${option.image})` : option.name;
    images[label] = option.image;
  }

  return images;
}

function configFilesOf(files: readonly ConfigFile[]): Record<string, unknown> {
  const block: Record<string, unknown> = {};

  for (const file of files) {
    if (!EXPORTABLE_PARSERS.has(file.parser)) {
      continue;
    }

    const find: Record<string, unknown> = {};

    for (const replacement of file.replacements) {
      // Pterodactyl's conditional form, which is what the importer expands into
      // one `ifValue` replacement per entry. Written back the same way, so an
      // egg that arrived conditional leaves conditional.
      if (replacement.ifValue === undefined) {
        find[replacement.match] = replacement.replaceWith;
        continue;
      }

      const existing = find[replacement.match];
      const conditions = existing && typeof existing === 'object' ? existing : {};

      find[replacement.match] = {
        ...(conditions as Record<string, unknown>),
        [replacement.ifValue]: replacement.replaceWith,
      };
    }

    block[file.file] = { parser: file.parser, find };
  }

  return block;
}

/**
 * The markers, as substrings.
 *
 * Pterodactyl looks for `done` in a line; Hopper compiles a regular expression.
 * The importer escapes on the way in, so this unescapes on the way out and the
 * common case round-trips exactly. A pattern that uses real regular-expression
 * syntax — one an administrator wrote by hand rather than one that arrived from
 * an egg — cannot be expressed as a substring at all, and is written as it
 * stands: another panel gets a marker that is wrong in a visible way, this one
 * reads `hopper.readiness` and never sees it.
 */
function doneMarkersOf(template: TemplateDefinition): string | string[] {
  const patterns =
    template.readiness?.type === 'log'
      ? template.readiness.patterns
      : template.startupDetection === undefined
        ? []
        : [template.startupDetection];

  // An egg whose `done` is empty is one whose servers never leave "starting" on
  // a panel that has no other strategy to fall back on. The template says the
  // server is ready when its container is, and the nearest thing the format has
  // to that is a marker matching the first thing anything prints.
  const markers = patterns.length === 0 ? [''] : patterns.map(unescapeRegExp);

  // 267 of the corpus's 274 eggs write a bare string and 7 write a list; both
  // are read back. One marker is written the way the overwhelming majority of
  // the format's own files write it.
  return markers.length === 1 ? markers[0]! : markers;
}

/** The inverse of the importer's `escapeRegExp`, over exactly the set it escapes. */
export function unescapeRegExp(pattern: string): string {
  return pattern.replace(/\\([.*+?^${}()|[\]\\])/g, '$1');
}

/** `command:stop` back to `stop`, `signal:SIGINT` back to the caret Pterodactyl writes. */
function stopOf(stopCommand: string): string {
  if (stopCommand.startsWith('command:')) {
    return stopCommand.slice('command:'.length);
  }

  if (stopCommand === 'signal:SIGINT') {
    return '^C';
  }

  if (stopCommand.startsWith('signal:')) {
    return stopCommand.slice('signal:'.length);
  }

  return stopCommand;
}
