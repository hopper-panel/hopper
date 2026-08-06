/**
 * Building a server's startup command.
 *
 * This is the most sensitive point in the daemon: the template comes from a
 * template, and the variable values come partly from the user. A naive
 * concatenation followed by `sh -c` would give anyone who can edit a variable
 * the ability to run anything inside the container.
 *
 * The defence is one rule: **split first, substitute second.**
 *
 *   1. The template is split into arguments, honouring quotes.
 *   2. The `{{VARIABLES}}` are replaced *inside* each argument.
 *   3. The resulting array is handed to Docker as is, with no interpreter.
 *
 * A value containing a space therefore stays a single argument; a value
 * containing `;`, `&&`, `$(...)` or a newline is never interpreted, since no
 * shell ever sees the command.
 *
 * A second rule joined it, out of a different accident: **a variable that does
 * not resolve never quietly changes the command.** An argument that disappears
 * is not an argument missing — the flag in front of it takes the next one
 * instead — so an undefined name fails the start, and the one drop that has to
 * survive is reported to whoever pressed start. See `buildInvocation`.
 */

import { allocationForRole, type ServerAllocations } from '@hopper/shared';

/** Pattern of a variable in a template: `{{NAME}}`, spaces tolerated. */
const VARIABLE_PATTERN = /\{\{\s*([A-Za-z_][A-Za-z0-9_.]*)\s*\}\}/g;

export class InvocationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvocationError';
  }
}

/**
 * Splits a command line into arguments.
 *
 * Reproduces a shell's behaviour on single and double quotes, and nothing else:
 * no variable expansion, no globbing, no command substitution. What is not
 * implemented here cannot be exploited.
 */
export function tokenize(input: string): string[] {
  const tokens: string[] = [];
  let current = '';
  let started = false;
  let quote: '"' | "'" | null = null;

  for (let index = 0; index < input.length; index += 1) {
    const char = input[index]!;

    if (quote) {
      if (char === quote) {
        quote = null;
      } else {
        current += char;
      }
      continue;
    }

    if (char === '"' || char === "'") {
      quote = char;
      // An explicitly empty argument (`""`) has to produce an argument, not
      // nothing.
      started = true;
      continue;
    }

    if (char === ' ' || char === '\t' || char === '\n' || char === '\r') {
      if (started) {
        tokens.push(current);
        current = '';
        started = false;
      }
      continue;
    }

    current += char;
    started = true;
  }

  if (quote) {
    throw new InvocationError(`Unclosed ${quote} quote in the startup command.`);
  }

  if (started) {
    tokens.push(current);
  }

  return tokens;
}

export interface InvocationContext {
  /** Template variables, already validated on the panel side. */
  environment: Record<string, string>;
  /** Allocated memory, in mebibytes — the unit `-Xmx` expects. */
  memoryMib: number;
  /**
   * Every port the server has: the primary one, and the ones the operator has
   * named.
   *
   * The whole set rather than the primary's `ip` and `port`, which is what this
   * carried before. Each of the four places that build a context copied those
   * two fields out of `allocations.default`, and the day a fifth copied
   * something else `SERVER_PORT` would have meant a port other than the one the
   * container publishes, with nothing anywhere to notice. Handing over the set
   * also removes the question the named ports would otherwise raise — where the
   * lookup gets its data from — since it is the same object the readiness
   * strategy is resolved against.
   */
  allocations: ServerAllocations;
}

/**
 * Headroom left outside the heap, in mebibytes.
 *
 * Two costs hide there, and forgetting the second is the trap:
 *
 *  - **the JVM's off-heap**: metaspace, code cache, thread stacks, and Netty's
 *    direct buffers carrying the network traffic. Measured at ~250 MiB on an
 *    idle Paper 1.21.4;
 *  - **the page cache**, which counts towards the cgroup just like anonymous
 *    memory. A Minecraft server reads its region files constantly; if nothing
 *    is left to cache them, the kernel evicts everything — and once it has
 *    nothing left to reclaim, it kills the process.
 *
 * A measurement on the test machine shows it without ambiguity: a 1024 MiB
 * container, `-Xmx768M`. The server starts fully, then stays pinned at the
 * ceiling while the cache falls from 127 MiB to 0, and dies with code 137.
 * Anonymous memory alone reached 1018 MiB — the 256 MiB headroom covered the
 * JVM but left not one byte for the cache.
 */
const JVM_OVERHEAD_MIB = 384;

/**
 * Largest share of the limit that can go to the heap.
 *
 * Takes over on large allocations: the GC's structures and Netty's buffers grow
 * with the heap and with the number of players, so a fixed headroom would end
 * up being exceeded. The ceiling keeps a constant proportion whatever the size.
 */
export const MAX_HEAP_RATIO = 0.8;

/**
 * A JVM's heap budget, from the container's limit.
 *
 * Giving the whole limit to `-Xmx` is the classic Minecraft hosting trap: the
 * heap alone can then fill the cgroup, and the kernel kills the process as soon
 * as the JVM allocates off-heap. The server dies with code 137, with nothing in
 * its logs — it was generating its world, all was well, and it vanishes.
 *
 * So the headroom above is reserved, capped at a fraction of the limit so that
 * small allocations keep some air too.
 */
export function heapBudgetMib(limitMib: number): number {
  if (limitMib <= 0) {
    return 0;
  }

  const withOverhead = limitMib - JVM_OVERHEAD_MIB;
  const withRatio = Math.floor(limitMib * MAX_HEAP_RATIO);

  // 128 MiB is the floor below which a JVM does not start.
  return Math.max(128, Math.min(withOverhead, withRatio));
}

/**
 * Variables supplied by Hopper on top of the template's own.
 * They win: a template must not be able to redefine the listening port.
 */
function builtinVariables(context: InvocationContext): Record<string, string> {
  const heap = heapBudgetMib(context.memoryMib);
  const primary = context.allocations.default;

  const variables: Record<string, string> = {
    // `SERVER_MEMORY` is the **heap** budget, not the container limit. It is
    // what templates pass to `-Xmx`, and it is the value that has to leave
    // headroom.
    SERVER_MEMORY: String(heap),
    // The raw limit stays available for templates that need it — an install
    // script sizing a cache, for instance.
    SERVER_MEMORY_LIMIT: String(context.memoryMib),
    SERVER_IP: primary.ip,
    SERVER_PORT: String(primary.port),
    // Aliases commonly used by imported Pterodactyl eggs.
    'server.build.default.ip': primary.ip,
    'server.build.default.port': String(primary.port),
    'server.build.memory': String(heap),
  };

  // The named ports, so that a startup command can reach one that is not the
  // game's: `--rcon-port {{server.allocations.rcon.port}}`. Dotted like the
  // aliases above and for the same reason — that is the shape a Pterodactyl
  // egg's author already writes, and the role is the name the operator gave
  // the port in the Network tab.
  //
  // Only ports that carry a name appear here, and nothing stands in for one
  // that does not. That absence is what lets `buildInvocation` refuse: a role
  // nobody created is an *unknown* variable rather than an empty one, and the
  // two are treated very differently below.
  //
  // `server.allocations.default.*` is not defined either. The primary port
  // carries no role — the contract gives it no field to hold one — and is
  // reached by `SERVER_PORT`, as it always has been. An operator who names an
  // additional port `default` gets that port under this name, which is exactly
  // what `allocationForRole` answers; one lookup, one answer.
  for (const allocation of context.allocations.additional) {
    const role = allocation.role;

    if (role === undefined) {
      continue;
    }

    // Through the shared lookup rather than off the allocation in hand. It
    // cannot fail for a role taken from that very list, and it is not here for
    // the case where it succeeds: a payload naming two ports the same — the
    // panel's unique index forbids it, the contract has no way to say so —
    // would otherwise leave the second one under the name while the readiness
    // probe knocked on the first. One name, two ports, which is what names
    // were introduced to prevent.
    const resolved = allocationForRole(context.allocations, role) ?? allocation;

    variables[`server.allocations.${role}.ip`] = resolved.ip;
    variables[`server.allocations.${role}.port`] = String(resolved.port);
  }

  return variables;
}

/**
 * Replaces the variables in a string.
 *
 * An unknown variable is replaced by an empty string, as a shell would, and its
 * name is returned. What that is worth is the caller's to decide, and the two
 * callers decide differently: `buildInvocation` refuses to build a command with
 * a hole in it, while the configuration-file rewriter says so on the console and
 * carries on — a stale line in `server.properties` is something an operator can
 * fix, and a server that will not start because of one is not.
 */
export function substitute(
  input: string,
  context: InvocationContext,
): { value: string; missing: string[] } {
  const variables = { ...context.environment, ...builtinVariables(context) };
  const missing: string[] = [];

  const value = input.replace(VARIABLE_PATTERN, (_match, name: string) => {
    // `Object.hasOwn` rather than a plain lookup: `{{constructor}}` and
    // `{{toString}}` match the pattern above, and a plain lookup answers them
    // out of `Object.prototype` — so an argument would come out holding
    // `function toString() { [native code] }` instead of the template's
    // intent, and nothing would call it missing. They are variables nobody
    // defined, and the only honest answer is to say so.
    const replacement = Object.hasOwn(variables, name) ? variables[name] : undefined;

    if (replacement === undefined) {
      missing.push(name);
      return '';
    }

    return replacement;
  });

  return { value, missing };
}

export interface BuiltInvocation {
  /** Arguments ready for Docker. The first element is the executable. */
  argv: string[];
  /**
   * Arguments that vanished because every variable in them held nothing.
   *
   * Returned rather than swallowed: the command that runs is shorter than the
   * one the template describes, and only the operator can tell whether that
   * was the intention. The caller writes them to the server's console — see
   * the drop rule in `buildInvocation` for why they cannot simply be kept, and
   * why the argument in front of them cannot be dropped along with them.
   */
  droppedArguments: string[];
}

/**
 * Turns a startup template into an array of arguments.
 *
 * @throws {InvocationError} if the template is empty, badly quoted, names a
 *   variable that does not exist, or produces no executable once substituted.
 */
export function buildInvocation(template: string, context: InvocationContext): BuiltInvocation {
  // Splitting BEFORE substitution: this is what stops a variable value from
  // introducing an extra argument.
  const tokens = tokenize(template);

  if (tokens.length === 0) {
    throw new InvocationError('The startup command is empty.');
  }

  const missing = new Set<string>();
  const argv: string[] = [];
  const droppedArguments: string[] = [];

  /*
   * There are two ways an argument comes out empty, and they are not the same
   * accident. Everything in the loop below turns on telling them apart.
   *
   * **A variable nobody defined** fails the start. That is a change: it used
   * to be dropped, counted into a `missingVariables` list, and the only
   * caller threw the list away — so a template with a typo in it ran a
   * command nobody had written, and nothing anywhere said so. On a
   * flag/value pair that is worse than one argument short:
   * `--rcon-port {{server.allocations.rcon.port}}` on a server with no port
   * named `rcon` leaves `--rcon-port` to swallow whatever comes next, so
   * `--port 34197` becomes the RCON port, the game is given no port at all,
   * and the only symptom is the game's own complaint several lines into a
   * console nobody has open. Steam-shaped invocations are made of such
   * pairs, and named ports make the unresolved case ordinary rather than
   * exotic: the template asks for a port by a name the operator has not
   * given out yet.
   *
   * Weighed against breaking a server that starts today, which is the only
   * thing that could argue for keeping the drop: a server whose command
   * names an undefined variable is *already* running something other than
   * its template — silently, and in the flag/value shape, wrongly. Where the
   * variable sits inside an argument (`-Xmx{{TYPO}}M` → `-XmxM`) that server
   * does not start today either. The one case that does start today and
   * stops now is an argument made of nothing but an undefined variable, and
   * it stops with its cause named, on the console, at the moment somebody
   * pressed start. That trade is the same one the readiness path took when
   * it chose to refuse a role naming no port rather than guess the primary.
   *
   * **A variable that is defined and empty** is dropped exactly as before.
   * That is the case the rule was written for: `{{JAVA_FLAGS}}` holding
   * nothing is how half the imported eggs say "no extra flags", and handing
   * `java` an empty argument fails the start. Refusing those would take out
   * servers that run today on machines nobody has touched, which is not a
   * price this change is allowed to charge.
   *
   * What must **not** be done about the flag such a drop can strand is the
   * tempting fix — dropping the argument in front of it too. Nothing here
   * can tell `--rcon-port {{X}}`, where the flag is orphaned, from
   * `-Xmx3276M {{JAVA_FLAGS}}`, where the argument in front is complete in
   * itself; a shell cannot tell either, because which flags take a value is
   * known only to the program being run. Guessing wrong there deletes the
   * heap ceiling from every Minecraft server in the catalogue — the same
   * corruption this is meant to prevent, one argument to the left. So the
   * drop stays what it is and stops being silent: it is reported, and the
   * caller says it on the console.
   */
  for (const token of tokens) {
    const result = substitute(token, context);

    if (result.missing.length > 0) {
      // Collected rather than thrown on at once, so that an operator is told
      // about every name that is wrong and fixes them in one pass instead of
      // one start each.
      result.missing.forEach((name) => missing.add(name));
      continue;
    }

    // An explicitly written empty argument (`""`) was kept by the tokenizer and
    // must stay — hence the test on the original token.
    if (result.value === '' && token !== '') {
      droppedArguments.push(token);
      continue;
    }

    argv.push(result.value);
  }

  if (missing.size > 0) {
    throw new InvocationError(unknownVariablesMessage([...missing]));
  }

  if (argv.length === 0 || argv[0] === '') {
    throw new InvocationError(
      'The startup command names no executable once the variables are resolved.',
    );
  }

  return { argv, droppedArguments };
}

/**
 * What to tell an operator about variables the command names and the server
 * has not got.
 *
 * A `server.allocations.<role>` name gets its own sentence, because it is the
 * only one of the two an operator can fix without touching a template: the
 * template asked for a port by name, and this server has no port under that
 * name. The wording deliberately echoes the readiness refusal — same cause,
 * same two ways out — so that whoever meets the second recognises the first.
 */
function unknownVariablesMessage(names: string[]): string {
  const described = names.map((name) => {
    const role = /^server\.allocations\.([a-z0-9]+)\.(?:ip|port)$/.exec(name)?.[1];

    return role === undefined
      ? `{{${name}}} is not a variable of this server`
      : `{{${name}}} needs a port named "${role}", and this server has none — name one in its Network tab, or take the variable out of the startup command`;
  });

  return (
    `The startup command cannot be built: ${described.join('; ')}. ` +
    'The server was not started: dropping the argument would leave the flag in front of it ' +
    'holding the next one, and what ran would not be the command the template describes.'
  );
}

/**
 * Environment variables injected into the container.
 *
 * Names that do not follow POSIX syntax are dropped: `docker` would accept
 * them, but an `export` in an install script would fail, and the error message
 * would be incomprehensible.
 */
export function buildEnvironment(context: InvocationContext): string[] {
  const merged = { ...context.environment, ...builtinVariables(context) };

  return Object.entries(merged)
    .filter(([name]) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(name))
    .map(([name, value]) => `${name}=${value}`);
}
