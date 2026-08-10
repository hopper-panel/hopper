import { parseDocument, type Document } from 'yaml';
import type { ConfigFile, ConfigParser } from '@hopper/shared';
import {
  DeniedFileError,
  PathEscapeError,
  type JailedFilesystem,
} from '../fs/jailed-filesystem.js';

/**
 * Writing the server's own configuration before it starts.
 *
 * A template declares which files hold settings the panel owns — the port,
 * above all — and the daemon rewrites them just before every start. Without
 * this the port is a fiction: Docker publishes the allocated port on both
 * sides, `25570 -> 25570`, while the server inside keeps listening on whatever
 * its own configuration says. A Minecraft server given anything other than
 * 25565 was unreachable, and the panel showed its address as if it were not.
 *
 * Every read and every write goes through the jail, so a template naming
 * `../../etc/cron.d/anything` is refused by the same code that refuses it to a
 * user. A template is written by an administrator, but "written by someone
 * trusted" is not a reason to hand it a path the rest of the daemon would not
 * accept — and an imported Pterodactyl egg is written by a stranger.
 *
 * A missing file is created, but only for `properties`. Minecraft writes
 * `server.properties` itself on its first run, so on a brand-new server there
 * was nothing to rewrite: the very first start bound the default port, and the
 * port only became right on the second one. That reads to an operator exactly
 * like the bug this file exists to fix — nobody restarts a server that has
 * just started. A flat key-value file is safe to write from nothing, because
 * the server fills in every key it does not find. A YAML or a JSON invented
 * from scratch is a different proposition and is still skipped.
 *
 * Beyond that, rewriting is deliberate about what it does **not** do. A file
 * that cannot be parsed is left exactly as it is, and said so on the console —
 * an operator who broke their own YAML gets an error, not a silently
 * reformatted file with their comments gone.
 */

export interface ConfigWriteReport {
  file: string;
  /** How many replacements actually changed something. */
  changed: number;
  /** Why nothing was written, when nothing was. */
  skipped?: string;
  /** The file did not exist and was written from the template's keys alone. */
  created?: boolean;
}

/**
 * A parser this file has no rewriter for, as opposed to a file it could not
 * read.
 *
 * The two used to arrive at the operator as one sentence — `unreadable (the
 * xml parser is not implemented)` — and that word is an accusation aimed at
 * the wrong thing. Their file is fine. What is missing is on this side, and
 * only one of the two failures is theirs to fix.
 */
class UnwrittenParserError extends Error {}

/**
 * What the operator reads when a template names a parser nothing writes.
 *
 * Built from the parser's own name and exported, so the spec can assert the
 * equivalence that keeps `PARSERS_NOT_WRITTEN` honest: a parser is on that
 * list exactly when this file refuses it. Written out on both sides, the two
 * drift the first time somebody implements a rewriter and forgets the list —
 * and the panel would go on refusing a parser that works.
 *
 * The second half is not padding. A refusal here is not a failed start:
 * `applyOne` catches it, `writeConfigFiles` never rethrows, and the server
 * comes up on whatever port the file already held. This sentence is the only
 * warning anyone gets.
 */
export function unwrittenParserMessage(parser: ConfigParser): string {
  return `Hopper has no ${parser} rewriter, so this file is left exactly as it is — including whatever this template meant to write into it, the port most likely among them.`;
}

/** Substitutes `{{variables}}`; the daemon passes `invocation.ts`'s own. */
export type Substitute = (input: string) => string;

export async function applyConfigFiles(
  jail: JailedFilesystem,
  files: readonly ConfigFile[],
  substitute: Substitute,
): Promise<ConfigWriteReport[]> {
  const reports: ConfigWriteReport[] = [];

  for (const file of files) {
    reports.push(await applyOne(jail, file, substitute));
  }

  return reports;
}

async function applyOne(
  jail: JailedFilesystem,
  config: ConfigFile,
  substitute: Substitute,
): Promise<ConfigWriteReport> {
  // The jail resolves and validates; a path leading outside throws here,
  // before a byte is read.
  const absolute = await jail.absolutePathFor(config.file);

  const replacements = config.replacements.map((replacement) => ({
    match: replacement.match,
    ifValue: replacement.ifValue,
    replaceWith: substitute(replacement.replaceWith),
  }));

  let original: string;

  try {
    original = await readThroughJail(jail, absolute);
  } catch (error: unknown) {
    // A refusal is not an absence. The jail throws here when the name has grown
    // a symlink — which the server, whose volume this is, can arrange at any
    // moment — and treating that as "no file yet" would send the flow into
    // `createMissing`, writing the template's keys over whatever the link
    // points at. Everything else keeps meaning what it meant: a start on a
    // brand-new server finds no `server.properties` and has to carry on.
    if (error instanceof PathEscapeError || error instanceof DeniedFileError) {
      throw error;
    }

    return createMissing(jail, config, replacements);
  }

  let result: { text: string; changed: number };

  try {
    result = rewrite(config.parser, original, replacements);
  } catch (error: unknown) {
    // Reported as it was written, with no word of this daemon's added to it:
    // the sentence is the whole of what the operator gets, and `unreadable`
    // in front of it would send them to inspect a file that is not the
    // problem. See `UnwrittenParserError`.
    if (error instanceof UnwrittenParserError) {
      return { file: config.file, changed: 0, skipped: error.message };
    }

    return {
      file: config.file,
      changed: 0,
      skipped: `unreadable (${error instanceof Error ? error.message : String(error)})`,
    };
  }

  if (result.changed === 0 || result.text === original) {
    return { file: config.file, changed: 0 };
  }

  await jail.writeFile(config.file, result.text);

  return { file: config.file, changed: result.changed };
}

/**
 * The file's text, read through a descriptor the jail has vetted.
 *
 * `readFile(absolute)` looks the name up a second time, after the jail has
 * finished saying what it means, and the daemon does this as root at every
 * start — a moment the server's owner knows in advance. They leave a genuine
 * `server.properties` for the resolution to approve, put a link to a host file
 * in its place for the read, then restore the real file before the write lands:
 * the daemon then copies the host file, patched, into a volume they can browse.
 * Reading from the descriptor the jail opened leaves no name to swap.
 */
async function readThroughJail(jail: JailedFilesystem, absolutePath: string): Promise<string> {
  const handle = await jail.openForRead(absolutePath);

  try {
    return await handle.readFile('utf8');
  } finally {
    await handle.close().catch(() => undefined);
  }
}

/**
 * The current value as text, or null when it is not a scalar.
 *
 * A replacement writes a string, so a `match` that lands on a map or a list is
 * a template pointing at the wrong node. Comparing it via `String()` would
 * produce `[object Object]`, which equals nothing and silently overwrites the
 * whole subtree with a port number.
 */
function asScalar(value: unknown): string | null {
  if (value === null || value === undefined) {
    return '';
  }

  // Enumerated rather than negated: a function or a symbol reaching here is
  // also a template pointing somewhere it should not, and neither has a
  // sensible text form.
  if (typeof value === 'string') {
    return value;
  }

  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    return String(value);
  }

  return null;
}

/**
 * Writes the declared keys into a file the server has not created yet.
 *
 * Only for `properties`. The game writes every key it does not find on its
 * first run, so a file holding nothing but the port is complete enough to
 * start from — and the alternative is a first start on the wrong port.
 *
 * A replacement carrying `ifValue` is left out: it asks to change a value that
 * is a certain thing, and a file that does not exist holds no value at all.
 */
async function createMissing(
  jail: JailedFilesystem,
  config: ConfigFile,
  replacements: readonly Replacement[],
): Promise<ConfigWriteReport> {
  if (config.parser !== 'properties') {
    // A YAML or a JSON invented from nothing would be a structure the server
    // never agreed to. The install script owns those.
    return { file: config.file, changed: 0, skipped: 'file not present' };
  }

  const lines = replacements
    .filter((replacement) => replacement.ifValue === undefined)
    .map((replacement) => `${replacement.match}=${replacement.replaceWith}`);

  if (lines.length === 0) {
    return { file: config.file, changed: 0, skipped: 'file not present' };
  }

  await jail.writeFile(config.file, `${lines.join('\n')}\n`);

  return { file: config.file, changed: lines.length, created: true };
}

interface Replacement {
  match: string;
  ifValue?: string;
  replaceWith: string;
}

function rewrite(
  parser: ConfigParser,
  original: string,
  replacements: readonly Replacement[],
): { text: string; changed: number } {
  switch (parser) {
    case 'properties':
    case 'ini':
      return rewriteLines(original, replacements, ['=']);
    case 'file':
      // Not a whole-file overwrite, whatever the name suggests: the shipped
      // Velocity template declares `parser: 'file'` with `match: 'bind'`, and
      // overwriting velocity.toml with the word `0.0.0.0:25577` would delete
      // everything else the operator configured.
      //
      // **Not Pterodactyl's `file` parser either.** Theirs replaces the whole
      // line, and that is `whole-line` below — a second name rather than a
      // reinterpretation of this one, which is what the comment here used to
      // say was needed and is now what happened.
      return rewriteLines(original, replacements, ['=', ':']);
    case 'whole-line':
      return rewriteWholeLines(original, replacements);
    case 'json':
      return rewriteJson(original, replacements);
    case 'yaml':
      return rewriteYaml(original, replacements);
    case 'xml':
      // Refused out loud rather than done badly. No shipped template uses it —
      // `catalog.spec.ts` holds that — and a regex over XML is how a
      // configuration file gets corrupted.
      //
      // **What follows is not a failed start**, which three places in this
      // repository used to say and one of them was this file's own message.
      // The throw is caught by `applyOne`, the report comes back `skipped`,
      // and `writeConfigFiles` is never fatal: the server starts. It starts on
      // the port its file already named, which is the template author's and
      // not the one the panel allocated — so the sentence has to name that,
      // because it is the only warning anybody gets.
      throw new UnwrittenParserError(unwrittenParserMessage('xml'));
  }
}

/**
 * Key-on-a-line formats: `server.properties`, INI, TOML.
 *
 * Only the value is touched. The key's own spacing, the delimiter, any
 * surrounding quotes and every other line — comments included — survive
 * untouched, because an operator who opens this file afterwards should not
 * find it rearranged.
 */
function rewriteLines(
  original: string,
  replacements: readonly Replacement[],
  delimiters: readonly string[],
): { text: string; changed: number } {
  const lines = original.split('\n');
  let changed = 0;

  for (const replacement of replacements) {
    const escaped = replacement.match.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const pattern = new RegExp(
      `^(\\s*${escaped}\\s*[${delimiters.map((d) => `\\${d}`).join('')}]\\s*)(.*)$`,
    );

    for (const [index, line] of lines.entries()) {
      const found = pattern.exec(line);

      if (!found) {
        continue;
      }

      const prefix = found[1]!;
      const current = found[2]!;

      // A quoted value stays quoted. TOML and YAML both need it, and the
      // replacement carries an address, not a quoting convention.
      const quote = /^(["']).*\1\s*$/.exec(current.trim())?.[1] ?? '';
      const bare = quote ? current.trim().slice(1, -1) : current.trim();

      if (replacement.ifValue !== undefined && bare !== replacement.ifValue) {
        continue;
      }

      if (bare === replacement.replaceWith) {
        break;
      }

      lines[index] = `${prefix}${quote}${replacement.replaceWith}${quote}`;
      changed += 1;
      break;
    }
  }

  return { text: lines.join('\n'), changed };
}

/**
 * Pterodactyl's `file` parser: find a line by its opening text, replace all of
 * it.
 *
 * Deliberately not `rewriteLines` with a different delimiter set. That one
 * looks for a key *followed by* a delimiter and keeps everything up to it —
 * two properties this parser must not have. 75 of the corpus's matches carry
 * the `=` themselves (`'#port ='`), which its pattern cannot match at all, and
 * keeping a prefix is precisely what produces `DISCORD_TOKEN=DISCORD_TOKEN=…`
 * out of an egg that repeats its key.
 *
 * Because the whole line goes, a replacement here can do things no value
 * rewrite expresses, and the corpus relies on all three: **uncomment** a line
 * (`'#port ='` → `'port = 5432'`), **delete** one (replace with the empty
 * string), or change the key's own spelling. That is why an egg's `file`
 * entries are not merely untranslatable into `file` — they are doing something
 * else.
 *
 * **Leading whitespace is matched over and then discarded**, which is the one
 * asymmetry worth stating. An indented line is found, and what replaces it is
 * `replaceWith` exactly, so its indentation is whatever the replacement
 * carries. Preserving it would be the kinder guess and it would be a guess: a
 * replacement that deletes a line would leave the indentation of the line it
 * deleted.
 *
 * **A replacement that uncomments does not fire twice.** Once `#port = 5432`
 * has become `port = 5570`, the match `'#port ='` finds nothing, so a later
 * change of port leaves that line alone. Inherited, not invented — Pterodactyl
 * behaves the same way, which is what the egg's author tested against. Making
 * it cleverer here (also matching the uncommented form) would rewrite lines
 * that egg never intended this replacement to reach.
 */
function rewriteWholeLines(
  original: string,
  replacements: readonly Replacement[],
): { text: string; changed: number } {
  const lines = original.split('\n');
  let changed = 0;

  for (const replacement of replacements) {
    for (const [index, line] of lines.entries()) {
      // Anchored at the start, past any indentation. `includes` would reach a
      // match sitting inside a value, and a match of `DISCORD_TOKEN` would
      // then eat the commented-out `# DISCORD_TOKEN=…` above it — or the
      // comment explaining what the setting does.
      if (!line.trimStart().startsWith(replacement.match)) {
        continue;
      }

      // The whole line is the value here, so the whole line is what a
      // condition can be about. Trimmed, because the condition is written by
      // whoever wrote the template and the indentation belongs to the file.
      if (replacement.ifValue !== undefined && line.trim() !== replacement.ifValue) {
        continue;
      }

      if (line === replacement.replaceWith) {
        break;
      }

      lines[index] = replacement.replaceWith;
      changed += 1;
      break;
    }
  }

  return { text: lines.join('\n'), changed };
}

function rewriteJson(
  original: string,
  replacements: readonly Replacement[],
): { text: string; changed: number } {
  const document = JSON.parse(original) as unknown;
  let changed = 0;

  for (const replacement of replacements) {
    if (setAtPath(document, parsePath(replacement.match), replacement)) {
      changed += 1;
    }
  }

  return { text: `${JSON.stringify(document, null, 2)}\n`, changed };
}

/**
 * YAML through its own document model, so comments and formatting survive.
 *
 * `parseDocument` keeps the original tokens; re-serialising a plain object
 * would hand the operator back a file with every comment and every deliberate
 * blank line removed.
 */
function rewriteYaml(
  original: string,
  replacements: readonly Replacement[],
): { text: string; changed: number } {
  const document: Document = parseDocument(original);

  if (document.errors.length > 0) {
    throw new Error(document.errors[0]!.message);
  }

  let changed = 0;

  for (const replacement of replacements) {
    const path = parsePath(replacement.match);
    const current = asScalar(document.getIn(path));

    // A path that lands on a map or a list is a template naming the wrong
    // node; overwriting it would delete everything under it.
    if (current === null) {
      continue;
    }

    if (replacement.ifValue !== undefined && current !== replacement.ifValue) {
      continue;
    }

    if (current === replacement.replaceWith) {
      continue;
    }

    document.setIn(path, replacement.replaceWith);
    changed += 1;
  }

  return { text: document.toString(), changed };
}

/**
 * `listeners[0].host` and `settings.bungeecord` both reach their value.
 *
 * BungeeCord's shipped template needs the indexed form; without it the proxy
 * would be rewritten at a key called literally `listeners[0]`.
 */
export function parsePath(match: string): (string | number)[] {
  const path: (string | number)[] = [];

  for (const segment of match.split('.')) {
    const bracket = /^([^[\]]*)((?:\[\d+\])+)$/.exec(segment);

    if (!bracket) {
      path.push(segment);
      continue;
    }

    const key = bracket[1] ?? '';

    if (key !== '') {
      path.push(key);
    }

    for (const index of (bracket[2] ?? '').matchAll(/\[(\d+)\]/g)) {
      path.push(Number(index[1]));
    }
  }

  return path;
}

function setAtPath(root: unknown, path: (string | number)[], replacement: Replacement): boolean {
  let node = root;

  for (const segment of path.slice(0, -1)) {
    if (node === null || typeof node !== 'object') {
      return false;
    }

    node = (node as Record<string | number, unknown>)[segment];
  }

  const last = path.at(-1);

  if (last === undefined || node === null || typeof node !== 'object') {
    return false;
  }

  const container = node as Record<string | number, unknown>;
  const current = asScalar(container[last]);

  if (current === null) {
    return false;
  }

  if (replacement.ifValue !== undefined && current !== replacement.ifValue) {
    return false;
  }

  if (current === replacement.replaceWith) {
    return false;
  }

  container[last] = replacement.replaceWith;

  return true;
}
