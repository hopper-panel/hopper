import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { chmod, mkdtemp, mkdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  DeniedFileError,
  JailedFilesystem,
  NotFoundError,
  PathEscapeError,
  QuotaExceededError,
  formatMode,
  globToRegExp,
  isInside,
} from './jailed-filesystem.js';

/**
 * These tests run against a real temporary filesystem, with real symlinks: a
 * symlink escape does not reproduce against a mocked `fs`, and that is exactly
 * the case we are trying to prevent.
 *
 * Windows refuses to create symlinks without elevation or developer mode. The
 * tests concerned are therefore gated behind a probe and run in continuous
 * integration — which runs on Linux, like production nodes. A developer on
 * Windows sees them marked "skipped", never "passed".
 *
 * The probe is **synchronous and at module level**, not in a `beforeAll`.
 * `describe.runIf(...)` is evaluated when Vitest collects the tests, before any
 * `beforeAll` runs. An asynchronous probe left the flag at `false` on every
 * platform, Linux included: the eight tests were reported as skipped
 * everywhere and never checked anything.
 */
const symlinkSupported = ((): boolean => {
  const probe = mkdtempSync(join(tmpdir(), 'hopper-symlink-probe-'));

  try {
    mkdirSync(join(probe, 'target'));
    symlinkSync(join(probe, 'target'), join(probe, 'link'), 'dir');
    return true;
  } catch {
    return false;
  } finally {
    rmSync(probe, { recursive: true, force: true });
  }
})();

afterAll(() => {
  if (!symlinkSupported) {
    process.stderr.write(
      '\n⚠ Symlinks are unavailable on this platform: the symlink escape tests were skipped.\n' +
        '  They run in continuous integration, on Linux.\n\n',
    );
  }
});

describe('JailedFilesystem', () => {
  let sandbox: string;
  let volume: string;
  let outside: string;
  let jail: JailedFilesystem;

  beforeEach(async () => {
    sandbox = await mkdtemp(join(tmpdir(), 'hopper-jail-'));
    volume = join(sandbox, 'volume');
    outside = join(sandbox, 'secret');

    await mkdir(volume, { recursive: true });
    await mkdir(outside, { recursive: true });
    await writeFile(join(outside, 'passwd'), 'root:x:0:0:');
    await writeFile(join(volume, 'server.properties'), 'server-port=25565');
    await mkdir(join(volume, 'plugins'), { recursive: true });
    await writeFile(join(volume, 'plugins', 'config.yml'), 'debug: false');

    jail = new JailedFilesystem({ root: volume });
  });

  afterEach(async () => {
    await rm(sandbox, { recursive: true, force: true });
  });

  describe('legitimate paths', () => {
    it('accepts a file at the root', async () => {
      expect(await jail.resolvePath('server.properties')).toBe(join(volume, 'server.properties'));
    });

    it('accepts a nested path', async () => {
      expect(await jail.resolvePath('plugins/config.yml')).toBe(
        join(volume, 'plugins', 'config.yml'),
      );
    });

    it('accepts a leading "/" as the volume root', async () => {
      expect(await jail.resolvePath('/plugins')).toBe(join(volume, 'plugins'));
    });

    it('accepts Windows separators', async () => {
      expect(await jail.resolvePath('plugins\\config.yml')).toBe(
        join(volume, 'plugins', 'config.yml'),
      );
    });

    it('accepts a ".." that stays inside the volume', async () => {
      expect(await jail.resolvePath('plugins/../server.properties')).toBe(
        join(volume, 'server.properties'),
      );
    });

    it('accepts a file that does not exist yet', async () => {
      expect(await jail.resolvePath('new/folder/file.txt')).toBe(
        join(volume, 'new', 'folder', 'file.txt'),
      );
    });
  });

  // ---------------------------------------------------------------------------
  // This block is the reason the module exists.
  // ---------------------------------------------------------------------------

  describe('traversal escape', () => {
    it.each([
      '../secret/passwd',
      '../../etc/passwd',
      'plugins/../../secret/passwd',
      '..',
      '../',
      'a/../../secret',
    ])('rejects "%s"', async (attack) => {
      await expect(jail.resolvePath(attack)).rejects.toThrow(PathEscapeError);
    });

    /**
     * The invariant that matters is not "these payloads are rejected" but "they
     * never designate a host file". Depending on the payload and the platform,
     * the jail either rejects them or brings them back inside the volume: both
     * outcomes are safe, and the assertion covers them both.
     *
     * `....//....//` only traps filters that strip ".." in a loop: `....` is an
     * ordinary folder name, which Node's normalisation treats as such. An
     * absolute path is reinterpreted relative to the volume — as `tar` does
     * without `--absolute-names` — except on Windows where `C:/…` is recognised
     * as absolute and therefore rejected.
     */
    it.each([
      '....//....//secret/passwd',
      '/etc/passwd',
      '//etc/passwd',
      'C:/Windows/system32',
      '\\\\server\\share\\file',
    ])('never lets "%s" designate a host file', async (payload) => {
      let resolved: string;

      try {
        resolved = await jail.resolvePath(payload);
      } catch (error) {
        expect(error).toBeInstanceOf(PathEscapeError);
        return;
      }

      expect(resolved.startsWith(volume + sep)).toBe(true);
      expect(resolved).not.toContain(outside);
    });

    // A null byte truncates the path in C system calls: the check would see
    // `a`, the kernel would see something else.
    it('rejects a path containing a null byte', async () => {
      await expect(jail.resolvePath('a\0/../../secret/passwd')).rejects.toThrow(PathEscapeError);
    });
  });

  // Gated behind the probe: see the comment at the top of the file.
  describe.runIf(symlinkSupported)('symlink escape', () => {
    // The user can create these links themselves, from their console or over SFTP.
    it('rejects a link to an outside folder', async () => {
      await symlink(outside, join(volume, 'escape'), 'dir');

      await expect(jail.resolvePath('escape/passwd')).rejects.toThrow(PathEscapeError);
    });

    it('rejects a link to an outside file', async () => {
      await symlink(join(outside, 'passwd'), join(volume, 'link.txt'));

      await expect(jail.resolvePath('link.txt')).rejects.toThrow(PathEscapeError);
    });

    it('rejects a link to the system root', async () => {
      await symlink(sep, join(volume, 'root'), 'dir');

      await expect(jail.resolvePath('root/etc/passwd')).rejects.toThrow(PathEscapeError);
    });

    // The target file does not exist yet: this is the write case, and the check
    // has to apply to the parent folder.
    it('rejects a write through a link, even on a missing file', async () => {
      await symlink(outside, join(volume, 'escape'), 'dir');

      await expect(jail.resolvePath('escape/new.txt')).rejects.toThrow(PathEscapeError);
    });

    it('accepts a link that stays inside the volume', async () => {
      await symlink(join(volume, 'plugins'), join(volume, 'shortcut'), 'dir');

      await expect(jail.resolvePath('shortcut/config.yml')).resolves.toContain('plugins');
    });

    it('rejects a link nested in two hops', async () => {
      await symlink(outside, join(sandbox, 'hop1'), 'dir');
      await symlink(join(sandbox, 'hop1'), join(volume, 'hop2'), 'dir');

      await expect(jail.resolvePath('hop2/passwd')).rejects.toThrow(PathEscapeError);
    });
  });

  /**
   * The cases above all plant the link *before* asking the jail anything, which
   * only ever exercises resolution of a path that already exists. Neither of
   * the two ways a link actually gets used against this daemon looks like that.
   *
   * The daemon writes as root. The attacker is the owner of a server, who has
   * code execution inside their own container and write access to the volume —
   * a plugin jar is enough. What they can do is plant a name.
   */
  describe.runIf(symlinkSupported)('symlink escape at the moment of writing', () => {
    /**
     * The deterministic one, and the reason this block exists.
     *
     * `access(2)` follows links, so it answers ENOENT for a link whose target
     * does not exist. The jail used to probe with it, concluded the name was
     * free, and returned the path unresolved — with the link still on it. The
     * write then created the target, outside the volume, as root. Nothing had
     * to be timed.
     */
    it('rejects a dangling link that points outside the volume', async () => {
      await symlink(join(outside, 'cron.d-backdoor'), join(volume, 'notes.txt'));

      await expect(jail.resolvePath('notes.txt')).rejects.toThrow(PathEscapeError);
    });

    it('creates nothing outside the volume when writing onto a dangling link', async () => {
      const planted = join(outside, 'cron.d-backdoor');
      await symlink(planted, join(volume, 'notes.txt'));

      await expect(jail.writeFile('notes.txt', 'pwned')).rejects.toThrow(PathEscapeError);
      await expect(stat(planted)).rejects.toThrow();
    });

    it('rejects a dangling link standing in for a parent folder', async () => {
      await symlink(join(outside, 'not-created-yet'), join(volume, 'plugins-alias'), 'dir');

      await expect(jail.resolvePath('plugins-alias/config.yml')).rejects.toThrow(PathEscapeError);
    });

    /**
     * The raced one. Resolution happens while the name is genuinely free, which
     * is the answer the jail is entitled to give; the link appears in the
     * window before the open. A server process can hold that window open
     * indefinitely with `while :; do ln -sf … ; done`.
     *
     * This is the only test in the file that interleaves, and it is the one
     * that fails without `O_NOFOLLOW`: no amount of checking beforehand can
     * describe a filesystem that changes afterwards.
     */
    it('refuses a link planted between the resolution and the open', async () => {
      const resolved = await jail.resolvePath('free.txt');
      const planted = join(outside, 'planted');

      await symlink(planted, resolved);

      await expect(jail.openForWrite(resolved)).rejects.toThrow(PathEscapeError);
      await expect(stat(planted)).rejects.toThrow();
    });

    it('leaves an existing outside file untouched when a link is planted on it', async () => {
      const target = join(outside, 'passwd');
      const resolved = await jail.resolvePath('later.sh');

      await symlink(target, resolved);

      await expect(jail.openForWrite(resolved)).rejects.toThrow(PathEscapeError);
      expect(await readFile(target, 'utf8')).toBe('root:x:0:0:');
    });

    /**
     * `chmod(2)` follows links and `lchmod(2)` does not exist on Linux, so the
     * only safe way to set a mode is through a descriptor that was opened with
     * the link refusal in force.
     */
    it('never changes the mode of a file outside the volume', async () => {
      const target = join(outside, 'passwd');
      await chmod(target, 0o600);

      await symlink(target, join(volume, 'shadow-alias'));

      await expect(jail.chmod('shadow-alias', 0o777)).rejects.toThrow(PathEscapeError);
      expect((await stat(target)).mode & 0o777).toBe(0o600);
    });

    /**
     * The guard has to be narrow enough to leave ordinary use alone. A link
     * inside the volume is a legitimate thing for a server owner to make — a
     * shortcut to a world folder, a plugin pointing its data directory
     * elsewhere — and `resolvePath` resolves it, so what reaches the open is a
     * real file with no link on its last component.
     */
    it('still writes through a link that stays inside the volume', async () => {
      await symlink(join(volume, 'plugins'), join(volume, 'shortcut'), 'dir');

      await jail.writeFile('shortcut/config.yml', 'debug: true');

      expect(await readFile(join(volume, 'plugins', 'config.yml'), 'utf8')).toBe('debug: true');
    });

    it('still writes a file that does not exist yet', async () => {
      await jail.writeFile('new/nested/file.txt', 'hello');

      expect(await readFile(join(volume, 'new', 'nested', 'file.txt'), 'utf8')).toBe('hello');
    });

    it('still replaces the contents of an existing file rather than appending', async () => {
      await jail.writeFile('server.properties', 'server-port=25566');

      expect(await readFile(join(volume, 'server.properties'), 'utf8')).toBe('server-port=25566');
    });

    /**
     * The case `O_NOFOLLOW` is blind to: the last component is an ordinary name
     * throughout, and it is a *parent* that turns into a link. Only the
     * after-the-fact `/proc/self/fd` reading catches it.
     *
     * What makes it worth a test of its own is the cleanup. `O_CREAT` brings
     * the file into being before anything has had a chance to reject it, so a
     * refusal that only closes the descriptor still leaves an empty root-owned
     * file at a path the attacker chose — and an empty `/etc/nologin` denies
     * every non-root login on the host.
     */
    it('leaves nothing behind when a swapped parent takes the write outside', async () => {
      await mkdir(join(volume, 'stage'));

      const resolved = await jail.resolvePath('stage/nologin');

      await rm(join(volume, 'stage'), { recursive: true });
      await symlink(outside, join(volume, 'stage'), 'dir');

      await expect(jail.openForWrite(resolved)).rejects.toThrow(PathEscapeError);
      await expect(stat(join(outside, 'nologin'))).rejects.toThrow();
    });

    it('does not delete a file that was already there when it refuses', async () => {
      await mkdir(join(volume, 'stage'));
      await writeFile(join(outside, 'nologin'), 'pre-existing');

      const resolved = await jail.resolvePath('stage/nologin');

      await rm(join(volume, 'stage'), { recursive: true });
      await symlink(outside, join(volume, 'stage'), 'dir');

      await expect(jail.openForWrite(resolved)).rejects.toThrow(PathEscapeError);
      expect(await readFile(join(outside, 'nologin'), 'utf8')).toBe('pre-existing');
    });

    /**
     * Reading has no dangling variant — there is nothing behind a link whose
     * target does not exist — but the raced one is the more useful of the two
     * to an attacker, because it hands back file *contents* rather than the
     * ability to write them.
     */
    it('refuses to read through a link planted after the resolution', async () => {
      await writeFile(join(volume, 'notes.txt'), 'harmless');

      const resolved = await jail.resolvePath('notes.txt');

      await rm(resolved);
      await symlink(join(outside, 'passwd'), resolved);

      await expect(jail.openForRead(resolved)).rejects.toThrow(PathEscapeError);
    });

    it('still reads an ordinary file', async () => {
      const handle = await jail.openForRead(await jail.resolvePath('server.properties'));

      try {
        expect(await handle.readFile('utf8')).toBe('server-port=25565');
      } finally {
        await handle.close();
      }
    });

    /**
     * An archive entry is resolved lexically for the zip-slip check, then
     * dereferenced — the same two steps as any user path. Without the second,
     * an entry landing on a legitimate in-volume link reaches an open that
     * refuses links and tears down the whole extraction, leaving a half-written
     * tree behind.
     */
    it('resolves an archive entry through a link that stays inside the volume', async () => {
      await symlink(join(volume, 'plugins'), join(volume, 'shortcut'), 'dir');

      expect(await jail.resolveArchiveEntry('/', 'shortcut/config.yml')).toBe(
        join(volume, 'plugins', 'config.yml'),
      );
    });

    it('still refuses an archive entry that leaves the volume through a link', async () => {
      await symlink(outside, join(volume, 'escape'), 'dir');

      await expect(jail.resolveArchiveEntry('/', 'escape/passwd')).rejects.toThrow(PathEscapeError);
    });
  });

  describe('denylist', () => {
    beforeEach(() => {
      jail = new JailedFilesystem({
        root: volume,
        denylist: ['forwarding.secret', 'secrets/**', '*.key'],
      });
    });

    it.each(['forwarding.secret', 'secrets/token.txt', 'secrets/a/b/c.txt', 'server.key'])(
      'rejects "%s"',
      async (denied) => {
        await expect(jail.resolvePath(denied)).rejects.toThrow(DeniedFileError);
      },
    );

    it('lets through what does not match', async () => {
      await expect(jail.resolvePath('server.properties')).resolves.toBeTruthy();
      await expect(jail.resolvePath('plugins/config.yml')).resolves.toBeTruthy();
    });

    // Showing a file without allowing it to be read would only draw attention to it.
    it('hides denied files from a folder listing', async () => {
      await writeFile(join(volume, 'forwarding.secret'), 'secret');

      const entries = await jail.list('.');

      expect(entries.map((entry) => entry.name)).not.toContain('forwarding.secret');
      expect(entries.map((entry) => entry.name)).toContain('server.properties');
    });
  });

  describe('archive extraction', () => {
    it('accepts an ordinary entry', async () => {
      const target = await jail.resolveArchiveEntry('.', 'plugins/new.jar');
      expect(target).toBe(join(volume, 'plugins', 'new.jar'));
    });

    // The "zip slip": many extraction libraries write this entry without
    // flinching.
    it.each(['../../etc/cron.d/backdoor', '../escape.txt', 'a/../../../../escape'])(
      'rejects the entry "%s"',
      async (entry) => {
        await expect(jail.resolveArchiveEntry('.', entry)).rejects.toThrow(PathEscapeError);
      },
    );

    // An absolute entry is reinterpreted relative to the destination, as `tar`
    // does: it therefore never writes outside the volume.
    it('brings an absolute entry back into the volume', async () => {
      const target = await jail.resolveArchiveEntry('.', '/etc/passwd');

      expect(target).toBe(join(volume, 'etc', 'passwd'));
    });

    // An archive extracted into `plugins/` must not write elsewhere in the
    // volume, even where the destination would be legal.
    it('rejects an entry that leaves the requested destination', async () => {
      await expect(jail.resolveArchiveEntry('plugins', '../server.properties')).rejects.toThrow(
        PathEscapeError,
      );
    });

    it('rejects an entry on the denylist', async () => {
      const guarded = new JailedFilesystem({ root: volume, denylist: ['*.key'] });

      await expect(guarded.resolveArchiveEntry('.', 'server.key')).rejects.toThrow(DeniedFileError);
    });
  });

  describe('operations', () => {
    it('lists a folder, directories first', async () => {
      const entries = await jail.list('.');

      expect(entries[0]!.name).toBe('plugins');
      expect(entries[0]!.directory).toBe(true);
      expect(entries.map((entry) => entry.name)).toContain('server.properties');
    });

    it('returns relative paths, never absolute ones', async () => {
      const entries = await jail.list('plugins');

      expect(entries[0]!.path).toBe('plugins/config.yml');
      // The host path would reveal the machine's directory tree.
      expect(entries[0]!.path).not.toContain(sandbox);
    });

    it('reports a missing folder', async () => {
      await expect(jail.list('missing')).rejects.toThrow(NotFoundError);
    });

    it('writes a file and creates its parent folder', async () => {
      await jail.writeFile('new/folder/file.txt', 'content');

      expect((await jail.stat('new/folder/file.txt')).sizeBytes).toBe(7);
    });

    it('renames a file', async () => {
      await jail.rename('server.properties', 'renamed.properties');

      await expect(jail.stat('renamed.properties')).resolves.toBeTruthy();
      await expect(jail.stat('server.properties')).rejects.toThrow(NotFoundError);
    });

    it('rejects a rename whose destination leaves the volume', async () => {
      await expect(jail.rename('server.properties', '../escape.txt')).rejects.toThrow(
        PathEscapeError,
      );
    });

    it('copies a whole folder', async () => {
      await jail.copy('plugins', 'plugins-copy');

      expect((await jail.list('plugins-copy')).map((entry) => entry.name)).toEqual(['config.yml']);
    });

    it('deletes several entries', async () => {
      await jail.delete(['server.properties', 'plugins']);

      expect(await jail.list('.')).toEqual([]);
    });

    // Deleting the root would empty the server in one go, bypassing server
    // deletion itself.
    it('refuses to delete the volume root', async () => {
      await expect(jail.delete(['.'])).rejects.toThrow(PathEscapeError);
      await expect(jail.delete(['/'])).rejects.toThrow(PathEscapeError);
    });

    it.runIf(symlinkSupported)('describes a link as a link, without following it', async () => {
      await symlink(join(outside, 'passwd'), join(volume, 'link.txt'));

      const entry = (await jail.list('.')).find((candidate) => candidate.name === 'link.txt');

      expect(entry?.symlink).toBe(true);
      // The target's size would reveal a file outside the volume.
      expect(entry?.sizeBytes).not.toBe(12);
    });
  });

  describe('chmod', () => {
    // Changing permissions goes through the same resolution as everything else:
    // without it, `../../etc/shadow` would become world-writable from a
    // Minecraft server's file manager.
    it('rejects a path outside the volume', async () => {
      await expect(jail.chmod('../../etc/shadow', 0o777)).rejects.toThrow(PathEscapeError);
    });

    it('rejects a file on the denylist', async () => {
      const guarded = new JailedFilesystem({ root: volume, denylist: ['*.key'] });

      await expect(guarded.chmod('secret.key', 0o600)).rejects.toThrow(DeniedFileError);
    });

    // The contract schema only accepts three octal digits, but the mask is
    // applied here too: a `setuid` binary dropped in a volume would run with its
    // owner's rights and defeat the container boundary.
    //
    // Skipped on Windows, which only keeps the write bit: the test would pass
    // there without proving anything.
    it.runIf(process.platform !== 'win32')('strips the setuid and setgid bits', async () => {
      await jail.writeFile('script.sh', '#!/bin/sh');
      await jail.chmod('script.sh', 0o6755);

      const absolute = await jail.absolutePathFor('script.sh');
      const { mode } = await stat(absolute);

      expect(mode & 0o7777).toBe(0o755);
    });
  });

  describe('ownership', () => {
    // The daemon writes as root, the server runs under an unprivileged uid.
    // Without taking ownership, every path created by the file manager was
    // unreadable to the server — a plugin unable to write its configuration,
    // hours after the file was uploaded.
    it('does not break writes when no ownership is requested', async () => {
      await expect(jail.writeFile('no-owner.txt', 'ok')).resolves.toBeUndefined();
      await expect(jail.createDirectory('folder')).resolves.toBeUndefined();
    });

    // `chown` fails on Windows and for an unprivileged user: taking ownership
    // must never make the write itself fail.
    it('does not fail when chown is impossible', async () => {
      const owned = new JailedFilesystem({
        root: volume,
        ownership: { uid: 4242, gid: 4242 },
      });

      await expect(owned.writeFile('owned.txt', 'ok')).resolves.toBeUndefined();
      await expect(owned.stat('owned.txt')).resolves.toMatchObject({ name: 'owned.txt' });
    });
  });

  describe.runIf(symlinkSupported)('root that is itself a link', () => {
    it('resolves the root before any comparison', async () => {
      const link = join(sandbox, 'link-to-volume');
      await symlink(volume, link, 'dir');

      const linked = new JailedFilesystem({ root: link });

      await expect(linked.resolvePath('server.properties')).resolves.toBeTruthy();
      await expect(linked.resolvePath('../secret/passwd')).rejects.toThrow(PathEscapeError);
    });
  });
});

describe('isInside', () => {
  // Without the separator in the comparison, `/var/lib/hopper-evil` would pass
  // for being under `/var/lib/hopper`.
  it('rejects a sibling directory whose name is a prefix', () => {
    expect(isInside(resolve('/var/lib/hopper'), resolve('/var/lib/hopper-evil/x'))).toBe(false);
  });

  it('accepts the directory itself', () => {
    expect(isInside(resolve('/var/lib/hopper'), resolve('/var/lib/hopper'))).toBe(true);
  });

  it('accepts a descendant', () => {
    expect(isInside(resolve('/var/lib/hopper'), resolve('/var/lib/hopper/a/b'))).toBe(true);
  });
});

describe('globToRegExp', () => {
  it.each([
    ['*.key', 'server.key', true],
    ['*.key', 'plugins/server.key', false],
    ['**/*.key', 'plugins/server.key', true],
    ['secrets/**', 'secrets/a/b.txt', true],
    ['secrets/**', 'other/a.txt', false],
    ['forwarding.secret', 'forwarding.secret', true],
    ['forwarding.secret', 'forwarding-secret', false],
  ])('"%s" against "%s" → %s', (pattern, path, expected) => {
    expect(globToRegExp(pattern).test(path)).toBe(expected);
  });

  it('escapes regular-expression metacharacters', () => {
    expect(globToRegExp('a.b').test('axb')).toBe(false);
    expect(globToRegExp('a.b').test('a.b')).toBe(true);
  });
});

describe('formatMode', () => {
  it.each([
    [0o755, 'rwxr-xr-x'],
    [0o644, 'rw-r--r--'],
    [0o600, 'rw-------'],
    [0o777, 'rwxrwxrwx'],
    [0o000, '---------'],
  ])('formats %s as %s', (mode, expected) => {
    expect(formatMode(mode)).toBe(expected);
  });
});

/**
 * A server that can fill the host disk takes down every other server on the
 * machine, not just its own. The limit exists in the database and the daemon
 * measures usage; these tests cover the part that was missing — refusing the
 * write.
 */
describe('disk quota', () => {
  let sandbox: string;
  let volume: string;
  let usedBytes: number;
  let limitBytes: number;

  function makeJail(): JailedFilesystem {
    return new JailedFilesystem({
      root: volume,
      quota: () => ({ usedBytes, limitBytes }),
    });
  }

  beforeEach(async () => {
    sandbox = await mkdtemp(join(tmpdir(), 'hopper-quota-'));
    volume = join(sandbox, 'volume');
    await mkdir(volume, { recursive: true });
    usedBytes = 0;
    limitBytes = 1000;
  });

  afterEach(async () => {
    await rm(sandbox, { recursive: true, force: true });
  });

  it('accepts a write that fits', async () => {
    usedBytes = 900;
    await expect(makeJail().writeFile('a.txt', 'x'.repeat(50))).resolves.toBeUndefined();
  });

  it('refuses a write that would cross the limit', async () => {
    usedBytes = 900;
    await expect(makeJail().writeFile('a.txt', 'x'.repeat(200))).rejects.toThrow(
      QuotaExceededError,
    );
  });

  // A server sitting at its limit still has to be configurable: refusing an
  // edit that replaces a file with one the same size would leave the operator
  // unable to fix the very setting filling the disk.
  it('charges only the growth when replacing a file', async () => {
    const jail = makeJail();
    await jail.writeFile('config.yml', 'x'.repeat(400));

    usedBytes = 1000;

    await expect(jail.writeFile('config.yml', 'y'.repeat(400))).resolves.toBeUndefined();
    await expect(jail.writeFile('config.yml', 'y'.repeat(401))).rejects.toThrow(QuotaExceededError);
  });

  it('reports the room left', () => {
    usedBytes = 400;
    expect(makeJail().remainingBytes()).toBe(600);
  });

  it('reports no room once over the limit', () => {
    usedBytes = 1500;
    expect(makeJail().remainingBytes()).toBe(0);
  });

  // 0 is the convention the other build limits use for "unlimited"; reading it
  // as a zero-byte allowance would make every write fail on a server nobody
  // meant to restrict.
  it('treats a limit of 0 as unlimited', async () => {
    limitBytes = 0;
    usedBytes = 10 ** 9;

    expect(makeJail().remainingBytes()).toBe(Number.POSITIVE_INFINITY);
    await expect(makeJail().writeFile('a.txt', 'x'.repeat(500))).resolves.toBeUndefined();
  });

  // Restoring a backup writes on behalf of the system: enforcing a quota there
  // would leave a half-restored volume, which is worse than an oversized one.
  it('enforces nothing without a quota', async () => {
    const jail = new JailedFilesystem({ root: volume });

    expect(jail.remainingBytes()).toBe(Number.POSITIVE_INFINITY);
    await expect(jail.writeFile('a.txt', 'x'.repeat(10_000))).resolves.toBeUndefined();
  });

  it('refuses a copy that would cross the limit', async () => {
    const jail = makeJail();
    await jail.writeFile('source.jar', 'x'.repeat(400));

    usedBytes = 700;

    await expect(jail.copy('source.jar', 'copy.jar')).rejects.toThrow(QuotaExceededError);
  });
});
