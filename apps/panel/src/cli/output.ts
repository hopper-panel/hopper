/**
 * Command-line output.
 *
 * No colouring dependency: six ANSI sequences are enough, and one more library
 * would be loaded on every panel start since the CLI lives in the same package.
 *
 * Colours are dropped as soon as the output is not a terminal:
 * `hopper doctor > report.txt` has to produce a readable file, and the
 * installer redirects the output.
 */
const enabled = process.stdout.isTTY === true && process.env.NO_COLOR === undefined;

function paint(code: number, text: string): string {
  return enabled ? `\u001B[${code}m${text}\u001B[0m` : text;
}

export const bold = (text: string): string => paint(1, text);
export const dim = (text: string): string => paint(2, text);
export const green = (text: string): string => paint(32, text);
export const red = (text: string): string => paint(31, text);
export const yellow = (text: string): string => paint(33, text);

export function heading(text: string): void {
  process.stdout.write(`\n${bold(text)}\n`);
}

export function line(text = ''): void {
  process.stdout.write(`${text}\n`);
}

/** Result of one `doctor` check. */
export type Level = 'ok' | 'warn' | 'fail';

export function report(level: Level, label: string, detail?: string): void {
  const badge = { ok: green('✓'), warn: yellow('!'), fail: red('✗') }[level];
  line(`  ${badge} ${label}${detail === undefined ? '' : ` ${dim(`— ${detail}`)}`}`);
}

/**
 * Fatal error message.
 *
 * On the error stream, so that a script capturing standard output — this is how
 * the installer collects a `daemon.yml` — does not end up with an error message
 * in the middle of the file it produced.
 */
export function fatal(message: string): never {
  process.stderr.write(`${red('✗')} ${message}\n`);
  process.exit(1);
}
