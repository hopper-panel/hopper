import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { JailedFilesystem } from '../fs/jailed-filesystem.js';
import { applyConfigFiles, parsePath } from './config-writer.js';

/**
 * The rewriter that makes an allocated port real.
 *
 * `configFiles` has been in the contract, on every shipped template and in the
 * configuration the panel sends since the templates existed — and no code in
 * the daemon ever read it. Docker publishes the allocated port on both sides,
 * so a Minecraft server given anything other than 25565 kept listening on
 * 25565 inside its container and was unreachable at the address the panel
 * displayed.
 *
 * The fixtures below are the files the shipped templates actually declare.
 */

const PORT = '25570';

let root: string;
let jail: JailedFilesystem;

const substitute = (input: string): string => input.replace('{{server.build.default.port}}', PORT);

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'hopper-config-'));
  jail = new JailedFilesystem({
    root,
    denylist: [],
    quota: () => ({ usedBytes: 0, limitBytes: 0 }),
  });
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function write(name: string, content: string): Promise<void> {
  await writeFile(join(root, name), content, 'utf8');
}

async function read(name: string): Promise<string> {
  return readFile(join(root, name), 'utf8');
}

describe('server.properties — the file the bug was about', () => {
  const CONFIG = [
    {
      file: 'server.properties',
      parser: 'properties' as const,
      replacements: [
        { match: 'server-ip', replaceWith: '0.0.0.0' },
        { match: 'server-port', replaceWith: '{{server.build.default.port}}' },
      ],
    },
  ];

  it('writes the allocated port into the file the server reads', async () => {
    await write(
      'server.properties',
      '#Minecraft server properties\nserver-ip=\nserver-port=25565\nmotd=A server\n',
    );

    const [report] = await applyConfigFiles(jail, CONFIG, substitute);

    expect(report?.changed).toBe(2);
    expect(await read('server.properties')).toContain('server-port=25570');
    expect(await read('server.properties')).toContain('server-ip=0.0.0.0');
  });

  it('leaves every other setting and every comment alone', async () => {
    await write(
      'server.properties',
      '#Minecraft server properties\n#Tue Aug 05 20:00:00 UTC 2026\nmotd=Chez Julien\nserver-port=25565\ndifficulty=hard\n',
    );

    await applyConfigFiles(jail, CONFIG, substitute);
    const written = await read('server.properties');

    // An operator who opens this file afterwards should not find it
    // rearranged, reordered or stripped of its comments.
    expect(written).toContain('#Minecraft server properties');
    expect(written).toContain('motd=Chez Julien');
    expect(written).toContain('difficulty=hard');
  });

  it('does not rewrite a file that already says the right thing', async () => {
    await write('server.properties', 'server-ip=0.0.0.0\nserver-port=25570\n');

    const [report] = await applyConfigFiles(jail, CONFIG, substitute);

    expect(report?.changed).toBe(0);
  });

  it('writes the file when the server has not created it yet', async () => {
    // The one that let the bug through a first time. Minecraft writes
    // server.properties on its first run, so on a brand-new server there was
    // nothing to rewrite: the first start bound 25565 and the port only became
    // right on the second. Nobody restarts a server that has just started.
    const [report] = await applyConfigFiles(jail, CONFIG, substitute);

    expect(report?.created).toBe(true);
    expect(await read('server.properties')).toBe('server-ip=0.0.0.0\nserver-port=25570\n');
  });

  it('leaves out a replacement conditioned on a value that cannot exist', async () => {
    // `ifValue` asks to change a value that is a certain thing; a file that
    // does not exist holds no value at all.
    const [report] = await applyConfigFiles(
      jail,
      [
        {
          file: 'server.properties',
          parser: 'properties' as const,
          replacements: [
            { match: 'server-port', replaceWith: '25570' },
            { match: 'motd', ifValue: 'old', replaceWith: 'new' },
          ],
        },
      ],
      substitute,
    );

    expect(report?.created).toBe(true);
    expect(await read('server.properties')).toBe('server-port=25570\n');
  });

  it('honours ifValue', async () => {
    await write('server.properties', 'server-port=25599\n');

    const [report] = await applyConfigFiles(
      jail,
      [
        {
          file: 'server.properties',
          parser: 'properties' as const,
          replacements: [{ match: 'server-port', ifValue: '25565', replaceWith: '25570' }],
        },
      ],
      substitute,
    );

    expect(report?.changed).toBe(0);
    expect(await read('server.properties')).toContain('25599');
  });
});

describe('velocity.toml — the template that would have been destroyed', () => {
  // The shipped Velocity template declares `parser: 'file'`. Read as "overwrite
  // the whole file", it would replace velocity.toml with the single word
  // `0.0.0.0:25570` and delete every setting the operator wrote.
  const CONFIG = [
    {
      file: 'velocity.toml',
      parser: 'file' as const,
      replacements: [{ match: 'bind', replaceWith: '0.0.0.0:{{server.build.default.port}}' }],
    },
  ];

  it('rewrites only the bind line, and keeps it quoted', async () => {
    await write(
      'velocity.toml',
      'config-version = "2.7"\nbind = "0.0.0.0:25577"\nmotd = "<#09add3>A Velocity Server"\nplayer-info-forwarding-mode = "modern"\n',
    );

    await applyConfigFiles(jail, CONFIG, substitute);
    const written = await read('velocity.toml');

    expect(written).toContain('bind = "0.0.0.0:25570"');
    expect(written).toContain('config-version = "2.7"');
    expect(written).toContain('player-info-forwarding-mode = "modern"');
    expect(written).toContain('<#09add3>A Velocity Server');
  });
});

describe('config.yml — BungeeCord, whose path is indexed', () => {
  it('reaches listeners[0].host and keeps the comments', async () => {
    await write(
      'config.yml',
      '# BungeeCord configuration\nlisteners:\n  - query_port: 25577\n    host: 0.0.0.0:25577\n    motd: Hello\nipforward: true\n',
    );

    const [report] = await applyConfigFiles(
      jail,
      [
        {
          file: 'config.yml',
          parser: 'yaml' as const,
          replacements: [
            { match: 'listeners[0].host', replaceWith: '0.0.0.0:{{server.build.default.port}}' },
          ],
        },
      ],
      substitute,
    );

    expect(report?.changed).toBe(1);

    const written = await read('config.yml');

    expect(written).toContain('0.0.0.0:25570');
    expect(written).toContain('# BungeeCord configuration');
    expect(written).toContain('motd: Hello');
    expect(written).toContain('ipforward: true');
  });

  it('leaves a broken file exactly as it is, and says why', async () => {
    // An operator who broke their own YAML gets an error, not a file silently
    // reformatted with their comments gone.
    await write('config.yml', 'listeners:\n  - host: [unclosed\n');

    const [report] = await applyConfigFiles(
      jail,
      [
        {
          file: 'config.yml',
          parser: 'yaml' as const,
          replacements: [{ match: 'listeners[0].host', replaceWith: '0.0.0.0:25570' }],
        },
      ],
      substitute,
    );

    expect(report?.skipped).toMatch(/unreadable/);
    expect(await read('config.yml')).toBe('listeners:\n  - host: [unclosed\n');
  });
});

describe('a structured file is never invented', () => {
  it('skips a missing YAML rather than writing one', async () => {
    // A YAML built from nothing is a structure the server never agreed to.
    // The install script owns those.
    const [report] = await applyConfigFiles(
      jail,
      [
        {
          file: 'config.yml',
          parser: 'yaml' as const,
          replacements: [{ match: 'listeners[0].host', replaceWith: '0.0.0.0:25570' }],
        },
      ],
      substitute,
    );

    expect(report?.skipped).toBe('file not present');
    await expect(read('config.yml')).rejects.toThrow();
  });
});

describe('the jail is not optional here', () => {
  it('refuses a template that names a path outside the volume', async () => {
    // A template is written by an administrator — and an imported Pterodactyl
    // egg is written by a stranger. Neither gets a path the file API would
    // refuse a user.
    await expect(
      applyConfigFiles(
        jail,
        [
          {
            file: '../../etc/cron.d/hopper',
            parser: 'properties' as const,
            replacements: [{ match: 'x', replaceWith: 'y' }],
          },
        ],
        substitute,
      ),
    ).rejects.toThrow();
  });
});

describe('parsePath', () => {
  it('splits dotted paths', () => {
    expect(parsePath('settings.bungeecord')).toEqual(['settings', 'bungeecord']);
  });

  it('turns an index into a number, so it addresses an array', () => {
    expect(parsePath('listeners[0].host')).toEqual(['listeners', 0, 'host']);
  });

  it('handles several indices in a row', () => {
    expect(parsePath('a[0][2].b')).toEqual(['a', 0, 2, 'b']);
  });
});
