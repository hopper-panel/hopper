import { CONSOLE_BUFFER_LINES } from '@hopper/shared';

/**
 * Longest console line kept.
 *
 * A plugin logging a concatenated stack trace, or a `cat` of a binary file,
 * produces lines several megabytes long. Without a bound they would pile up in
 * the buffer and be replayed on every browser connection.
 */
export const MAX_LINE_LENGTH = 8192;

const TRUNCATION_SUFFIX = '… [line truncated]';

/**
 * Reassembles complete lines from a stream of bytes.
 *
 * Docker delivers a container's output in packets that do not align with line
 * endings: one line can arrive in three pieces, and one packet can hold ten
 * lines. Without this reassembly the console would show fragments and the
 * startup detection regexes would never match.
 */
export class LineAssembler {
  private pending = '';

  /** Consumes a chunk and returns the complete lines it finishes. */
  push(chunk: string): string[] {
    this.pending += chunk;

    if (!this.pending.includes('\n')) {
      // A stream with no newline must not grow the buffer forever: past the
      // limit, it is cut and started over.
      if (this.pending.length > MAX_LINE_LENGTH) {
        const line = this.pending.slice(0, MAX_LINE_LENGTH) + TRUNCATION_SUFFIX;
        this.pending = '';
        return [line];
      }
      return [];
    }

    const parts = this.pending.split('\n');
    // The last element is incomplete — unless the chunk ended with a newline,
    // in which case it is an empty string held in wait.
    this.pending = parts.pop() ?? '';

    return parts.map((line) => normalizeLine(line));
  }

  /** Empties the buffer and returns whatever partial line is left. */
  flush(): string[] {
    if (this.pending === '') {
      return [];
    }

    const line = normalizeLine(this.pending);
    this.pending = '';
    return [line];
  }
}

function normalizeLine(line: string): string {
  // Minecraft servers emit CRLF; the trailing \r would pass for a control
  // character in xterm.js and shift the display.
  const trimmed = line.replace(/\r+$/, '');

  return trimmed.length > MAX_LINE_LENGTH
    ? trimmed.slice(0, MAX_LINE_LENGTH) + TRUNCATION_SUFFIX
    : trimmed;
}

/**
 * Ring buffer of the latest console lines.
 *
 * Replayed on every browser connection so that a user opening the console sees
 * what just happened, rather than a black screen until the server's next line.
 */
export class ConsoleBuffer {
  private readonly lines: string[] = [];

  constructor(private readonly capacity: number = CONSOLE_BUFFER_LINES) {
    if (capacity < 1) {
      throw new Error('The console buffer capacity has to be positive.');
    }
  }

  push(line: string): void {
    this.lines.push(line);

    // `shift` on a 500-element array is negligible next to the cost of a
    // cleverer ring structure that is also easier to break.
    while (this.lines.length > this.capacity) {
      this.lines.shift();
    }
  }

  pushAll(lines: readonly string[]): void {
    lines.forEach((line) => this.push(line));
  }

  /** Copy of the contents, oldest to newest. */
  snapshot(): string[] {
    return [...this.lines];
  }

  get size(): number {
    return this.lines.length;
  }

  clear(): void {
    this.lines.length = 0;
  }
}
