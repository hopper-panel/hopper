/**
 * A backup's exclusion list, in `.gitignore` syntax.
 *
 * The choice is not gratuitous: it is the only exclusion syntax most people
 * already know, and Minecraft server templates circulate with lists written for
 * it. Inventing another would have guaranteed silently ineffective exclusions —
 * the worst possible defect here, since it only shows at restore time.
 *
 * The subset implemented, deliberately narrow:
 *
 *   - `#` at the start of a line: a comment; empty lines ignored;
 *   - `!pattern`: brings back what an earlier rule had excluded;
 *   - `*` does not cross `/`, `**` does;
 *   - `pattern/` targets directories only;
 *   - a pattern without `/` applies at any depth, as in `.gitignore` — `*.log`
 *     also excludes `plugins/x/latest.log`;
 *   - a pattern containing `/` is anchored at the volume root.
 *
 * The last rule that matches wins, which is what makes `!` useful.
 */

import { globToRegExp } from '../fs/jailed-filesystem.js';

interface Rule {
  readonly regex: RegExp;
  readonly negated: boolean;
  readonly directoryOnly: boolean;
}

export class IgnoreList {
  private readonly rules: readonly Rule[];

  constructor(patterns: readonly string[]) {
    this.rules = patterns.map(parsePattern).filter((rule): rule is Rule => rule !== null);
  }

  get isEmpty(): boolean {
    return this.rules.length === 0;
  }

  /**
   * Should the path be kept out of the archive?
   *
   * @param relativePath path relative to the volume root, separated by `/`.
   * @param isDirectory a pattern ending in `/` targets directories only.
   */
  ignores(relativePath: string, isDirectory = false): boolean {
    const normalized = normalizeRelative(relativePath);

    if (normalized === '') {
      return false;
    }

    let ignored = false;

    // No early exit: it is the **last** matching rule that decides, without
    // which `!important.log` placed after `*.log` would have no effect.
    for (const rule of this.rules) {
      if (rule.directoryOnly && !isDirectory) {
        continue;
      }

      if (rule.regex.test(normalized)) {
        ignored = !rule.negated;
      }
    }

    return ignored;
  }

  /**
   * Can a whole directory be skipped without opening it?
   *
   * Descending into `cache/` to keep none of its files costs one system call
   * per entry; on a server holding tens of thousands, that dominates the backup
   * time. It can only be pruned, however, if no re-inclusion rule could pull
   * something back out of its contents.
   */
  canPrune(relativePath: string): boolean {
    return this.ignores(relativePath, true) && !this.rules.some((rule) => rule.negated);
  }
}

function normalizeRelative(path: string): string {
  const normalized = path.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '');

  // The volume root, however it is written. A broad pattern such as `**` must
  // not be able to exclude it: the backup would be empty, and that emptiness
  // would pass for a success.
  return normalized === '.' ? '' : normalized;
}

function parsePattern(raw: string): Rule | null {
  let pattern = raw.trim();

  if (pattern === '' || pattern.startsWith('#')) {
    return null;
  }

  const negated = pattern.startsWith('!');
  if (negated) {
    pattern = pattern.slice(1);
  }

  const directoryOnly = pattern.endsWith('/');
  if (directoryOnly) {
    pattern = pattern.slice(0, -1);
  }

  pattern = pattern.replace(/^\/+/, '');

  if (pattern === '') {
    return null;
  }

  // An anchored pattern only holds at the root; a bare pattern holds at any
  // depth. In both cases the pattern also covers the contents of what it names:
  // excluding `logs` has to exclude `logs/latest.log`, without which the rule
  // would do almost nothing.
  const anchored = raw.trim().replace(/^!/, '').includes('/');
  const prefix = anchored ? '' : '(?:.*/)?';
  const body = globToRegExp(pattern).source.replace(/^\^/, '').replace(/\$$/, '');

  return {
    regex: new RegExp(`^${prefix}${body}(?:/.*)?$`),
    negated,
    directoryOnly,
  };
}

/**
 * Exclusions applied to every backup, whatever the template's own say.
 *
 * These paths are not merely useless: archiving `session.lock` while the server
 * runs produces an archive whose restore makes the world engine believe another
 * instance is already writing there.
 */
export const ALWAYS_IGNORED: readonly string[] = [
  'session.lock',
  '*.jfr',
  'core.*',
  'hs_err_pid*.log',
];
