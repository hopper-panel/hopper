import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PARSERS_NOT_WRITTEN, configParserSchema } from '@hopper/shared';
import { JailedFilesystem } from '../fs/jailed-filesystem.js';
import { applyConfigFiles, parsePath, unwrittenParserMessage } from './config-writer.js';

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

/**
 * The parser Pterodactyl's eggs write their port with.
 *
 * `.env` and the fixtures below are real shapes from the public corpus: 265
 * `file` replacements across 55 eggs, of which 245 repeat their key and 27
 * eggs write their port nowhere else. Every one of them was refused at import
 * until this parser existed, so these tests are the corpus, not an invention.
 */
describe('whole-line — the line goes, not the value on it', () => {
  const config = (replacements: { match: string; ifValue?: string; replaceWith: string }[]) => [
    { file: '.env', parser: 'whole-line' as const, replacements },
  ];

  it('writes the key once, not twice', async () => {
    await write('.env', 'DISCORD_TOKEN=old\n');

    await applyConfigFiles(
      jail,
      config([{ match: 'DISCORD_TOKEN', replaceWith: 'DISCORD_TOKEN=abc' }]),
      substitute,
    );

    // `DISCORD_TOKEN=DISCORD_TOKEN=abc` is what routing this through
    // `rewriteLines` produces, and what the importer refused eggs over.
    expect(await read('.env')).toBe('DISCORD_TOKEN=abc\n');
  });

  it('finds a line whose match already carries the delimiter', async () => {
    // 75 matches in the corpus are shaped like this, and `rewriteLines` cannot
    // match any of them: it looks for the key *followed by* a delimiter.
    await write('.env', '#port = 5432\n');

    await applyConfigFiles(
      jail,
      config([{ match: '#port =', replaceWith: `port = ${PORT}` }]),
      substitute,
    );

    expect(await read('.env')).toBe(`port = ${PORT}\n`);
  });

  it('reads the same line differently from the file parser', async () => {
    // The two parsers exist because they disagree here. If this ever passes
    // with both files equal, one `case` has been pointed at the other.
    await write('a.cfg', 'bind = 25565\n');
    await write('b.cfg', 'bind = 25565\n');

    await applyConfigFiles(
      jail,
      [
        {
          file: 'a.cfg',
          parser: 'file' as const,
          replacements: [{ match: 'bind', replaceWith: PORT }],
        },
        {
          file: 'b.cfg',
          parser: 'whole-line' as const,
          replacements: [{ match: 'bind', replaceWith: PORT }],
        },
      ],
      substitute,
    );

    expect(await read('a.cfg')).toBe(`bind = ${PORT}\n`);
    expect(await read('b.cfg')).toBe(`${PORT}\n`);
  });

  it('leaves every other line, comment and blank alone', async () => {
    await write('.env', '# a comment\n\nOTHER=keep\nDISCORD_TOKEN=old\nLAST=keep\n');

    await applyConfigFiles(
      jail,
      config([{ match: 'DISCORD_TOKEN', replaceWith: 'DISCORD_TOKEN=abc' }]),
      substitute,
    );

    expect(await read('.env')).toBe('# a comment\n\nOTHER=keep\nDISCORD_TOKEN=abc\nLAST=keep\n');
  });

  it('does not reach a commented line, nor a match sitting inside one', async () => {
    // `line.includes(match)` takes the comment above the setting — which is
    // usually the line documenting it — and leaves the setting itself.
    await write('.env', '# DISCORD_TOKEN=example\nOLD_DISCORD_TOKEN=x\nDISCORD_TOKEN=old\n');

    await applyConfigFiles(
      jail,
      config([{ match: 'DISCORD_TOKEN', replaceWith: 'DISCORD_TOKEN=abc' }]),
      substitute,
    );

    expect(await read('.env')).toBe(
      '# DISCORD_TOKEN=example\nOLD_DISCORD_TOKEN=x\nDISCORD_TOKEN=abc\n',
    );
  });

  it('rewrites the first matching line only', async () => {
    await write('.env', 'DISCORD_TOKEN=first\nDISCORD_TOKEN=second\n');

    const [report] = await applyConfigFiles(
      jail,
      config([{ match: 'DISCORD_TOKEN', replaceWith: 'DISCORD_TOKEN=abc' }]),
      substitute,
    );

    expect(report?.changed).toBe(1);
    expect(await read('.env')).toBe('DISCORD_TOKEN=abc\nDISCORD_TOKEN=second\n');
  });

  it('deletes a line when the replacement is empty', async () => {
    // Three replacements in the corpus do this — `exec server;` → nothing —
    // and no value rewrite can express it.
    await write('.env', 'exec server;\nKEEP=1\n');

    await applyConfigFiles(jail, config([{ match: 'exec server;', replaceWith: '' }]), substitute);

    expect(await read('.env')).toBe('\nKEEP=1\n');
  });

  it('compares ifValue against the whole line, not against a value on it', async () => {
    await write('.env', 'host=127.0.0.1\n');

    await applyConfigFiles(
      jail,
      config([{ match: 'host', ifValue: '127.0.0.1', replaceWith: 'host=0.0.0.0' }]),
      substitute,
    );

    // `127.0.0.1` is the value, and there is no value here — the condition is
    // about the line. Comparing after a delimiter would fire, and would be
    // comparing against something this parser never computes.
    expect(await read('.env')).toBe('host=127.0.0.1\n');

    await applyConfigFiles(
      jail,
      config([{ match: 'host', ifValue: 'host=127.0.0.1', replaceWith: 'host=0.0.0.0' }]),
      substitute,
    );

    expect(await read('.env')).toBe('host=0.0.0.0\n');
  });

  it('reports nothing changed when the line already says it', async () => {
    await write('.env', 'DISCORD_TOKEN=abc\n');

    const [report] = await applyConfigFiles(
      jail,
      config([{ match: 'DISCORD_TOKEN', replaceWith: 'DISCORD_TOKEN=abc' }]),
      substitute,
    );

    // `applyOne` skips the write on `changed === 0`. Counting one here moves
    // the file's mtime on every start and makes the console report work that
    // did not happen.
    expect(report?.changed).toBe(0);
  });

  it('does not invent the file it was going to patch', async () => {
    // `createMissing` writes `key=value` lines from the replacements, which
    // for this parser would produce `DISCORD_TOKEN=DISCORD_TOKEN=abc` — the
    // exact corruption the parser exists to avoid.
    const [report] = await applyConfigFiles(
      jail,
      config([{ match: 'DISCORD_TOKEN', replaceWith: 'DISCORD_TOKEN=abc' }]),
      substitute,
    );

    expect(report?.skipped).toBe('file not present');
    await expect(read('.env')).rejects.toThrow();
  });
});

describe('a parser with no rewriter behind it', () => {
  const CONFIG = [
    {
      file: 'server.xml',
      parser: 'xml' as const,
      replacements: [{ match: 'port', replaceWith: '{{server.build.default.port}}' }],
    },
  ];

  /**
   * The case that had no test, which is how three places in this repository
   * came to describe it wrongly.
   *
   * `xml` is in the contract and nothing here writes it. What that produces is
   * not a failed start — `applyOne` catches, `writeConfigFiles` is never fatal
   * — it is a server running on the port its file already held. The two
   * assertions below are the whole difference between a bug an operator can
   * act on and one they cannot see.
   */
  it('leaves the file untouched and starts anyway, rather than failing', async () => {
    await write('server.xml', '<server port="8080" />\n');

    const [report] = await applyConfigFiles(jail, CONFIG, substitute);

    expect(report?.changed).toBe(0);
    expect(await read('server.xml')).toBe('<server port="8080" />\n');
  });

  it('says whose fault it is not, and what the operator is left with', async () => {
    await write('server.xml', '<server port="8080" />\n');

    const [report] = await applyConfigFiles(jail, CONFIG, substitute);

    // `unreadable` is the word every other refusal in this file uses, and it
    // means *their* file would not parse. Theirs is fine. Reaching for it here
    // sends them to inspect the one thing that is not the problem.
    expect(report?.skipped).not.toMatch(/unreadable/);
    expect(report?.skipped).toContain('no xml rewriter');
    // The consequence, not just the cause: this line is the only warning
    // anybody gets that what the template meant to write was not written.
    // Hedged rather than asserted — a refused file need not name a port at
    // all, and claiming it does is the same overreach this commit removes
    // elsewhere.
    expect(report?.skipped).toContain('this template meant to write into it');
  });

  it('does not invent the file when it is missing either', async () => {
    // `createMissing` is for `properties` alone, and a parser nothing writes
    // must not slip past that on the strength of the file being absent.
    const [report] = await applyConfigFiles(jail, CONFIG, substitute);

    expect(report?.skipped).toBe('file not present');
    await expect(read('server.xml')).rejects.toThrow();
  });

  /**
   * The list in the contract and the `switch` here say the same thing.
   *
   * They are two declarations of one fact, in two packages, and the panel
   * refuses a template on the strength of the first one while only the second
   * decides anything. Left unlinked, the day someone writes a rewriter and
   * forgets the list is the day the panel refuses a parser that works — and the day someone adds a parser to the enum without
   * a branch here, this `switch` stops being exhaustive and TypeScript says
   * so, but nothing says the list is now wrong.
   *
   * Driven off the enum rather than a copy of it, so a seventh parser is
   * covered by this test the moment it exists.
   */
  it('refuses exactly the parsers the contract says nothing writes', async () => {
    for (const parser of configParserSchema.options) {
      await write('probe', '');

      const [report] = await applyConfigFiles(
        jail,
        [{ file: 'probe', parser, replacements: [{ match: 'port', replaceWith: PORT }] }],
        substitute,
      );

      const listed = PARSERS_NOT_WRITTEN.includes(parser);

      expect(
        report?.skipped === unwrittenParserMessage(parser),
        listed
          ? `${parser} is in PARSERS_NOT_WRITTEN and this rewriter writes it: the panel refuses a parser that works`
          : `${parser} is refused by this rewriter and missing from PARSERS_NOT_WRITTEN: a template can name it and nothing warns`,
      ).toBe(listed);
    }
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
