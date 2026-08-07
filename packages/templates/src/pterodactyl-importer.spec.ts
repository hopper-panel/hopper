import { describe, expect, it } from 'vitest';
import { EggImportError, importPterodactylEgg, slugify } from './pterodactyl-importer.js';

const OPTIONS = { group: 'Minecraft: Java Edition' };

/** Minimal but complete egg, in PTDL_v2 format. */
function makeEgg(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    meta: { version: 'PTDL_v2' },
    uuid: '0e0b3d1e-4d0e-4d0e-8d0e-4d0e4d0e4d0e',
    name: 'Paper',
    author: 'support@pterodactyl.io',
    description: 'Paper server',
    docker_images: {
      'Java 21': 'ghcr.io/pterodactyl/yolks:java_21',
      'Java 17': 'ghcr.io/pterodactyl/yolks:java_17',
    },
    startup: 'java -Xms128M -Xmx{{SERVER_MEMORY}}M -jar {{SERVER_JARFILE}}',
    config: {
      files: '{}',
      startup: '{"done": ")! For help, type "}',
      stop: 'stop',
    },
    scripts: {
      installation: {
        script: '#!/bin/bash\ncurl -o server.jar https://example.invalid/paper.jar\n',
        container: 'ghcr.io/pterodactyl/installers:debian',
        entrypoint: 'bash',
      },
    },
    variables: [
      {
        name: 'Server Jar File',
        description: 'The name of the jarfile.',
        env_variable: 'SERVER_JARFILE',
        default_value: 'server.jar',
        user_viewable: 1,
        user_editable: 1,
        rules: 'required|regex:/^([\\w\\d._-]+)(\\.jar)$/',
      },
    ],
    ...overrides,
  };
}

/**
 * Egg for a game that is not Minecraft, declaring several startup markers.
 *
 * Modelled on the community ARK egg: a SteamCMD workload whose image, stop
 * signal and console lines have nothing in common with a Java server. The list
 * under `done` is the point — the eggs for Rust, Valheim and ARK all carry one,
 * because the line announcing the server changed between builds and the egg has
 * to recognise whichever it gets. Keeping only the first is keeping a server
 * that comes online on some versions and hangs in "starting" on the rest.
 */
function makeSteamEgg(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    meta: { version: 'PTDL_v2' },
    uuid: '2c0a9d61-6a1f-4a58-9a6a-3c1c6a9d61a4',
    name: 'ARK: Survival Evolved',
    author: 'support@pterodactyl.io',
    description: 'ARK dedicated server',
    docker_images: { 'Debian (SteamCMD)': 'ghcr.io/pterodactyl/games:source' },
    startup:
      './ShooterGame/Binaries/Linux/ShooterGameServer {{SERVER_MAP}}?listen?Port={{SERVER_PORT}}',
    config: {
      files: '{}',
      startup: '{"done": ["Setting breakpad minidump AppID", "Full Startup:"]}',
      stop: '^C',
    },
    scripts: {
      installation: {
        script: '#!/bin/bash\n./steamcmd.sh +login anonymous +app_update 376030 +quit\n',
        container: 'ghcr.io/pterodactyl/installers:debian',
        entrypoint: 'bash',
      },
    },
    variables: [
      {
        name: 'Map',
        description: 'The map the server loads.',
        env_variable: 'SERVER_MAP',
        default_value: 'TheIsland',
        user_viewable: 1,
        user_editable: 1,
        rules: 'required|string',
      },
    ],
    ...overrides,
  };
}

const STEAM_OPTIONS = { group: 'Survival' };

describe('importPterodactylEgg', () => {
  it('converts a complete egg', () => {
    const { template } = importPterodactylEgg(makeEgg(), OPTIONS);

    expect(template.key).toBe('paper');
    expect(template.name).toBe('Paper');
    expect(template.group).toBe('Minecraft: Java Edition');
    expect(template.startup).toContain('{{SERVER_MEMORY}}');
    expect(template.stopCommand).toBe('command:stop');
    expect(template.installEntrypoint).toBe('bash');
    expect(template.importedFromEgg).toBe('0e0b3d1e-4d0e-4d0e-8d0e-4d0e4d0e4d0e');
  });

  // A JSON object would lose its order in the database; the egg's order
  // reflects its author's intent, the first image being the recommended one.
  it('keeps the order of the Docker images', () => {
    const { template } = importPterodactylEgg(makeEgg(), OPTIONS);

    expect(template.dockerImages.map((option) => option.name)).toEqual(['Java 21', 'Java 17']);
  });

  it('accepts the PTDL_v1 format: images as an array', () => {
    const { template } = importPterodactylEgg(
      makeEgg({ docker_images: ['quay.io/pterodactyl/core:java'] }),
      OPTIONS,
    );

    expect(template.dockerImages).toEqual([
      { name: 'quay.io/pterodactyl/core:java', image: 'quay.io/pterodactyl/core:java' },
    ]);
  });

  it('accepts the PTDL_v1 format: a single image', () => {
    const egg = makeEgg({ image: 'quay.io/pterodactyl/core:java' });
    delete egg.docker_images;

    const { template } = importPterodactylEgg(egg, OPTIONS);
    expect(template.dockerImages).toHaveLength(1);
  });

  describe('startup markers', () => {
    // Pterodactyl stores a substring, Hopper compiles a regex: without
    // escaping, ")" would produce an invalid expression and the server would
    // never go "online".
    it('escapes the special characters', () => {
      const { template } = importPterodactylEgg(makeEgg(), OPTIONS);

      expect(template.startupDetection).toBe('\\)! For help, type ');
      expect(() => new RegExp(template.startupDetection!)).not.toThrow();
    });

    // Both fields travel to the daemon. The deprecated one is all a node
    // running an older daemon reads, so an import that stopped filling it in
    // would strand every such node on a server that never leaves "starting".
    it('emits the strategy and the deprecated field together', () => {
      const { template } = importPterodactylEgg(makeEgg(), OPTIONS);

      // And no `timeoutMs`, deliberately. A Pterodactyl egg says nothing about
      // deadlines, and a deadline is what makes a start capable of failing:
      // inventing one here would hand every egg ever imported a stop its
      // author never asked for, on a game nothing in the importer has seen.
      // The import keeps the open-ended wait it has always had.
      expect(template.readiness).toEqual({
        type: 'log',
        patterns: ['\\)! For help, type '],
      });
      expect(template.startupDetection).toBe('\\)! For help, type ');
    });

    it('accepts an already-decoded config block', () => {
      const egg = makeEgg({ config: { startup: { done: 'Done!' }, stop: 'stop' } });
      const { template } = importPterodactylEgg(egg, OPTIONS);

      expect(template.startupDetection).toBe('Done!');
      expect(template.readiness).toEqual({ type: 'log', patterns: ['Done!'] });
    });

    // The whole point of the exercise: every marker the egg declares reaches
    // the template, where all but the first used to be thrown away with a
    // warning saying so.
    it('keeps every marker a non-Minecraft egg declares', () => {
      const result = importPterodactylEgg(makeSteamEgg(), STEAM_OPTIONS);

      expect(result.template.readiness).toEqual({
        type: 'log',
        patterns: ['Setting breakpad minidump AppID', 'Full Startup:'],
      });
      // Still the first marker in the deprecated field, unchanged from what
      // this importer has always chosen, because an old node reads that one.
      expect(result.template.startupDetection).toBe('Setting breakpad minidump AppID');
      expect(result.warnings.some((w) => w.includes('startup marker'))).toBe(false);
    });

    it('escapes every marker, not only the first', () => {
      const egg = makeSteamEgg({
        config: { startup: { done: ['Full Startup:', 'Done (12.4s)! Server ready'] }, stop: '^C' },
      });

      const { readiness } = importPterodactylEgg(egg, STEAM_OPTIONS).template;
      const patterns = readiness?.type === 'log' ? readiness.patterns : [];

      expect(patterns).toHaveLength(2);
      patterns.forEach((pattern) => expect(() => new RegExp(pattern)).not.toThrow());
      expect(new RegExp(patterns[1]!).test('Done (12.4s)! Server ready')).toBe(true);
    });

    // An empty pattern compiles to a regex that matches every line, so keeping
    // one would mean the server's first console line counted as "ready".
    it('drops a blank marker rather than escaping it', () => {
      const egg = makeSteamEgg({
        config: { startup: { done: ['', 'Full Startup:'] }, stop: '^C' },
      });

      expect(importPterodactylEgg(egg, STEAM_OPTIONS).template.readiness).toEqual({
        type: 'log',
        patterns: ['Full Startup:'],
      });
    });

    // The same moment the server is called running as before, now written
    // down. An absent strategy and an explicit `immediate` mean one thing to
    // the daemon, and only one of the two can be read by an operator wondering
    // why the server went green before it had loaded anything.
    it('declares immediate when the egg names no marker', () => {
      const egg = makeEgg({ config: { stop: 'stop' } });
      const result = importPterodactylEgg(egg, OPTIONS);

      expect(result.template.readiness).toEqual({ type: 'immediate' });
      expect(result.template.startupDetection).toBeUndefined();
      expect(result.warnings.some((w) => w.includes('"immediate"'))).toBe(true);
    });
  });

  describe('stop command', () => {
    it.each([
      ['stop', 'command:stop'],
      ['end', 'command:end'],
      ['^C', 'signal:SIGINT'],
      ['SIGINT', 'signal:SIGINT'],
      ['SIGTERM', 'signal:SIGTERM'],
    ])('translates "%s" into %s', (stop, expected) => {
      const { template } = importPterodactylEgg(makeEgg({ config: { stop } }), OPTIONS);
      expect(template.stopCommand).toBe(expected);
    });

    it('falls back to SIGTERM and flags it', () => {
      const result = importPterodactylEgg(makeEgg({ config: {} }), OPTIONS);

      expect(result.template.stopCommand).toBe('signal:SIGTERM');
      expect(result.warnings.some((w) => w.includes('SIGTERM'))).toBe(true);
    });

    it('warns about a SIGKILL stop', () => {
      const result = importPterodactylEgg(makeEgg({ config: { stop: 'SIGKILL' } }), OPTIONS);
      expect(result.warnings.some((w) => w.includes('without saving'))).toBe(true);
    });
  });

  describe('variables', () => {
    it('converts the 0/1 integers into booleans', () => {
      const { template } = importPterodactylEgg(makeEgg(), OPTIONS);

      expect(template.variables[0]!.userViewable).toBe(true);
      expect(template.variables[0]!.userEditable).toBe(true);
    });

    it('converts a numeric default value into a string', () => {
      const egg = makeEgg({
        variables: [{ env_variable: 'MAX_PLAYERS', default_value: 20 }],
      });

      expect(importPterodactylEgg(egg, OPTIONS).template.variables[0]!.defaultValue).toBe('20');
    });

    it('treats a null default value as empty', () => {
      const egg = makeEgg({ variables: [{ env_variable: 'MOTD', default_value: null }] });
      expect(importPterodactylEgg(egg, OPTIONS).template.variables[0]!.defaultValue).toBe('');
    });

    // A non-conforming name would fail the `export` in the install script,
    // with a message nobody would connect back to the egg.
    it('drops a variable whose name does not follow POSIX', () => {
      const egg = makeEgg({
        variables: [{ env_variable: 'SERVER-PORT' }, { env_variable: 'VALID_ONE' }],
      });

      const result = importPterodactylEgg(egg, OPTIONS);

      expect(result.template.variables.map((v) => v.envVariable)).toEqual(['VALID_ONE']);
      expect(result.warnings.some((w) => w.includes('SERVER-PORT'))).toBe(true);
    });

    it('does not demand any variable', () => {
      const egg = makeEgg({ variables: [] });
      expect(importPterodactylEgg(egg, OPTIONS).template.variables).toEqual([]);
    });
  });

  describe('warnings', () => {
    // Hopper imposes the user, the capabilities and PID 1 whatever the image,
    // so the warning is not about hardening — it is about what the image has to
    // carry for this particular game to run, which the importer cannot know.
    it('flags the images an egg brings of its own', () => {
      const result = importPterodactylEgg(makeEgg(), OPTIONS);
      expect(result.warnings.some((w) => w.includes('images of its own'))).toBe(true);
    });

    // It used to tell every egg to check its Java version, which fired on every
    // import that was not Minecraft and asked each of them to verify something
    // that does not exist. A list of warnings nobody can act on stops being
    // read, and the ones that matter go with it.
    it('gives no Java advice about a game that has no JVM', () => {
      const result = importPterodactylEgg(makeSteamEgg(), STEAM_OPTIONS);

      expect(result.warnings.some((w) => w.includes('images of its own'))).toBe(true);
      expect(result.warnings.some((w) => /java/i.test(w))).toBe(false);
    });

    // The images Hopper ships are the ones whose contents it knows, whichever
    // tag off them the egg happened to name.
    it('says nothing about an image from the catalogue Hopper ships', () => {
      const egg = makeEgg({ docker_images: { 'Java 8': 'eclipse-temurin:8-jre-noble' } });
      const result = importPterodactylEgg(egg, OPTIONS);

      expect(result.warnings.some((w) => w.includes('images of its own'))).toBe(false);
    });

    it('flags the configuration files that were not carried over', () => {
      const egg = makeEgg({
        config: { files: '{"server.properties":{"parser":"properties"}}', stop: 'stop' },
      });

      const result = importPterodactylEgg(egg, OPTIONS);
      expect(result.warnings.some((w) => w.includes('configuration files'))).toBe(true);
    });

    it('flags an unknown egg revision', () => {
      const result = importPterodactylEgg(makeEgg({ meta: { version: 'PTDL_v9' } }), OPTIONS);
      expect(result.warnings.some((w) => w.includes('PTDL_v9'))).toBe(true);
    });
  });

  describe('refusals', () => {
    it('refuses a file that is not an egg', () => {
      expect(() => importPterodactylEgg({ hello: 'world' }, OPTIONS)).toThrow(EggImportError);
    });

    it('refuses an egg with no install script', () => {
      const egg = makeEgg({ scripts: { installation: { script: '  ' } } });
      expect(() => importPterodactylEgg(egg, OPTIONS)).toThrow(/install script/);
    });

    it('refuses an egg with no startup command', () => {
      expect(() => importPterodactylEgg(makeEgg({ startup: '' }), OPTIONS)).toThrow(
        /no startup command/,
      );
    });

    it('refuses an egg with no Docker image', () => {
      const egg = makeEgg();
      delete egg.docker_images;
      expect(() => importPterodactylEgg(egg, OPTIONS)).toThrow(/no Docker image/);
    });

    it('exposes the detail of the format problems', () => {
      try {
        importPterodactylEgg({ name: 123 }, OPTIONS);
        expect.unreachable('the import should have failed');
      } catch (error) {
        expect((error as EggImportError).issues.length).toBeGreaterThan(0);
      }
    });
  });
});

describe('slugify', () => {
  it.each([
    ['Paper', 'paper'],
    ['Paper (1.8)', 'paper-1-8'],
    ['  Vanilla  Minecraft ', 'vanilla-minecraft'],
    ['Forgé', 'forge'],
    ['A---B', 'a-b'],
  ])('turns "%s" into "%s"', (input, expected) => {
    expect(slugify(input)).toBe(expected);
  });

  it('matches the format the schema expects', () => {
    expect(slugify('ANY old thing!! 2024')).toMatch(/^[a-z0-9-]+$/);
  });

  // Two imports of the same egg have to produce the same key: otherwise the
  // upsert would create a duplicate on every import.
  it('stays stable for a name with no Latin character', () => {
    const first = slugify('日本語サーバー');
    const second = slugify('日本語サーバー');

    expect(first).toBe(second);
    expect(first).toMatch(/^[a-z0-9-]+$/);
    expect(slugify('другой')).not.toBe(first);
  });
});
