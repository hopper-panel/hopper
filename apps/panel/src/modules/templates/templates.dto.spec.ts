import { describe, expect, it } from 'vitest';
import {
  createTemplateGroupSchema,
  createTemplateSchema,
  updateTemplateGroupSchema,
  updateTemplateSchema,
} from './templates.dto.js';

/**
 * What a PATCH is allowed to mean.
 *
 * The whole editor rests on one property of these schemas: a field the request
 * did not carry has to come out of the pipe as `undefined`, because that is how
 * the service tells "leave this alone" from "clear this". Nothing downstream
 * can recover the distinction once it is lost, and losing it is quiet — the
 * template simply comes back with fewer variables than it went in with.
 */

const creation = (fields: Record<string, unknown> = {}) => ({
  key: 'my-egg',
  group: 'Tests',
  name: 'My egg',
  dockerImages: [{ name: 'Java 21', image: 'eclipse-temurin:21-jre-noble' }],
  startup: './start.sh',
  installScript: 'set -e',
  ...fields,
});

describe('updateTemplateSchema', () => {
  it('produces nothing at all from an empty request', () => {
    // `.partial()` on its own does not do this. A `ZodDefault` in Zod 4 still
    // fills itself in when the key is missing, optional or not, so the empty
    // object came back carrying `author: 'Hopper'`, `configFiles: []`,
    // `fileDenylist: []` and `variables: []` — a PATCH that blanked the author,
    // dropped every configuration file and deleted every variable.
    expect(updateTemplateSchema.parse({})).toEqual({});
  });

  it('carries only the fields the request named', () => {
    expect(updateTemplateSchema.parse({ name: 'Renamed' })).toEqual({ name: 'Renamed' });
  });

  it('keeps an explicit null distinct from an absent field', () => {
    // The only way to say "this template no longer declares a stop", which is
    // a different template from one whose stop was not mentioned.
    expect(updateTemplateSchema.parse({ stop: null })).toEqual({ stop: null });
    expect(updateTemplateSchema.parse({ readiness: null })).toEqual({ readiness: null });
    expect(updateTemplateSchema.parse({ stopTimeoutSeconds: null })).toEqual({
      stopTimeoutSeconds: null,
    });
  });

  it('keeps the bounds the definition declares', () => {
    // Unwrapped off `templateDefinitionSchema` rather than restated, so the
    // ten-minute cap on a stop deadline lives in one place.
    expect(updateTemplateSchema.safeParse({ stopTimeoutSeconds: 600 }).success).toBe(true);
    expect(updateTemplateSchema.safeParse({ stopTimeoutSeconds: 601 }).success).toBe(false);
    expect(updateTemplateSchema.safeParse({ key: 'Not A Key' }).success).toBe(false);
    expect(updateTemplateSchema.safeParse({ dockerImages: [] }).success).toBe(false);
  });

  it('refuses to blank the install container or its entrypoint', () => {
    // The bound is `serverConfigurationSchema`'s, not this schema's:
    // `containerImage` and `entrypoint` are `.min(1)` there, so an empty one
    // fails the **whole-payload** parse and `buildForNode` drops every server on
    // this template out of its node's page — consoles answering "server unknown
    // to this node", power actions failing, containers still running. The
    // install block is read live, so it lands as soon as each daemon fetches.
    //
    // A `ZodDefault` substitutes only on `undefined`, which is why `''` reached
    // the column on both verbs before this: measured, an update setting
    // `installContainer: ''` was accepted and described zero servers.
    expect(updateTemplateSchema.safeParse({ installContainer: '' }).success).toBe(false);
    expect(updateTemplateSchema.safeParse({ installEntrypoint: '' }).success).toBe(false);
    expect(createTemplateSchema.safeParse(creation({ installContainer: '' })).success).toBe(false);
    expect(createTemplateSchema.safeParse(creation({ installEntrypoint: '' })).success).toBe(false);
  });

  it('still fills both in when the request names neither', () => {
    // Narrowing the inner type must not cost the default: a creation that says
    // nothing about the install container still installs in Debian.
    expect(createTemplateSchema.parse(creation())).toMatchObject({
      installContainer: 'debian:bookworm-slim',
      installEntrypoint: '/bin/bash',
    });
  });

  it.each([
    ['a bare game command', 'quit'],
    ['an empty string', ''],
    ['a transport with no value', 'command:'],
    ['a signal the contract does not carry', 'signal:SIGUSR1'],
    ['a lone separator', ':'],
  ])('refuses %s as a stop command', (_case, stopCommand) => {
    // The field a cleared `stop` falls back to, and the one neither new gate
    // watches. `parseStopCommand` reads every one of these as SIGTERM without
    // saying so, so an operator moving a template off RCON and typing the game's
    // own command got signal-then-SIGKILL on every existing server, live.
    expect(updateTemplateSchema.safeParse({ stopCommand }).success).toBe(false);
    expect(createTemplateSchema.safeParse(creation({ stopCommand })).success).toBe(false);
  });

  it.each(['command:stop', 'command:/quit', 'command:end', 'signal:SIGTERM', 'signal:SIGKILL'])(
    'accepts %s, which the catalogue already ships',
    (stopCommand) => {
      // The same pattern `catalog.spec.ts` asserts of every shipped template,
      // Factorio's slash included: this refuses nothing the catalogue produces.
      expect(updateTemplateSchema.safeParse({ stopCommand }).success).toBe(true);
    },
  );

  it('holds a template to the same lengths its group is held to', () => {
    // `resolveGroup` creates a group from `group`, so this route writes rows
    // into the table `createTemplateGroupSchema` guards — and it accepted five
    // thousand characters where that schema stops at a hundred. Same table, one
    // bound.
    expect(updateTemplateSchema.safeParse({ group: 'g'.repeat(101) }).success).toBe(false);
    expect(updateTemplateSchema.safeParse({ group: 'g'.repeat(100) }).success).toBe(true);
    expect(updateTemplateSchema.safeParse({ name: 'n'.repeat(101) }).success).toBe(false);
    expect(updateTemplateSchema.safeParse({ description: 'd'.repeat(1001) }).success).toBe(false);
    expect(updateTemplateSchema.safeParse({ author: 'a'.repeat(101) }).success).toBe(false);
    expect(createTemplateSchema.safeParse(creation({ group: 'g'.repeat(101) })).success).toBe(
      false,
    );
  });

  it('keeps the disk requirement inside what a JSON number carries exactly', () => {
    // The column is a `BigInt` and `main.ts` patches `BigInt.prototype.toJSON`
    // to a `Number`, so the detail view hands the browser a number and the
    // editor posts that number straight back. Zod's `.int()` is a safe-integer
    // check, which is what makes the round trip exact rather than nearly exact:
    // nothing above 2^53-1 can be stored, so no stored value can be rounded on
    // the way out.
    expect(
      updateTemplateSchema.safeParse({ installRequiredDiskBytes: 9_007_199_254_740_991 }),
    ).toMatchObject({ success: true });
    expect(
      updateTemplateSchema.safeParse({ installRequiredDiskBytes: 9_007_199_254_740_992 }).success,
    ).toBe(false);
    // Above a 32-bit integer, which is the whole reason the column is a BigInt.
    expect(
      updateTemplateSchema.safeParse({ installRequiredDiskBytes: 3_000_000_000 }).success,
    ).toBe(true);
  });

  it('refuses a config file the daemon could not parse', () => {
    // `configFileSchema` comes from `@hopper/shared` through the definition, so
    // the editor and the daemon agree by construction. Worth a test all the
    // same: the cost of disagreeing is not a rejected field but a whole server
    // dropped from its node's page, and this route is the only producer that
    // could ever send one.
    expect(
      updateTemplateSchema.safeParse({
        configFiles: [{ file: 'server.toml', parser: 'toml', replacements: [] }],
      }).success,
    ).toBe(false);
  });

  it('keeps the Docker images in the order the request sent them', () => {
    // Position is meaning: `ServersService` offers the first as the default at
    // creation. A write that reordered them would change what the next server
    // runs, without touching a field anybody named.
    expect(
      updateTemplateSchema.parse({
        dockerImages: [
          { name: 'Java 8', image: 'eclipse-temurin:8-jre' },
          { name: 'Java 21', image: 'eclipse-temurin:21-jre-noble' },
        ],
      }).dockerImages,
    ).toEqual([
      { name: 'Java 8', image: 'eclipse-temurin:8-jre' },
      { name: 'Java 21', image: 'eclipse-temurin:21-jre-noble' },
    ]);
  });

  it('validates a structured stop against the contract the daemon reads', () => {
    // The same schema, reached through the definition: what the editor accepts
    // and what the daemon can parse cannot drift apart.
    expect(
      updateTemplateSchema.safeParse({
        stop: { type: 'rcon', command: 'quit', secretVariable: 'RCON_PASSWORD' },
      }).success,
    ).toBe(true);
    expect(updateTemplateSchema.safeParse({ stop: { type: 'rcon' } }).success).toBe(false);
    expect(updateTemplateSchema.safeParse({ stop: { type: 'telnet' } }).success).toBe(false);
  });

  it("fills a variable's unstated fields, because a variable is sent whole", () => {
    // The defaults inside a variable stay: the list is replaced as a whole, so
    // a variable arriving without `rules` is a new variable that named none,
    // not a field somebody declined to touch.
    expect(
      updateTemplateSchema.parse({ variables: [{ name: 'Version', envVariable: 'VERSION' }] })
        .variables,
    ).toEqual([
      {
        name: 'Version',
        description: '',
        envVariable: 'VERSION',
        defaultValue: '',
        userViewable: true,
        userEditable: false,
        rules: 'nullable|string',
      },
    ]);
  });
});

describe('createTemplateSchema', () => {
  it("applies the definition's defaults, which a creation does want", () => {
    expect(createTemplateSchema.parse(creation())).toMatchObject({
      description: '',
      author: 'Hopper',
      stopCommand: 'command:stop',
      installContainer: 'debian:bookworm-slim',
      variables: [],
    });
  });

  it('drops a provenance the request tried to claim', () => {
    // `importedFromEgg` records where a template came from. An editor able to
    // set it would let an administrator assert an origin the panel never saw.
    expect(createTemplateSchema.parse(creation({ importedFromEgg: 'made-up' }))).not.toHaveProperty(
      'importedFromEgg',
    );
  });
});

describe('the group schemas', () => {
  it('defaults on creation and stays silent on a PATCH', () => {
    expect(createTemplateGroupSchema.parse({ name: 'Tests' })).toEqual({
      name: 'Tests',
      description: '',
      author: '',
    });
    expect(updateTemplateGroupSchema.parse({ author: 'Me' })).toEqual({ author: 'Me' });
  });
});
