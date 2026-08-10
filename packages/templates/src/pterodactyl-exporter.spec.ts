import { describe, expect, it } from 'vitest';
import { templateDefinitionSchema, type TemplateDefinition } from './definition.js';
import { TEMPLATE_CATALOG } from './index.js';
import { importPterodactylEgg } from './pterodactyl-importer.js';
import { exportPterodactylEgg, unescapeRegExp } from './pterodactyl-exporter.js';

/**
 * Exporting a template, and getting the same template back.
 *
 * The whole point of the file is the round trip, so that is what is asserted
 * rather than the shape of the JSON: an export nobody can re-import is a
 * download button, not a way of moving work between installations.
 *
 * The catalogue is the corpus for it, and it is a better one than a fixture
 * would be: templates written for their games rather than for this test,
 * between them covering every field the egg format cannot hold — Velocity uses
 * the `file` parser Pterodactyl means something else by, Factorio stops over
 * RCON with a password variable and a named port, and the Source templates
 * declare a required disk size in the billions.
 *
 * Neither the count nor "the proxies" survives being written down: this said
 * eleven when there were twelve, and BungeeCord is `yaml`. The cases come from
 * `TEMPLATE_CATALOG`, so the corpus is whatever ships.
 */

const EXPORTED_AT = '2026-08-09T12:00:00.000Z';

function roundTrip(template: TemplateDefinition): TemplateDefinition {
  const egg = exportPterodactylEgg(template, { exportedAt: EXPORTED_AT });

  // Through JSON, because that is what happens between the two: a value that
  // survives the functions and not the serialisation has not survived.
  const { template: reimported } = importPterodactylEgg(
    JSON.parse(JSON.stringify(egg)) as unknown,
    { group: template.group },
  );

  return reimported;
}

describe('exporting a template as a Pterodactyl egg', () => {
  it.each(TEMPLATE_CATALOG.map((template) => [template.key, template] as const))(
    'brings %s back unchanged',
    (_key, template) => {
      expect(roundTrip(template)).toEqual(template);
    },
  );

  /**
   * The fields the block exists for, named one at a time.
   *
   * The sweep above would catch any of these going missing, but it would report
   * "the Factorio template differs" and leave the reader to diff two hundred
   * lines. These say which field and why it could not have been carried by the
   * egg itself.
   */
  describe('what the egg format has no field for', () => {
    const factorio = TEMPLATE_CATALOG.find((template) => template.key === 'factorio')!;

    it('is a template that actually uses them', () => {
      // Guards the tests below against becoming vacuous: they assert that a
      // value survives, and a template that stopped declaring one would let
      // them pass by comparing undefined with undefined.
      expect(factorio.readiness?.type).toBe('log');
      expect(factorio.readiness).not.toEqual({
        type: 'log',
        patterns: [factorio.startupDetection],
      });
      expect(factorio.stopTimeoutSeconds).toBe(240);
    });

    /**
     * No shipped template declares one, so this is built by hand — and that is
     * the case worth building, because an RCON stop is three fields the egg
     * format has one string for. Losing the password variable does not degrade
     * the stop, it replaces it: the server takes a SIGTERM through the save the
     * transport was chosen to protect.
     */
    it('carries an RCON stop, with its password variable and its port name', () => {
      const rcon = templateDefinitionSchema.parse({
        ...factorio,
        stop: { type: 'rcon', command: 'quit', role: 'rcon', secretVariable: 'RCON_PASSWORD' },
      });

      expect(roundTrip(rcon).stop).toEqual(rcon.stop);
    });

    it('carries the readiness strategy rather than the console pattern it is not', () => {
      // Factorio declares two markers where `startupDetection` can hold one, so
      // a round trip through the egg field alone would silently halve it.
      expect(roundTrip(factorio).readiness).toEqual(factorio.readiness);
    });

    it('carries the grace a game that writes its world on shutdown was given', () => {
      expect(roundTrip(factorio).stopTimeoutSeconds).toBe(240);
    });

    /**
     * The mirror of the two above: a template that declares only the console
     * pattern comes back declaring only the console pattern.
     *
     * The importer derives a `log` strategy from any marker it sees, so this
     * used to gain an explicit `readiness` on every round trip — the same
     * behaviour written twice, in a template that no longer equalled the one
     * that was exported.
     */
    it('does not invent a strategy for a template that declares none', () => {
      const paper = TEMPLATE_CATALOG.find((template) => template.key === 'paper')!;

      expect(paper.readiness).toBeUndefined();
      expect(roundTrip(paper).readiness).toBeUndefined();
      expect(roundTrip(paper).startupDetection).toBe(paper.startupDetection);
    });

    it('carries a configuration file whose parser means something else over there', () => {
      const velocity = TEMPLATE_CATALOG.find((template) => template.key === 'velocity')!;

      expect(velocity.configFiles.some((file) => file.parser === 'file')).toBe(true);
      expect(roundTrip(velocity).configFiles).toEqual(velocity.configFiles);
    });

    it('carries the disk an installation needs before it is allowed to start', () => {
      const source = TEMPLATE_CATALOG.find(
        (template) => template.installRequiredDiskBytes !== undefined,
      )!;

      expect(roundTrip(source).installRequiredDiskBytes).toBe(source.installRequiredDiskBytes);
    });
  });

  /**
   * The half another panel reads.
   *
   * Measured against the 274 eggs of the public corpus rather than taken from
   * the documentation, because the format's documentation and the format's
   * files disagree: all 274 write the three `config` documents as **strings**,
   * all 274 carry `file_denylist`, and 1840 of their 1855 variables carry a
   * `field_type`.
   */
  describe('the egg half', () => {
    const egg = exportPterodactylEgg(TEMPLATE_CATALOG[0]!, { exportedAt: EXPORTED_AT });

    it('declares the revision Pterodactyl reads', () => {
      expect(egg.meta).toEqual({ version: 'PTDL_v2', update_url: null });
    });

    it('writes the configuration documents as strings, not objects', () => {
      expect(typeof egg.config.files).toBe('string');
      expect(typeof egg.config.startup).toBe('string');
      expect(typeof egg.config.logs).toBe('string');

      // And they are documents, not text: a panel that parses them gets JSON.
      expect(() => JSON.parse(egg.config.files) as unknown).not.toThrow();
      expect(JSON.parse(egg.config.startup) as unknown).toHaveProperty('done');
    });

    it('writes the startup marker as a substring, not as the regex Hopper compiled', () => {
      const marker = TEMPLATE_CATALOG.find((template) => template.startupDetection?.includes('\\'));

      expect(marker).toBeTruthy();

      const exported = exportPterodactylEgg(marker!, { exportedAt: EXPORTED_AT });
      const { done } = JSON.parse(exported.config.startup) as { done: string | string[] };

      // Pterodactyl looks for the string in a line; a backslash in it would be
      // looked for literally and never found.
      expect(JSON.stringify(done)).not.toContain('\\\\');
    });

    it('leaves out the parsers the other panel would apply differently', () => {
      const velocity = TEMPLATE_CATALOG.find((template) => template.key === 'velocity')!;
      const exported = exportPterodactylEgg(velocity, { exportedAt: EXPORTED_AT });
      const files = JSON.parse(exported.config.files) as Record<string, { parser: string }>;

      // Not a truncation to be sorry about: Pterodactyl's `file` parser replaces
      // the whole line where Hopper's replaces the value, so carrying these
      // across would make the other panel write the key into the value.
      expect(Object.values(files).every((file) => file.parser !== 'file')).toBe(true);
      // Every one of them is still exact in the block.
      expect(exported.hopper.configFiles).toEqual(velocity.configFiles);
    });

    /**
     * The one parser that translates, and the only test that can see it.
     *
     * The round trip above cannot: a re-import reads `hopper.configFiles`
     * first, so a `config.files` block exported with the wrong parser name —
     * or with no block at all — comes back byte-identical here and is broken
     * for every panel that is not this one. What that costs is precisely what
     * this parser was added for: an imported egg's port, exported again and
     * written nowhere.
     */
    it('writes a whole-line parser under the name the other panel knows it by', () => {
      const template = templateDefinitionSchema.parse({
        ...TEMPLATE_CATALOG[0]!,
        configFiles: [
          {
            file: '.env',
            parser: 'whole-line',
            replacements: [{ match: 'DISCORD_TOKEN', replaceWith: 'DISCORD_TOKEN=abc' }],
          },
        ],
      });

      const exported = exportPterodactylEgg(template, { exportedAt: EXPORTED_AT });
      const files = JSON.parse(exported.config.files) as Record<string, { parser: string }>;

      expect(files['.env']?.parser).toBe('file');
      // And back again, without passing through the `hopper` block.
      expect(
        importPterodactylEgg(JSON.parse(JSON.stringify({ ...exported, hopper: undefined })), {
          group: template.group,
        }).template.configFiles,
      ).toEqual(template.configFiles);
    });

    it('names the egg a template came from, and invents none for a template that came from nowhere', () => {
      const imported = templateDefinitionSchema.parse({
        ...TEMPLATE_CATALOG[0]!,
        importedFromEgg: 'b8b0b7a2-1b6f-4f4e-9a5a-0e6f1a2b3c4d',
      });

      expect(exportPterodactylEgg(imported, { exportedAt: EXPORTED_AT }).uuid).toBe(
        'b8b0b7a2-1b6f-4f4e-9a5a-0e6f1a2b3c4d',
      );
      expect('uuid' in egg).toBe(false);
    });

    it('turns a stop command back into what the format writes', () => {
      const command = templateDefinitionSchema.parse({
        ...TEMPLATE_CATALOG[0]!,
        stopCommand: 'command:end',
      });
      const interrupt = templateDefinitionSchema.parse({
        ...TEMPLATE_CATALOG[0]!,
        stopCommand: 'signal:SIGINT',
      });

      expect(exportPterodactylEgg(command, { exportedAt: EXPORTED_AT }).config.stop).toBe('end');
      // The caret is how older eggs spell SIGINT, and the importer reads it.
      expect(exportPterodactylEgg(interrupt, { exportedAt: EXPORTED_AT }).config.stop).toBe('^C');
    });

    it('keeps two images apart when their labels collide', () => {
      const collided = templateDefinitionSchema.parse({
        ...TEMPLATE_CATALOG[0]!,
        dockerImages: [
          { name: 'latest', image: 'ghcr.io/example/one:latest' },
          { name: 'latest', image: 'ghcr.io/example/two:latest' },
        ],
      });

      // `docker_images` is an object, so a repeated label is one image on the
      // way back and a template that left with two would return with one. The
      // label is what gives — it is a display string — and the images
      // themselves, which is what a server actually runs, all survive.
      const exported = exportPterodactylEgg(collided, { exportedAt: EXPORTED_AT });
      expect(Object.keys(exported.docker_images)).toHaveLength(2);
      expect(roundTrip(collided).dockerImages.map((option) => option.image)).toEqual([
        'ghcr.io/example/one:latest',
        'ghcr.io/example/two:latest',
      ]);
    });
  });

  describe('reading a file this version did not write', () => {
    /**
     * An egg from Pterodactyl carries no block, and nothing about importing one
     * changes. Asserted because the overlay is applied to every import, and an
     * overlay that read `undefined` as "clear this field" would have wiped the
     * readiness strategy off every egg in the corpus.
     */
    it('imports an egg with no block exactly as before', () => {
      const egg = {
        name: 'Rust',
        author: 'someone@example.com',
        description: 'A Rust server.',
        docker_images: { Rust: 'ghcr.io/example/rust:latest' },
        startup: './RustDedicated -batchmode',
        config: { files: '{}', startup: '{"done":"Server startup complete"}', stop: 'quit' },
        scripts: { installation: { script: 'echo install', container: 'debian:bookworm-slim' } },
        variables: [],
      };

      const { template } = importPterodactylEgg(egg, { group: 'Rust' });

      expect(template.readiness).toEqual({
        type: 'log',
        patterns: ['Server startup complete'],
      });
      expect(template.startupDetection).toBe('Server startup complete');
      expect(template.stopCommand).toBe('command:quit');
      expect(template.stop).toBeUndefined();
    });

    it('reads the protected files an egg declares, which used to be dropped', () => {
      const { template } = importPterodactylEgg(
        {
          name: 'Palworld',
          docker_images: { Palworld: 'ghcr.io/example/palworld' },
          startup: './PalServer.sh',
          file_denylist: ['PalServer.sh'],
          config: { startup: '{"done":"Setting breakpad minidump"}' },
          scripts: { installation: { script: 'echo install' } },
        },
        { group: 'Steam' },
      );

      expect(template.fileDenylist).toEqual(['PalServer.sh']);
    });

    it('says so when the block is newer than it understands', () => {
      const egg = exportPterodactylEgg(TEMPLATE_CATALOG[0]!, { exportedAt: EXPORTED_AT });
      const { warnings } = importPterodactylEgg(
        { ...egg, hopper: { ...egg.hopper, version: 99 } },
        { group: 'Minecraft' },
      );

      expect(warnings.some((warning) => warning.includes('newer Hopper'))).toBe(true);
    });

    /**
     * The block is a claim the file makes about itself, and a file arrives from
     * wherever an administrator got it. Refused by the same schema that refuses
     * a bad egg, rather than trusted for having the right key in it.
     */
    it('refuses a block that does not hold what it says it holds', () => {
      const egg = exportPterodactylEgg(TEMPLATE_CATALOG[0]!, { exportedAt: EXPORTED_AT });

      expect(() =>
        importPterodactylEgg(
          { ...egg, hopper: { ...egg.hopper, stop: { type: 'rcon', command: 'quit' } } },
          { group: 'Minecraft' },
        ),
      ).toThrow();
    });
  });

  describe('unescapeRegExp', () => {
    it('is the inverse of what the importer escapes', () => {
      expect(unescapeRegExp('Done \\(')).toBe('Done (');
      expect(unescapeRegExp('\\[Server thread/INFO\\]: Done')).toBe('[Server thread/INFO]: Done');
    });

    it('leaves a backslash that was not an escape alone', () => {
      // `\d` is not something `escapeRegExp` can produce, so it came from an
      // administrator writing a real expression; stripping the backslash would
      // turn "a digit" into "the letter d".
      expect(unescapeRegExp('port \\d+ open')).toBe('port \\d+ open');
    });
  });
});
