/**
 * Command-line options.
 *
 * In its own module rather than in `main.ts`: the latter runs the command as
 * soon as it is imported, which would make the parser untestable.
 */
export type Flags = Map<string, string | true>;

/**
 * Parses `--key value`, `--key=value` and `--flag`.
 *
 * Hand-written rather than taken from an argument library: five commands and a
 * dozen options do not justify one more dependency in a package that also
 * serves as a server.
 */
export function parseFlags(argv: string[]): Flags {
  const flags: Flags = new Map();

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]!;

    if (!argument.startsWith('--')) {
      continue;
    }

    const [key, inlineValue] = argument.slice(2).split(/=(.*)/s, 2);

    if (key === undefined || key === '') {
      continue;
    }

    if (inlineValue !== undefined) {
      flags.set(key, inlineValue);
      continue;
    }

    const next = argv[index + 1];

    // A value starting with `--` is the next option, not this one's value:
    // `--admin --username x` must not give `admin=--username`, which would
    // create an account named `x` without the rights asked for.
    if (next === undefined || next.startsWith('--')) {
      flags.set(key, true);
      continue;
    }

    flags.set(key, next);
    index += 1;
  }

  return flags;
}

/**
 * An option's textual value.
 *
 * `undefined` when it is absent **or** bare: `--password` with no value must
 * not pass for an empty password, which would be accepted by the schema and
 * then hashed.
 */
export function textOf(flags: Flags, key: string): string | undefined {
  const value = flags.get(key);
  return typeof value === 'string' ? value : undefined;
}
