import { templateDefinitionSchema } from '@hopper/templates';
import { z } from 'zod';

/**
 * What an administrator may write to a template.
 *
 * Built out of `templateDefinitionSchema` rather than beside it. That schema is
 * the shape the shipped catalogue and the egg importer already produce, and it
 * is the shape `templateColumns` maps to rows — a second description of a
 * template here would be a second set of bounds to keep in step, and the one
 * that drifts is always the one only the editor uses. `stop`, `readiness` and
 * `configFiles` come from `@hopper/shared` through it, so what the editor
 * accepts and what the daemon can read are the same thing by construction.
 */

/**
 * The same field with a tighter inner type and its default kept.
 *
 * `ZodDefault.unwrap()` hands back the string the default wraps; tightening
 * that and re-defaulting with the value the definition already declares keeps
 * the default in one place. `withoutDefaults` below unwraps this again for the
 * PATCH schema, and the tightening comes with it — which is the whole point,
 * since every hole closed here was open on both verbs.
 */
function tightened(
  field: z.ZodDefault<z.ZodString>,
  tighten: (inner: z.ZodString) => z.ZodString,
): z.ZodDefault<z.ZodString> {
  return tighten(field.unwrap()).default(field.def.defaultValue);
}

/**
 * What the daemon's own contract requires of an install container.
 *
 * `templateDefinitionSchema` leaves both of these as bare strings because
 * nothing ever hand-wrote them: the catalogue and the egg importer are the only
 * two producers and neither can emit an empty one. This route can, and a
 * `ZodDefault` substitutes only on `undefined` — so `''` survives create, and
 * `withoutDefaults` unwrapping to a bare string means it survives PATCH too.
 *
 * What an empty one does is out of all proportion to the typo that produces it.
 * `serverConfigurationSchema` declares `containerImage: z.string().min(1)` and
 * `entrypoint: z.string().min(1)`, so the built payload fails **the whole-object
 * parse** — the same failure `parseConfigFiles` describes for an unreadable
 * config file, and with the same consequence: `buildForNode` catches it per
 * server, and every server on this template drops out of the page its node is
 * given. Their consoles answer "server unknown to this node", their power
 * actions fail, and their containers go on running with nothing driving them.
 * The install block is read live, so it lands the moment each daemon next
 * fetches. Measured, before this bound existed: an update setting
 * `installContainer: ''` was accepted, written, and described zero servers.
 *
 * Refused here rather than in `definition.ts` so that no catalogue row or
 * imported egg is put at risk by a bound only the editor needs.
 */
const nonEmpty = (field: z.ZodDefault<z.ZodString>) => tightened(field, (inner) => inner.min(1));

/**
 * The two words `parseStopCommand` understands, and nothing else.
 *
 * The branch builds two gates around the structured `stop` — the node
 * capability and the per-server role and secret — and clearing `stop` drops the
 * server back onto this string. It was validated nowhere.
 * `ServerConfigurationService.parseStopCommand` reads anything it does not
 * recognise as `signal:SIGTERM`, silently: an operator moving a Rust or ARK
 * template off RCON and typing the game's own command — `quit`, the plausible
 * mistake — got a signal-then-SIGKILL on every existing server, live, with no
 * refusal and an audit entry saying only `changed: ["stop","stopCommand"]`.
 * `command:` with nothing after it and `signal:SIGUSR1` land on SIGTERM the same
 * way.
 *
 * The pattern is the one `catalog.spec.ts` already asserts of every shipped
 * template, so this refuses nothing the catalogue can produce.
 */
const stopCommandPattern = /^(command:.+|signal:SIG(TERM|INT|KILL))$/;

/**
 * `importedFromEgg` is deliberately absent: it records where a template came
 * from, and an editor that could set it would let an administrator claim a
 * provenance the panel never observed. The update path carries the existing
 * value across untouched.
 *
 * The `.extend` below is not a second description of a template — every field
 * in it is the definition's own, narrowed. The lengths are the ones
 * `createTemplateGroupSchema` already imposes on the very same columns:
 * `resolveGroup` **creates** a group from `group`, so a template route that
 * accepted five thousand characters there was writing rows the group route
 * would have refused, into the table it owns.
 */
export const createTemplateSchema = templateDefinitionSchema
  .omit({ importedFromEgg: true })
  .extend({
    group: templateDefinitionSchema.shape.group.max(100),
    name: templateDefinitionSchema.shape.name.max(100),
    description: tightened(templateDefinitionSchema.shape.description, (inner) => inner.max(1000)),
    author: tightened(templateDefinitionSchema.shape.author, (inner) => inner.max(100)),
    stopCommand: tightened(templateDefinitionSchema.shape.stopCommand, (inner) =>
      inner.regex(
        stopCommandPattern,
        'A stop command is "command:<what to type>" or "signal:SIGTERM", "signal:SIGINT" or "signal:SIGKILL". Anything else is read as SIGTERM.',
      ),
    ),
    installContainer: nonEmpty(templateDefinitionSchema.shape.installContainer),
    installEntrypoint: nonEmpty(templateDefinitionSchema.shape.installEntrypoint),
  });

/**
 * The same fields with their defaults taken off.
 *
 * `.partial()` alone is not enough, and the way it falls short is silent: in
 * Zod 4 a `ZodDefault` still fills itself in when the key is missing, optional
 * or not. `updateTemplateSchema.parse({ name: 'X' })` therefore came back
 * carrying `author: 'Hopper'`, `configFiles: []`, `fileDenylist: []` and
 * `variables: []` — a rename that also blanked the author, dropped every
 * configuration file and deleted every variable of the template. A default is
 * an answer to "the caller said nothing", and on a PATCH the answer to that is
 * "then change nothing".
 */
type WithoutDefaults<T extends z.ZodRawShape> = {
  [K in keyof T]: T[K] extends z.ZodDefault<infer Inner> ? Inner : T[K];
};

function withoutDefaults<T extends z.ZodRawShape>(shape: T): WithoutDefaults<T> {
  return Object.fromEntries(
    Object.entries(shape).map(([key, field]) => [
      key,
      field instanceof z.ZodDefault ? field.unwrap() : field,
    ]),
  ) as WithoutDefaults<T>;
}

/**
 * The definition's own field, plus an explicit `null`.
 *
 * A PATCH says "leave this alone" by omitting a field, which leaves nothing to
 * say "this template no longer declares one" with — and the two are different
 * behaviours, not different spellings: clearing `stop` sends the server back to
 * its `stopCommand`, clearing `readiness` sends it back to the console pattern.
 * Taken off the definition schema by unwrapping rather than restated, so that
 * the bounds stay declared once: `stopTimeoutSeconds` is capped at 600 seconds
 * in exactly one place.
 */
function clearable<T extends z.ZodType>(field: z.ZodOptional<T>) {
  return field.unwrap().nullish();
}

export const updateTemplateSchema = z
  .object(withoutDefaults(createTemplateSchema.shape))
  .partial()
  .extend({
    stop: clearable(templateDefinitionSchema.shape.stop),
    readiness: clearable(templateDefinitionSchema.shape.readiness),
    stopTimeoutSeconds: clearable(templateDefinitionSchema.shape.stopTimeoutSeconds),
    startupDetection: clearable(templateDefinitionSchema.shape.startupDetection),
    installInactivityTimeoutMs: clearable(
      templateDefinitionSchema.shape.installInactivityTimeoutMs,
    ),
    installRequiredDiskBytes: clearable(templateDefinitionSchema.shape.installRequiredDiskBytes),
  });

export const createTemplateGroupSchema = z.object({
  name: z.string().min(1).max(100),
  description: z.string().max(1000).default(''),
  author: z.string().max(100).default(''),
});

/** Same reasoning as above: the defaults belong to the creation, not to a PATCH. */
export const updateTemplateGroupSchema = z
  .object(withoutDefaults(createTemplateGroupSchema.shape))
  .partial();

export type CreateTemplateDto = z.infer<typeof createTemplateSchema>;
export type UpdateTemplateDto = z.infer<typeof updateTemplateSchema>;
export type CreateTemplateGroupDto = z.infer<typeof createTemplateGroupSchema>;
export type UpdateTemplateGroupDto = z.infer<typeof updateTemplateGroupSchema>;
