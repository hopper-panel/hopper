import {
  PARSERS_NOT_WRITTEN,
  configFileSchema,
  readinessSchema,
  type StopConfiguration,
} from '@hopper/shared';
import type { TemplateDetail, TemplateVariableDetail } from './api';

/**
 * A template as a form holds it, and the translation back.
 *
 * Kept out of the components and free of React on purpose: every field below
 * that is not a plain string is a place where a form can produce something the
 * API will refuse, and the interesting ones are refused by nobody. A blank
 * number field has to become "this template declares none" rather than zero; a
 * structured stop has to disappear entirely rather than arrive half-filled; two
 * of the fields are JSON typed by hand. None of that is testable through a
 * rendered page without pretending to be a browser, and all of it is testable
 * here.
 *
 * Strings everywhere a number or an object will end up, because that is what an
 * `<input>` holds. The conversion happens once, in `buildPayload`, which is
 * also the only place that knows the difference between creating and editing.
 */

export interface DockerImageDraft {
  name: string;
  image: string;
}

export interface VariableDraft extends TemplateVariableDetail {
  /**
   * Stable across reordering, and never sent.
   *
   * A variable has no identity of its own — the API replaces the whole list on
   * every save and derives `sort` from the position in the array — so React
   * needs something to key rows by that survives a move. An index does not: it
   * renumbers the rows under the moved one and takes their focus and cursor
   * position with it.
   */
  rowId: number;
}

/** `''` means the template declares no structured stop and falls back to `stopCommand`. */
export interface StopDraft {
  type: '' | 'command' | 'signal' | 'rcon';
  /** `command` and `signal` both carry one value; kept apart so switching type keeps both. */
  command: string;
  signal: 'SIGTERM' | 'SIGINT' | 'SIGKILL';
  rconCommand: string;
  rconRole: string;
  rconSecretVariable: string;
}

export interface TemplateDraft {
  key: string;
  group: string;
  name: string;
  description: string;
  author: string;

  dockerImages: DockerImageDraft[];
  startup: string;

  stopCommand: string;
  stop: StopDraft;
  stopTimeoutSeconds: string;
  startupDetection: string;
  /** Pretty-printed JSON, or `''` for "declares none". */
  readiness: string;

  /** Pretty-printed JSON array. */
  configFiles: string;
  /** One path per line. */
  fileDenylist: string;

  installContainer: string;
  installEntrypoint: string;
  installScript: string;
  installInactivityTimeoutMs: string;
  installRequiredDiskBytes: string;

  variables: VariableDraft[];
}

const EMPTY_STOP: StopDraft = {
  type: '',
  command: '',
  signal: 'SIGTERM',
  rconCommand: '',
  rconRole: '',
  rconSecretVariable: '',
};

/**
 * What a new template starts as.
 *
 * The defaults are the definition schema's own, spelled out rather than left
 * blank for the server to fill in: a form whose install container is empty
 * looks like a field the author is expected to know the answer to, and the
 * answer is the one every shipped template uses.
 */
export function blankDraft(group: string): TemplateDraft {
  return {
    key: '',
    group,
    name: '',
    description: '',
    author: '',
    dockerImages: [{ name: '', image: '' }],
    startup: '',
    stopCommand: 'command:stop',
    stop: { ...EMPTY_STOP },
    stopTimeoutSeconds: '',
    startupDetection: '',
    readiness: '',
    configFiles: '[]',
    fileDenylist: '',
    installContainer: 'debian:bookworm-slim',
    installEntrypoint: '/bin/bash',
    installScript: '',
    installInactivityTimeoutMs: '',
    installRequiredDiskBytes: '',
    variables: [],
  };
}

export function draftFromDetail(template: TemplateDetail): TemplateDraft {
  return {
    key: template.key,
    group: template.group.name,
    name: template.name,
    description: template.description,
    author: template.author,
    dockerImages: template.dockerImages.map((image) => ({ ...image })),
    startup: template.startup,
    stopCommand: template.stopCommand,
    stop: stopDraftOf(template.stop),
    stopTimeoutSeconds: numberDraft(template.stopTimeoutSeconds),
    startupDetection: template.startupDetection ?? '',
    readiness: template.readiness ? JSON.stringify(template.readiness, null, 2) : '',
    configFiles: JSON.stringify(template.configFiles, null, 2),
    fileDenylist: template.fileDenylist.join('\n'),
    installContainer: template.installContainer,
    installEntrypoint: template.installEntrypoint,
    installScript: template.installScript,
    installInactivityTimeoutMs: numberDraft(template.installInactivityTimeoutMs),
    installRequiredDiskBytes: numberDraft(template.installRequiredDiskBytes),
    variables: template.variables.map((variable, index) => ({ ...variable, rowId: index })),
  };
}

function numberDraft(value: number | null): string {
  return value === null ? '' : String(value);
}

function stopDraftOf(stop: StopConfiguration | null): StopDraft {
  if (!stop) {
    return { ...EMPTY_STOP };
  }

  if (stop.type === 'command') {
    return { ...EMPTY_STOP, type: 'command', command: stop.value };
  }

  if (stop.type === 'signal') {
    return { ...EMPTY_STOP, type: 'signal', signal: stop.value };
  }

  return {
    ...EMPTY_STOP,
    type: 'rcon',
    rconCommand: stop.command,
    rconRole: stop.role ?? '',
    rconSecretVariable: stop.secretVariable,
  };
}

/** A field of the draft, and what is wrong with it — shown against the field. */
export interface DraftError {
  field:
    | 'readiness'
    | 'configFiles'
    | 'stopTimeoutSeconds'
    | 'installInactivityTimeoutMs'
    | 'installRequiredDiskBytes'
    | 'dockerImages';
  message: string;
}

export type BuildResult =
  { ok: true; body: Record<string, unknown> } | { ok: false; errors: DraftError[] };

const configFilesSchema = configFileSchema.array();

/**
 * The one method this file needs off a Zod schema.
 *
 * Structural rather than `z.ZodType`, because `zod` is not a dependency of the
 * web package and should not become one to spell a parameter: the schemas
 * themselves arrive through `@hopper/shared`, which is where the contract
 * belongs, and this is the shape their `safeParse` already has.
 */
interface Parser<T> {
  safeParse(
    value: unknown,
  ):
    | { success: true; data: T }
    | { success: false; error: { issues: { path: PropertyKey[]; message: string }[] } };
}

/**
 * The draft as the API takes it.
 *
 * Two things happen here that nothing else in the panel has to do.
 *
 * The first is the difference between **omitting** a field and sending `null`.
 * A PATCH says "leave this alone" by leaving the key out, so the only way to
 * say "this template no longer declares a readiness strategy" is an explicit
 * `null` — and the create schema, which has no such thing to express, refuses
 * one. The same draft therefore has to serialise two different ways, and the
 * only difference is that the nulls are dropped on the way to a POST.
 *
 * The second is that two fields are typed as JSON by hand. They are validated
 * here against the very schemas `@hopper/shared` hands the daemon, before
 * anything is sent, because a `configFiles` entry the contract cannot read does
 * not fail politely: `ServerConfigurationService` fails the whole-object parse,
 * `buildForNode` catches it per server, and every server on this template drops
 * out of the page its node is given — consoles answering "server unknown to
 * this node" while the containers go on running. The API refuses it too. This
 * refuses it a round trip earlier, against a form field, with the path of the
 * entry that is wrong.
 */
export function buildPayload(draft: TemplateDraft, mode: 'create' | 'update'): BuildResult {
  const errors: DraftError[] = [];

  const readiness = parseJsonField(draft.readiness, readinessSchema, 'readiness', errors);
  const configFiles = parseJsonField(
    draft.configFiles,
    configFilesSchema,
    'configFiles',
    errors,
    [],
  );

  const stopTimeoutSeconds = parseNumberField(
    draft.stopTimeoutSeconds,
    'stopTimeoutSeconds',
    errors,
  );
  const installInactivityTimeoutMs = parseNumberField(
    draft.installInactivityTimeoutMs,
    'installInactivityTimeoutMs',
    errors,
  );
  const installRequiredDiskBytes = parseNumberField(
    draft.installRequiredDiskBytes,
    'installRequiredDiskBytes',
    errors,
  );

  // A row an author added and left alone is not an image they meant to declare.
  // Dropped rather than refused, so that clicking "add" and changing your mind
  // is not an error message.
  const dockerImages = draft.dockerImages.filter(
    (image) => image.name.trim() !== '' || image.image.trim() !== '',
  );

  if (dockerImages.length === 0) {
    errors.push({ field: 'dockerImages', message: 'A template needs at least one Docker image.' });
  }

  // A parser the contract accepts and no daemon writes. The API refuses this
  // too; refusing it here names the file against the field the author is
  // looking at, a round trip earlier. It is not the schema's job — the value is
  // a valid `ConfigParser`, which is exactly why it got this far unremarked.
  const unwritten = (configFiles ?? []).filter((file) => PARSERS_NOT_WRITTEN.includes(file.parser));

  if (unwritten.length > 0) {
    errors.push({
      field: 'configFiles',
      message: `No daemon writes the ${unwritten[0]!.parser} parser, so ${unwritten
        .map((file) => `"${file.file}"`)
        .join(
          ', ',
        )} would be left exactly as it is — including whatever this template means to write into it, the allocated port most likely among them.`,
    });
  }

  if (errors.length > 0) {
    return { ok: false, errors };
  }

  const body: Record<string, unknown> = {
    key: draft.key.trim(),
    group: draft.group,
    name: draft.name.trim(),
    description: draft.description,
    author: draft.author,
    dockerImages: dockerImages.map((image) => ({
      name: image.name.trim(),
      image: image.image.trim(),
    })),
    startup: draft.startup,
    stopCommand: draft.stopCommand.trim(),
    stop: stopOf(draft.stop),
    stopTimeoutSeconds,
    startupDetection: draft.startupDetection.trim() === '' ? null : draft.startupDetection,
    readiness,
    configFiles,
    fileDenylist: draft.fileDenylist
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line !== ''),
    installContainer: draft.installContainer.trim(),
    installEntrypoint: draft.installEntrypoint.trim(),
    installScript: draft.installScript,
    installInactivityTimeoutMs,
    installRequiredDiskBytes,
    variables: draft.variables.map((variable) => ({
      name: variable.name,
      description: variable.description,
      envVariable: variable.envVariable.trim(),
      defaultValue: variable.defaultValue,
      userViewable: variable.userViewable,
      userEditable: variable.userEditable,
      rules: variable.rules,
    })),
  };

  if (mode === 'create') {
    for (const [field, value] of Object.entries(body)) {
      if (value === null) {
        delete body[field];
      }
    }
  }

  return { ok: true, body };
}

function stopOf(stop: StopDraft): StopConfiguration | null {
  if (stop.type === 'command') {
    return { type: 'command', value: stop.command };
  }

  if (stop.type === 'signal') {
    return { type: 'signal', value: stop.signal };
  }

  if (stop.type === 'rcon') {
    return {
      type: 'rcon',
      command: stop.rconCommand,
      // Absent rather than empty: `allocationRoleSchema` refuses `''`, and an
      // RCON stop naming no port means the primary one — which is the common
      // case and has to stay expressible.
      ...(stop.rconRole.trim() === '' ? {} : { role: stop.rconRole.trim() }),
      secretVariable: stop.rconSecretVariable.trim(),
    };
  }

  return null;
}

function parseJsonField<T>(
  raw: string,
  schema: Parser<T>,
  field: DraftError['field'],
  errors: DraftError[],
  whenEmpty: T | null = null,
): T | null {
  if (raw.trim() === '') {
    return whenEmpty;
  }

  let parsed: unknown;

  try {
    parsed = JSON.parse(raw);
  } catch (error: unknown) {
    errors.push({ field, message: error instanceof Error ? error.message : 'Invalid JSON.' });
    return null;
  }

  const result = schema.safeParse(parsed);

  if (!result.success) {
    errors.push({
      field,
      message: result.error.issues
        .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
        .join(' — '),
    });
    return null;
  }

  return result.data;
}

/**
 * A blank number field is "declares none", and a number field is not the same
 * question as a blank one.
 *
 * `Number('')` is 0, which is why this is not a one-liner: every one of these
 * fields means something specific at zero — a stop timeout of zero seconds, an
 * installation allowed to stand still for no time at all — and the schemas
 * refuse most of them, so the operator would have got a validation error out of
 * a field they never touched.
 */
function parseNumberField(
  raw: string,
  field: DraftError['field'],
  errors: DraftError[],
): number | null {
  if (raw.trim() === '') {
    return null;
  }

  const value = Number(raw);

  if (!Number.isFinite(value)) {
    errors.push({ field, message: 'Not a number.' });
    return null;
  }

  return value;
}
