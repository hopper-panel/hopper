import { PARSERS_NOT_WRITTEN, configParserSchema } from '@hopper/shared';
import { describe, expect, it } from 'vitest';
import { en } from '../i18n/messages/en';
import { fr } from '../i18n/messages/fr';
import type { TemplateDetail } from './api';
import { blankDraft, buildPayload, draftFromDetail, type TemplateDraft } from './template-draft';

/**
 * The translation between a form and the template API.
 *
 * Every case below is one the interface can produce and the type system cannot
 * see: a field left blank, a JSON block typed by hand, a structured stop half
 * filled in. Two of them are the difference between an edit that does what it
 * says and one that quietly does something else — sending `0` where the
 * operator meant "unset", and sending `null` to a route that refuses it.
 */

const DETAIL: TemplateDetail = {
  uuid: '3f7d0f4a-2c31-4b52-9c11-6d2b9e2f0a11',
  key: 'paper',
  group: { uuid: 'c4b6a5c8-2a1e-4c8f-9a52-2c2b0d5f7e10', name: 'Minecraft: Java Edition' },
  name: 'Paper',
  description: 'A Minecraft server.',
  author: 'Hopper',
  modifiedByAdmin: false,
  dockerImages: [{ name: 'Java 21', image: 'eclipse-temurin:21-jre-noble' }],
  startup: 'java -jar server.jar',
  stopCommand: 'command:stop',
  stop: null,
  stopTimeoutSeconds: null,
  startupDetection: ') Done (',
  readiness: null,
  configFiles: [
    {
      file: 'server.properties',
      parser: 'properties',
      replacements: [{ match: 'server-port', replaceWith: '{{server.build.default.port}}' }],
    },
  ],
  fileDenylist: ['server.jar'],
  installContainer: 'debian:bookworm-slim',
  installEntrypoint: '/bin/bash',
  installScript: '#!/bin/bash\necho hello\n',
  installInactivityTimeoutMs: null,
  installRequiredDiskBytes: null,
  importedFromEgg: null,
  serverCount: 2,
  variables: [
    {
      name: 'Version',
      description: '',
      envVariable: 'MC_VERSION',
      defaultValue: 'latest',
      userViewable: true,
      userEditable: true,
      rules: 'required|string',
    },
  ],
  createdAt: '2026-08-01T00:00:00.000Z',
  updatedAt: '2026-08-01T00:00:00.000Z',
};

function body(draft: TemplateDraft, mode: 'create' | 'update'): Record<string, unknown> {
  const result = buildPayload(draft, mode);

  if (!result.ok) {
    throw new Error(`expected a payload, got ${JSON.stringify(result.errors)}`);
  }

  return result.body;
}

describe('buildPayload', () => {
  /**
   * The one difference between the two verbs, and the reason this function
   * takes a mode at all.
   *
   * A PATCH leaves a field alone by omitting it, so an explicit `null` is the
   * only way to say "this template no longer declares a readiness strategy" —
   * and `createTemplateSchema` has no such thing to express and refuses one.
   * The same blank form therefore has to serialise two different ways.
   */
  it('clears a field on an edit and omits it on a creation', () => {
    const draft = draftFromDetail(DETAIL);

    const edited = body(draft, 'update');
    expect(edited.readiness).toBeNull();
    expect(edited.stop).toBeNull();
    expect(edited.stopTimeoutSeconds).toBeNull();
    expect(edited.installRequiredDiskBytes).toBeNull();

    const created = body(draft, 'create');
    expect('readiness' in created).toBe(false);
    expect('stop' in created).toBe(false);
    expect('stopTimeoutSeconds' in created).toBe(false);
    expect('installRequiredDiskBytes' in created).toBe(false);

    // And nothing else went missing with them: a create still carries every
    // field the schema requires.
    expect(created.key).toBe('paper');
    expect(created.startup).toBe('java -jar server.jar');
    expect(created.installScript).toBe('#!/bin/bash\necho hello\n');
  });

  /**
   * `Number('')` is 0, and 0 means something specific in all three of these
   * fields — a shutdown that waits no time, an installation allowed to stand
   * still for no time. The schemas refuse most of them, so the operator would
   * have been shown a validation error about a field they never touched.
   */
  it('reads a blank number as "declares none" rather than zero', () => {
    const draft = draftFromDetail(DETAIL);

    const sent = body(
      { ...draft, stopTimeoutSeconds: '', installInactivityTimeoutMs: '' },
      'update',
    );

    expect(sent.stopTimeoutSeconds).toBeNull();
    expect(sent.installInactivityTimeoutMs).toBeNull();
  });

  it('keeps a number that was typed', () => {
    const draft = draftFromDetail(DETAIL);

    const sent = body({ ...draft, stopTimeoutSeconds: '120' }, 'update');

    expect(sent.stopTimeoutSeconds).toBe(120);
  });

  /**
   * The field is typed by hand and reaches every existing server the moment it
   * is saved. An entry the contract cannot read is not a polite failure: the
   * whole-object parse fails, and every server on the template drops out of the
   * page its node is given.
   */
  it('refuses a configuration file the daemon could not read', () => {
    const draft = draftFromDetail(DETAIL);
    const result = buildPayload(
      { ...draft, configFiles: '[{"file":"server.properties","parser":"toml","replacements":[]}]' },
      'update',
    );

    expect(result.ok).toBe(false);

    if (!result.ok) {
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]?.field).toBe('configFiles');
      // The path of the entry, because "invalid" on a sixteen-line block is
      // not something anyone can act on.
      expect(result.errors[0]?.message).toContain('0.parser');
    }
  });

  /**
   * The refusal the contract cannot make.
   *
   * `xml` is a valid `ConfigParser`, so `configFileSchema` accepts it and the
   * test above never fires — which is exactly how it stayed acceptable here
   * while no daemon had ever written it. What follows a save is not an error
   * either: the file is left alone and the server starts on the port that file
   * already held.
   */
  it('refuses a parser the contract accepts and no daemon writes', () => {
    const draft = draftFromDetail(DETAIL);
    const result = buildPayload(
      { ...draft, configFiles: '[{"file":"server.xml","parser":"xml","replacements":[]}]' },
      'update',
    );

    expect(result.ok).toBe(false);

    if (!result.ok) {
      expect(result.errors[0]?.field).toBe('configFiles');
      // Named, because the author has to find it in the block they typed.
      expect(result.errors[0]?.message).toContain('server.xml');
    }
  });

  it('refuses JSON that is not JSON, against the field that holds it', () => {
    const draft = draftFromDetail(DETAIL);
    const result = buildPayload({ ...draft, readiness: '{ type: "port" }' }, 'update');

    expect(result.ok).toBe(false);

    if (!result.ok) {
      expect(result.errors[0]?.field).toBe('readiness');
    }
  });

  it('accepts a readiness strategy the contract knows', () => {
    const draft = draftFromDetail(DETAIL);

    const sent = body(
      { ...draft, readiness: '{"type":"port","role":"query","protocol":"udp"}' },
      'update',
    );

    // Parsed rather than relayed as a string, and the schema's own defaults
    // come with it — `delayMs` was never typed and is what the daemon will be
    // handed. No `timeoutMs` among them, which is the difference between a
    // start that can fail and one that cannot: the author declared no deadline.
    expect(sent.readiness).toEqual({ type: 'port', role: 'query', protocol: 'udp', delayMs: 0 });
  });

  it('sends an empty configuration list rather than nothing', () => {
    const draft = draftFromDetail(DETAIL);

    // An author who empties the field means "this template rewrites nothing",
    // which is a list of none — not a field left alone.
    expect(body({ ...draft, configFiles: '' }, 'update').configFiles).toEqual([]);
  });

  describe('the structured stop', () => {
    it('is absent when the template falls back to its stop command', () => {
      const draft = draftFromDetail(DETAIL);

      const sent = body({ ...draft, stopCommand: 'signal:SIGINT' }, 'update');

      expect(sent.stop).toBeNull();
      expect(sent.stopCommand).toBe('signal:SIGINT');
    });

    it('names no port when none was given', () => {
      const draft = draftFromDetail(DETAIL);

      const sent = body(
        {
          ...draft,
          stop: {
            type: 'rcon',
            command: '',
            signal: 'SIGTERM',
            rconCommand: 'quit',
            // The common case: RCON on the game port itself.
            rconRole: '',
            rconSecretVariable: 'RCON_PASSWORD',
          },
        },
        'update',
      );

      // `allocationRoleSchema` refuses `''`, so an empty box has to become an
      // absent key rather than an empty one.
      expect(sent.stop).toEqual({
        type: 'rcon',
        command: 'quit',
        secretVariable: 'RCON_PASSWORD',
      });
    });

    it('carries the port name when one was given', () => {
      const draft = draftFromDetail(DETAIL);

      const sent = body(
        {
          ...draft,
          stop: {
            type: 'rcon',
            command: '',
            signal: 'SIGTERM',
            rconCommand: 'quit',
            rconRole: 'rcon',
            rconSecretVariable: 'RCON_PASSWORD',
          },
        },
        'update',
      );

      expect(sent.stop).toEqual({
        type: 'rcon',
        command: 'quit',
        role: 'rcon',
        secretVariable: 'RCON_PASSWORD',
      });
    });

    it('round-trips a signal stop through the form', () => {
      const draft = draftFromDetail({ ...DETAIL, stop: { type: 'signal', value: 'SIGINT' } });

      expect(draft.stop.type).toBe('signal');
      expect(draft.stop.signal).toBe('SIGINT');
      expect(body(draft, 'update').stop).toEqual({ type: 'signal', value: 'SIGINT' });
    });
  });

  describe('the Docker images', () => {
    it('drops a row that was added and left alone', () => {
      const draft = draftFromDetail(DETAIL);

      const sent = body(
        { ...draft, dockerImages: [...draft.dockerImages, { name: '', image: '' }] },
        'update',
      );

      expect(sent.dockerImages).toEqual([
        { name: 'Java 21', image: 'eclipse-temurin:21-jre-noble' },
      ]);
    });

    it('refuses a template with no image at all', () => {
      const draft = draftFromDetail(DETAIL);
      const result = buildPayload({ ...draft, dockerImages: [] }, 'update');

      expect(result.ok).toBe(false);

      if (!result.ok) {
        expect(result.errors[0]?.field).toBe('dockerImages');
      }
    });
  });

  it('turns the protected files back into a list', () => {
    const draft = draftFromDetail(DETAIL);

    const sent = body({ ...draft, fileDenylist: 'server.jar\n\n  eula.txt  \n' }, 'update');

    expect(sent.fileDenylist).toEqual(['server.jar', 'eula.txt']);
  });

  it('does not send the key React orders the variable rows by', () => {
    const draft = draftFromDetail(DETAIL);

    const variables = body(draft, 'update').variables as Record<string, unknown>[];

    expect(variables).toHaveLength(1);
    expect('rowId' in (variables[0] ?? {})).toBe(false);
    expect(variables[0]?.envVariable).toBe('MC_VERSION');
  });

  /**
   * The order of the array is the order the API writes `sort` from, so a move
   * in the interface is a reorder of this list and nothing else.
   */
  it('sends the variables in the order the form holds them', () => {
    const draft = draftFromDetail({
      ...DETAIL,
      variables: [
        { ...DETAIL.variables[0]!, envVariable: 'FIRST' },
        { ...DETAIL.variables[0]!, envVariable: 'SECOND' },
      ],
    });

    const reordered = { ...draft, variables: [draft.variables[1]!, draft.variables[0]!] };
    const variables = body(reordered, 'update').variables as { envVariable: string }[];

    expect(variables.map((variable) => variable.envVariable)).toEqual(['SECOND', 'FIRST']);
  });

  /**
   * A new template starts on the definition schema's own defaults rather than
   * blank, so that creating one is answering the questions only the author can
   * answer — not rediscovering that installs happen in Debian.
   */
  it('starts a new template on something a server could actually install from', () => {
    const draft = blankDraft('Rust');
    const result = buildPayload(
      {
        ...draft,
        key: 'rust',
        name: 'Rust',
        startup: './RustDedicated',
        installScript: 'echo',
        dockerImages: [{ name: 'Rust', image: 'ghcr.io/hopper-panel/source:latest' }],
      },
      'create',
    );

    expect(result.ok).toBe(true);

    if (result.ok) {
      expect(result.body.group).toBe('Rust');
      expect(result.body.installContainer).toBe('debian:bookworm-slim');
      expect(result.body.installEntrypoint).toBe('/bin/bash');
      expect(result.body.stopCommand).toBe('command:stop');
    }
  });
});

/**
 * The parsers an author is told about, and the ones the form accepts.
 *
 * Two lists of the same fact in different forms — a constant in the contract
 * and a sentence in five languages — and the sentence is what an administrator
 * acts on. It cannot be derived from the constant without turning a translated
 * paragraph into a template, so it is held to it instead: the hint may not
 * name a parser nothing writes, and may not omit one that works.
 *
 * `xml` sat in that sentence for six releases while the daemon refused it.
 */
describe('the parsers the editor tells an author about', () => {
  const written = configParserSchema.options.filter(
    (parser) => !PARSERS_NOT_WRITTEN.includes(parser),
  );

  it.each([
    ['en', en['adminTemplate.configFilesHint']],
    ['fr', fr['adminTemplate.configFilesHint']!],
  ])('names every parser that works, in %s', (_language, hint) => {
    for (const parser of written) {
      expect(hint, `${parser} works and the hint does not mention it`).toContain(parser);
    }
  });

  it.each([
    ['en', en['adminTemplate.configFilesHint']],
    ['fr', fr['adminTemplate.configFilesHint']!],
  ])('names no parser that nothing writes, in %s', (_language, hint) => {
    for (const parser of PARSERS_NOT_WRITTEN) {
      expect(hint, `${parser} is offered and the form refuses it`).not.toContain(parser);
    }
  });
});
