import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ServerInstance } from '../server/server-instance.js';
import type { ServerManager } from '../server/server-manager.js';
import { registerFileRoutes } from './files.js';

/**
 * What `files/contents` agrees to hand to the editor.
 *
 * The file manager no longer keeps a list of extensions it will open — the list
 * refused a folder of Garry's Mod `.lua` and every other thing nobody had
 * thought to name — so anything not plainly binary now arrives here. This route
 * is what stands between an editor and a region file, and it decides on the
 * bytes rather than on the name.
 *
 * Against a real temporary filesystem: the answer comes from what is read off
 * the disk, which a mocked `fs` would not be testing.
 */

let root: string;
let app: FastifyInstance;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'hopper-files-route-'));

  const server = {
    uuid: 'server-1',
    volumePath: root,
    diskQuota: 1024 * 1024 * 1024,
    configuration: { fileDenylist: [] },
  } as unknown as ServerInstance;

  const manager = { require: () => server } as unknown as ServerManager;

  app = Fastify();
  registerFileRoutes(app, manager, { uid: 0, gid: 0 });
  await app.ready();
});

afterEach(async () => {
  await app.close();
  await rm(root, { recursive: true, force: true });
});

/** The `code` of an error payload, which is what a refusal is judged on. */
function errorCodeOf(body: string): string {
  return (JSON.parse(body) as { error: { code: string } }).error.code;
}

async function contents(file: string) {
  return app.inject({
    method: 'GET',
    url: `/api/servers/server-1/files/contents?file=${encodeURIComponent(file)}`,
  });
}

describe('GET files/contents', () => {
  it('serves a Lua file, which no allow list ever listed', async () => {
    const source = 'hook.Add("Think", "demo", function() end)\n';
    await writeFile(join(root, 'autorun.lua'), source, 'utf8');

    const response = await contents('autorun.lua');

    expect(response.statusCode).toBe(200);
    expect(response.body).toBe(source);
  });

  it('serves a file with no extension at all', async () => {
    await writeFile(join(root, 'Dockerfile'), 'FROM debian:13\n', 'utf8');

    const response = await contents('Dockerfile');

    expect(response.statusCode).toBe(200);
  });

  it('refuses a file holding a NUL byte, and says which refusal it is', async () => {
    // A Minecraft region file starts with a plausible-looking header and is
    // full of NUL: exactly the thing the name cannot rule out on its own.
    await writeFile(join(root, 'r.0.0.dat'), Buffer.from([0x1f, 0x00, 0x8b, 0x00, 0x08]));

    const response = await contents('r.0.0.dat');

    expect(response.statusCode).toBe(415);
    expect(errorCodeOf(response.body)).toBe('file_not_text');
  });

  it('serves Latin-1, which is not UTF-8 and is edited every day', async () => {
    // `motd=Bienvenue` in Latin-1: the accented byte is invalid UTF-8. Refusing
    // it would refuse the `server.properties` the user came to edit.
    await writeFile(join(root, 'server.properties'), Buffer.from([0x6d, 0x3d, 0xe9, 0x0a]));

    const response = await contents('server.properties');

    expect(response.statusCode).toBe(200);
  });

  it('serves an empty file rather than calling it binary', async () => {
    await writeFile(join(root, 'empty.log'), '');

    const response = await contents('empty.log');

    expect(response.statusCode).toBe(200);
    expect(response.body).toBe('');
  });

  it('still refuses a folder', async () => {
    const response = await contents('/');

    expect(response.statusCode).toBe(400);
    expect(errorCodeOf(response.body)).toBe('is_directory');
  });
});
