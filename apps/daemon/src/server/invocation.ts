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
 */

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
  ip: string;
  port: number;
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

  return {
    // `SERVER_MEMORY` is the **heap** budget, not the container limit. It is
    // what templates pass to `-Xmx`, and it is the value that has to leave
    // headroom.
    SERVER_MEMORY: String(heap),
    // The raw limit stays available for templates that need it — an install
    // script sizing a cache, for instance.
    SERVER_MEMORY_LIMIT: String(context.memoryMib),
    SERVER_IP: context.ip,
    SERVER_PORT: String(context.port),
    // Aliases commonly used by imported Pterodactyl eggs.
    'server.build.default.ip': context.ip,
    'server.build.default.port': String(context.port),
    'server.build.memory': String(heap),
  };
}

/**
 * Replaces the variables in a string.
 *
 * An unknown variable is replaced by an empty string, as a shell would — and
 * reported by the caller, because it is nearly always a typo in the template.
 */
export function substitute(
  input: string,
  context: InvocationContext,
): { value: string; missing: string[] } {
  const variables = { ...context.environment, ...builtinVariables(context) };
  const missing: string[] = [];

  const value = input.replace(VARIABLE_PATTERN, (_match, name: string) => {
    const replacement = variables[name];

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
  /** Variables referenced by the template but absent from the context. */
  missingVariables: string[];
}

/**
 * Turns a startup template into an array of arguments.
 *
 * @throws {InvocationError} if the template is empty, badly quoted, or produces
 *   no executable once substituted.
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

  for (const token of tokens) {
    const result = substitute(token, context);
    result.missing.forEach((name) => missing.add(name));

    // An argument that became empty is dropped: `-Xmx{{SERVER_MEMORY}}M` with
    // unlimited memory would give `-XmxM`, which the JVM refuses. But an
    // explicitly written empty argument (`""`) was kept by the tokenizer and
    // must stay — hence the test on the original token.
    if (result.value === '' && token !== '') {
      continue;
    }

    argv.push(result.value);
  }

  if (argv.length === 0 || argv[0] === '') {
    throw new InvocationError(
      'The startup command names no executable once the variables are resolved.',
    );
  }

  return { argv, missingVariables: [...missing] };
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
