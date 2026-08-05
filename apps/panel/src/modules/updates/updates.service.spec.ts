import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { UpdatesService } from './updates.service.js';

/**
 * The update path is the one place where the panel reaches outside its own
 * process, so the two things worth pinning down are what it writes and what it
 * refuses to conclude.
 */
describe('UpdatesService', () => {
  let spool: string;
  let service: UpdatesService;

  beforeEach(async () => {
    spool = await mkdtemp(join(tmpdir(), 'hopper-updates-'));
    process.env.HOPPER_UPDATE_DIR = spool;
    service = new UpdatesService();
  });

  afterEach(async () => {
    delete process.env.HOPPER_UPDATE_DIR;
    await rm(spool, { recursive: true, force: true });
  });

  describe('requesting an update', () => {
    it('writes a trigger carrying nothing', async () => {
      await service.requestUpdate();

      // Empty on purpose. The panel says "an update was asked for" and nothing
      // else: no command, no argument, no path. Were this file to carry
      // anything the root unit read, a compromised panel would be choosing what
      // root runs.
      expect(await readFile(join(spool, 'requested'), 'utf8')).toBe('');
    });

    it('writes the status before the trigger', async () => {
      await service.requestUpdate();
      const status = JSON.parse(await readFile(join(spool, 'status.json'), 'utf8')) as {
        state: string;
      };

      // The path unit fires on the trigger. A trigger landing first would let
      // the update start while the interface still reported `idle`.
      expect(status.state).toBe('requested');
    });
  });

  describe('status', () => {
    it('reports idle when nothing has run', async () => {
      const status = await service.status();

      expect(status.state).toBe('idle');
    });

    it('reads back what the updater wrote', async () => {
      await writeFile(
        join(spool, 'status.json'),
        JSON.stringify({ state: 'failed', log: 'git pull refused' }),
        'utf8',
      );

      const status = await service.status();

      expect(status.state).toBe('failed');
      expect(status.log).toBe('git pull refused');
    });

    // An installation made before the updater existed has no unit to trigger.
    // Saying so is what lets the interface offer the command instead of a
    // button that would do nothing.
    it('reports whether the machine can apply an update at all', async () => {
      const status = await service.status();

      expect(typeof status.supported).toBe('boolean');
    });
  });

  // The installer copies the sources without `.git`, so an installed panel
  // cannot ask git which revision it runs. It reads what install.sh recorded.
  // Getting this wrong is not harmless: with no local commit the comparison
  // falls back to tags, a tag never equals `0.0.0-dev`, and the administration
  // announces an update on an installation that is perfectly current.
  describe('the installed commit', () => {
    let root: string;

    beforeEach(async () => {
      root = await mkdtemp(join(tmpdir(), 'hopper-root-'));
      process.env.HOPPER_ROOT = root;
    });

    afterEach(async () => {
      delete process.env.HOPPER_ROOT;
      await rm(root, { recursive: true, force: true });
    });

    it('reads the commit the installer recorded', async () => {
      const sha = 'a'.repeat(40);
      await writeFile(
        join(root, '.hopper-commit'),
        `${sha}
`,
        'utf8',
      );

      const check = await new UpdatesService().check(true);

      expect(check.commit).toBe(sha);
    });

    it('ignores a file that does not hold a commit', async () => {
      await writeFile(join(root, '.hopper-commit'), 'not-a-sha', 'utf8');

      const check = await new UpdatesService().check(true);

      expect(check.commit).not.toBe('not-a-sha');
    });
  });

  describe('the manual command', () => {
    it('names the installer of this installation', () => {
      expect(service.manualCommand()).toMatch(/install\.sh$/);
      expect(service.manualCommand()).toMatch(/^sudo bash /);
    });
  });
});
