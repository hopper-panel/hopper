import { describe, expect, it } from 'vitest';
import { ALWAYS_IGNORED, IgnoreList } from './ignore.js';

describe('IgnoreList', () => {
  it('excludes nothing without a pattern', () => {
    const list = new IgnoreList([]);

    expect(list.isEmpty).toBe(true);
    expect(list.ignores('world/level.dat')).toBe(false);
  });

  it('ignores comments and empty lines', () => {
    const list = new IgnoreList(['# les journaux', '', '   ', '*.log']);

    expect(list.ignores('latest.log')).toBe(true);
    expect(list.ignores('server.properties')).toBe(false);
  });

  // `.gitignore` behaviour: a pattern without a slash holds at any depth. That
  // is what makes `*.log` useful — a Minecraft server's logs are scattered
  // through the plugin directories.
  describe('unanchored pattern', () => {
    it('applies at any depth', () => {
      const list = new IgnoreList(['*.log']);

      expect(list.ignores('latest.log')).toBe(true);
      expect(list.ignores('logs/2026-08-03.log')).toBe(true);
      expect(list.ignores('plugins/CoreProtect/debug.log')).toBe(true);
    });

    it('also excludes the contents of what it names', () => {
      const list = new IgnoreList(['cache']);

      expect(list.ignores('cache', true)).toBe(true);
      expect(list.ignores('cache/mojang.json')).toBe(true);
      expect(list.ignores('plugins/cache/x.dat')).toBe(true);
    });
  });

  describe('anchored pattern', () => {
    it('holds at the root only', () => {
      const list = new IgnoreList(['/logs']);

      expect(list.ignores('logs/latest.log')).toBe(true);
      expect(list.ignores('plugins/logs/latest.log')).toBe(false);
    });

    // A slash in the middle anchors too, as in `.gitignore`.
    it('is anchored as soon as it contains a slash', () => {
      const list = new IgnoreList(['plugins/*/data']);

      expect(list.ignores('plugins/Essentials/data')).toBe(true);
      expect(list.ignores('x/plugins/Essentials/data')).toBe(false);
    });
  });

  describe('wildcard', () => {
    it('*, one segment only', () => {
      const list = new IgnoreList(['plugins/*.jar']);

      expect(list.ignores('plugins/Essentials.jar')).toBe(true);
      expect(list.ignores('plugins/sub/Essentials.jar')).toBe(false);
    });

    it('**, several segments', () => {
      const list = new IgnoreList(['plugins/**/*.jar']);

      expect(list.ignores('plugins/sub/Essentials.jar')).toBe(true);
      expect(list.ignores('plugins/a/b/c/Essentials.jar')).toBe(true);
    });
  });

  it('targets directories only with a trailing slash', () => {
    const list = new IgnoreList(['cache/']);

    expect(list.ignores('cache', true)).toBe(true);
    // A *file* named "cache" is not what the rule was aiming at.
    expect(list.ignores('cache', false)).toBe(false);
  });

  // The reason `!` exists: it is the last matching rule that decides. A walk
  // stopping at the first match would make negation useless — and the user
  // would lose a file they believed they had saved.
  describe('negation', () => {
    it('brings back what an earlier rule excluded', () => {
      const list = new IgnoreList(['*.log', '!important.log']);

      expect(list.ignores('debug.log')).toBe(true);
      expect(list.ignores('important.log')).toBe(false);
    });

    it('order matters', () => {
      const list = new IgnoreList(['!important.log', '*.log']);

      expect(list.ignores('important.log')).toBe(true);
    });
  });

  // A backslash-separated path must not escape the rules: the archive is
  // produced on Linux, but the tests also run on Windows and one day somebody
  // will pass a native path.
  it('normalises the separators', () => {
    const list = new IgnoreList(['logs/*.log']);

    expect(list.ignores('logs\\latest.log')).toBe(true);
    expect(list.ignores('./logs/latest.log')).toBe(true);
  });

  it('never claims to exclude the root', () => {
    const list = new IgnoreList(['**']);

    expect(list.ignores('')).toBe(false);
    expect(list.ignores('.')).toBe(false);
  });

  describe('canPrune', () => {
    // Descending into a directory nothing will come out of costs one system
    // call per entry; on a server holding tens of thousands, that is most of
    // the backup time.
    it('allows skipping a wholly excluded directory', () => {
      expect(new IgnoreList(['cache/']).canPrune('cache')).toBe(true);
    });

    // But as soon as a rule could bring something back, the directory has to
    // be opened: pruning would make an explicitly saved file vanish.
    it('forbids pruning when a negation is present', () => {
      const list = new IgnoreList(['cache/', '!cache/garder.dat']);

      expect(list.ignores('cache', true)).toBe(true);
      expect(list.canPrune('cache')).toBe(false);
    });
  });
});

describe('ALWAYS_IGNORED', () => {
  // A restored `session.lock` makes the world engine believe another instance
  // is already writing to it: the server then refuses to start, on an error
  // that does not mention the backup.
  it('drops the session lock and the JVM dumps', () => {
    const list = new IgnoreList(ALWAYS_IGNORED);

    expect(list.ignores('world/session.lock')).toBe(true);
    expect(list.ignores('hs_err_pid1234.log')).toBe(true);
    expect(list.ignores('core.4242')).toBe(true);
    expect(list.ignores('world/level.dat')).toBe(false);
  });
});
