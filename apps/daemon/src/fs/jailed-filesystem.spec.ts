import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { mkdtemp, mkdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  DeniedFileError,
  JailedFilesystem,
  NotFoundError,
  PathEscapeError,
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
