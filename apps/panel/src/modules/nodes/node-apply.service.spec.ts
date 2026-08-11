import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ServiceUnavailableException } from '@nestjs/common';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { NodeApplyService } from './node-apply.service.js';

/**
 * Asking the machine to write its own `daemon.yml`.
 *
 * The three manual steps this replaces — copy the document, `chmod 600`, restart
 * hopperd — cost an operator an evening: the middle one was skipped by piping
 * the file through `tee`, hopperd exited 78 at every start, and the panel
 * reported the node as unreachable, which sends anyone looking at the network.
 */

let root: string;
let spool: string;
let unit: string;
let service: NodeApplyService;

const NODE_UUID = 'a3c2e1d0-5b44-4f21-8e73-9c1a2b3d4e5f';

/**
 * Denying a directory's write bit is a real test only where the bit is real.
 *
 * Windows does not honour it and root ignores it, and in both cases the write
 * below succeeds — so the suite would pass while proving nothing. Skipped
 * rather than weakened, in the way `client.spec.ts` skips without an engine.
 */
const canDenyWrites = process.platform !== 'win32' && process.getuid?.() !== 0;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'hopper-apply-'));
  spool = join(root, 'node-apply');
  unit = join(root, 'hopper-node-apply.path');

  process.env.HOPPER_NODE_APPLY_DIR = spool;
  process.env.HOPPER_NODE_APPLY_UNIT = unit;

  service = new NodeApplyService();
});

afterEach(async () => {
  delete process.env.HOPPER_NODE_APPLY_DIR;
  delete process.env.HOPPER_NODE_APPLY_UNIT;
  // Restored first: a test that took the write bit off leaves a directory
  // nothing can be deleted from, including this line.
  await chmod(root, 0o700).catch(() => undefined);
  await rm(root, { recursive: true, force: true });
});

/** The unit `install.sh` lays down, as far as this service can tell. */
async function installUnit(): Promise<void> {
  await writeFile(unit, '[Path]\n', 'utf8');
}

describe('when the root-side unit is installed', () => {
  beforeEach(installUnit);

  it('writes the node uuid, and nothing else, as the request', async () => {
    await service.request(NODE_UUID);

    // The whole of what the panel gets to say. A command, a path or a mode
    // here would be the panel deciding what runs as root.
    expect(await readFile(join(spool, 'requested'), 'utf8')).toBe(NODE_UUID);
  });

  it('records the request before the trigger that fires on it', async () => {
    await service.request(NODE_UUID);

    // Written in the other order, the path unit fires while the status file
    // still says `idle`, and the interface reports nothing is happening
    // during the one moment something is.
    const status = JSON.parse(await readFile(join(spool, 'status.json'), 'utf8')) as {
      state: string;
    };

    expect(status.state).toBe('requested');
  });

  it('creates the directory when nothing has asked before', async () => {
    // A fresh installation has no spool: failing here would make the very
    // first use the one that does not work.
    await expect(service.request(NODE_UUID)).resolves.toBeUndefined();
  });

  it('reports what the unit last wrote', async () => {
    await mkdir(spool, { recursive: true });
    await writeFile(
      join(spool, 'status.json'),
      JSON.stringify({ state: 'failed', finishedAt: '2026-08-11T00:00:00Z', log: 'boom' }),
      'utf8',
    );

    expect(await service.status()).toMatchObject({
      state: 'failed',
      available: true,
      log: 'boom',
    });
  });

  it('reads an empty machine as idle rather than as a failure', async () => {
    expect(await service.status()).toMatchObject({ state: 'idle', available: true });
  });
});

/**
 * The machine an operator actually met.
 *
 * `install.sh` created the updater's spool and not this one, so the units were
 * installed — the button appeared, and it was enabled — while the panel's
 * account could not create the directory the request goes in: /var/lib/hopper
 * belongs to root. Pressing it answered "Internal server error", which says
 * nothing about a permission on a directory.
 */
describe.runIf(canDenyWrites)('when the panel cannot write the spool', () => {
  beforeEach(async () => {
    await installUnit();
    await chmod(root, 0o500);
  });

  it('names the directory, and what to do about it', async () => {
    const error = await service.request(NODE_UUID).catch((reason: unknown) => reason);

    // The type matters as much as the words: an unhandled write error is a 500
    // the interface prints as "Internal server error", and a refusal is a
    // message it renders in full. The operator repairs the machine off one of
    // those and reports a bug off the other.
    expect(error).toBeInstanceOf(ServiceUnavailableException);
    expect((error as Error).message).toContain(spool);
    expect((error as Error).message).toMatch(/node:token/);
  });

  it('does not call itself available with the unit installed', async () => {
    // Both halves have to hold. The units alone made every installation
    // report `available: true` on a spool that could not be created.
    expect(await service.status()).toMatchObject({ available: false });
  });
});

describe('when the root-side unit is absent', () => {
  it('refuses instead of leaving a trigger nothing watches', async () => {
    // The trigger would sit in a directory no unit is looking at, the
    // interface would report `requested` for ever, and the operator would be
    // waiting on a machine that was never going to act.
    await expect(service.request(NODE_UUID)).rejects.toBeInstanceOf(ServiceUnavailableException);
  });

  it('names the commands to run by hand', async () => {
    await expect(service.request(NODE_UUID)).rejects.toThrow(/node:token/);
  });

  it('says so in the status, so the interface can offer the document instead', async () => {
    expect(await service.status()).toMatchObject({ state: 'idle', available: false });
  });
});
