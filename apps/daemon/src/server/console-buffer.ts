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
 * A finished line, and the row of the terminal it was written on.
 *
 * The row is not decoration. A line feed moves the cursor down, so the next line
 * lands on a row of its own; a carriage return does not, so the next line lands
 * on top of the one before it and a terminal shows one row where this file has
 * handed over two. {@link ConsoleBuffer.pushAssembled} is the only thing that
 * acts on the difference — every other consumer of this type reads
 * {@link text} and is right to ignore the rest.
 */
export interface ConsoleLine {
  /** The line itself, with the terminator that ended it removed. */
  readonly text: string;
  /**
   * Whether this line was written over the row the previous one occupied.
   *
   * True exactly when the line handed over before it was ended by a carriage
   * return that no line feed followed. Stated about the row this line landed on
   * rather than about the return that ended *this* line, because that is the
   * only form of the fact the assembler can be sure of when it hands the line
   * over: a `\r` in the last position of a chunk may still turn out to be the
   * head of a CRLF, and the line is handed over anyway — see
   * {@link LineAssembler} for why it is not held back.
   */
  readonly overwritesPreviousRow: boolean;
}

/**
 * Reassembles complete lines from a stream of bytes.
 *
 * Docker delivers a container's output in packets that do not align with line
 * endings: one line can arrive in three pieces, and one packet can hold ten
 * lines. Without this reassembly the console would show fragments and the
 * startup detection regexes would never match.
 *
 * Three sequences end a line here — `\r\n`, `\n`, and a carriage return on its
 * own — and the third is not a formality. SteamCMD reports a six-gigabyte depot
 * by rewriting one line in place with carriage returns and never printing a
 * newline at all, so a splitter that knew only `\n` held a forty-minute
 * download as a single growing string: the operator got a blob truncated at
 * {@link MAX_LINE_LENGTH} every couple of minutes instead of a progress figure,
 * and an install that had stalled looked exactly like one that was working.
 *
 * The two returns are deliberately not treated alike, because the terminal they
 * imitate does not treat them alike. A line feed moves the cursor down a row,
 * so the row it leaves behind is a line of output even when nothing was written
 * on it: `\n\n` is a server printing a blank line and it stays two lines here. A
 * carriage return only moves the cursor back to column zero, so it ends a line
 * **only when something was written on that row**. A run of returns with nothing
 * between them rewinds over the same row repeatedly and leaves a terminal's
 * display untouched, and it produces nothing here for the same reason: a
 * progress bar whose counter pauses would otherwise post a blank line per
 * refresh and push the operator's real output out of a console that keeps a few
 * hundred lines.
 *
 * A refresh that *did* write something is a different matter and is handed over
 * at once, every time: an operator watching a download wants the figure to move,
 * and the newest frame is the one line a stalled install is judged on. That is
 * one line per refresh, though, and SteamCMD refreshes about twice a second —
 * four minutes of it would fill a five-hundred-line buffer on its own and evict
 * the apt output, the app id, and every warning printed before the download
 * began. So each line carries the row it was written on
 * ({@link ConsoleLine.overwritesPreviousRow}) and {@link ConsoleBuffer} keeps a
 * run of them as the single row a terminal would show. The split and the
 * retention are deliberately separate jobs: the live stream wants every frame,
 * the replay wants the row.
 */
export class LineAssembler {
  private pending = '';

  /**
   * What a carriage return in the last position of the last chunk left open.
   *
   * Docker does not align its packets to line endings — that is the whole
   * reason this class exists — so a `\r\n` arrives split down the middle often
   * enough to matter, and a `\r` at the end of a chunk cannot be read until the
   * next byte is seen:
   *
   * - `'none'` — no return is outstanding.
   * - `'lineGiven'` — the return ended a row with something written on it. That
   *   much is settled whichever byte comes next, so the line has already been
   *   handed over rather than held back; only the `\n` of a possible CRLF is
   *   still owed, and it is swallowed if it arrives. Without that, every
   *   unluckily-split CRLF would gain a blank line the server never sent.
   * - `'blankRow'` — the return ended a row with *nothing* on it, and only the
   *   next byte says what that was. A `\n` makes it a CRLF, which is a server
   *   printing a blank line and has to appear; anything else makes it a bare
   *   rewind over an untouched row, which is nothing at all. This one really
   *   does have to wait, and it is the case that made this a union rather than a
   *   flag: a Minecraft log's blank lines vanished whenever a packet boundary
   *   fell between their `\r` and their `\n`.
   */
  private trailingReturn: 'none' | 'lineGiven' | 'blankRow' = 'none';

  /**
   * Whether the next line handed over lands on the row the last one occupied.
   *
   * Kept as a fact about the *previous* terminator rather than read off each
   * line's own, and that is what makes it trustworthy. A `\r` in the last
   * position of a chunk is not yet a bare return — the `\n` that would make it a
   * CRLF may be in the next packet — but the line it ends goes out immediately
   * all the same. Were the line to carry a guess about its own terminator, a
   * Minecraft log whose packets happened to split its CRLFs would claim every
   * line as a rewrite of the one before and the buffer would keep the last one
   * only. Looking backwards costs nothing and is never a guess: by the time a
   * line is handed over, the byte after the previous terminator has been seen.
   */
  private overwritesRow = false;

  /** Consumes a chunk and returns the complete lines it finishes. */
  push(chunk: string): ConsoleLine[] {
    let rest = chunk;
    const lines: ConsoleLine[] = [];

    // Guarded on a non-empty chunk: an empty one settles nothing, and the
    // newline that would settle it may still be in the packet after this.
    if (this.trailingReturn !== 'none' && rest !== '') {
      const completesCrlf = rest.startsWith('\n');

      if (completesCrlf) {
        rest = rest.slice(1);
      }

      if (this.trailingReturn === 'lineGiven') {
        // The verdict the line handed over last chunk went out without. A `\n`
        // makes its return the head of a CRLF, which moved the cursor down and
        // closed its row; anything else makes it a bare rewind, and whatever is
        // written next lands on that same row. Settled here, ahead of every
        // line this chunk may produce, which is what lets each of them carry a
        // row it is sure of.
        this.overwritesRow = !completesCrlf;
      } else if (completesCrlf) {
        // Ahead of everything this chunk holds, because that is where it
        // happened. Never a rewrite, whatever the row was doing: the sequence
        // that produced this blank is `\r\n`, and a `\r` rewinds without erasing
        // — `a\r` then `\r\n` leaves `a` on the operator's screen — so a blank
        // line allowed to overwrite would delete a line the terminal still
        // shows. An extra blank line is the cheaper of the two mistakes.
        lines.push({ text: '', overwritesPreviousRow: false });
        this.overwritesRow = false;
      }

      this.trailingReturn = 'none';
    }

    const buffer = this.pending + rest;
    let start = 0;
    let index = 0;

    while (index < buffer.length) {
      const character = buffer[index];

      if (character !== '\n' && character !== '\r') {
        index += 1;
        continue;
      }

      const crlf = character === '\r' && buffer[index + 1] === '\n';
      const loneReturn = character === '\r' && !crlf;
      const undecided = loneReturn && index === buffer.length - 1;
      const segment = buffer.slice(start, index);

      // Every terminator but a lone return ends a row and yields a line, empty
      // or not. A lone return over an empty segment rewound a row nothing had
      // been written to and yields nothing — unless it is the last byte in hand,
      // in which case it may yet turn out to be the `\r` of a CRLF and the
      // verdict waits for the next chunk. A return over a row with something on
      // it needs no such wait: that line is finished either way, and holding it
      // back would withhold the newest frame of a progress bar, which is
      // precisely the line an operator watching a stalled download needs.
      if (!loneReturn || segment !== '') {
        // An empty line never overwrites, whatever the row was doing — the same
        // rule the packet-boundary branch above states at length, and it has to
        // be here too because that branch only sees a `\r` that ended a chunk.
        // In one packet, `a\r\r\n` reaches this loop instead: the `\r\n` closes
        // a row the `\r` had rewound onto but written nothing to, so the blank
        // is real, and letting it inherit the rewind deletes `a` — a line the
        // terminal still shows. It is the readiness line often enough to
        // matter: a Bukkit `Done (7.213s)!` logged with a stray return vanishes
        // from the console and from the buffer.
        const blankFromCrlf = segment === '';

        lines.push({
          text: normalizeLine(segment),
          overwritesPreviousRow: blankFromCrlf ? false : this.overwritesRow,
        });

        // Moved on only by a line that was actually handed over, and only once
        // its own terminator is known. A bare return over an empty row rewound
        // the cursor without writing anything: `a\n\rb` puts `b` on the row
        // below `a`, not on top of it, and the row the next line lands on is
        // whatever it already was.
        if (!undecided) {
          this.overwritesRow = loneReturn;
        }
      }

      if (undecided) {
        this.trailingReturn = segment === '' ? 'blankRow' : 'lineGiven';
      }

      index += crlf ? 2 : 1;
      start = index;
    }

    this.pending = buffer.slice(start);

    // A stream with no terminator at all must not grow the buffer forever: past
    // the limit, it is cut and started over.
    //
    // `normalizeLine` here is the same slice-and-suffix v0.7.1 wrote out by
    // hand, and deliberately not an improvement on it. What is left in `pending`
    // cannot hold a return — every one of them is a terminator the loop above
    // consumed — and the guard has just established that it is longer than the
    // cap, so both halves of the normalisation are a foregone conclusion and the
    // two spellings cannot be told apart by any input. It is written this way to
    // keep one statement of where the cap falls and what the suffix says, not
    // because it does anything the slice did not.
    //
    // What did have to change is `push` rather than `return`. The early return
    // this replaced was safe where it stood — it sat in the branch taken when the
    // chunk held no newline at all, so there were never any lines to lose — and
    // is not safe here, where the guard runs after a loop that may have finished
    // half a dozen of them.
    //
    // Strictly `>`: a line of exactly {@link MAX_LINE_LENGTH} is not over the
    // cap, and a `>=` here would hand it over as "truncated" with nothing
    // missing from it — while also cutting a line that a terminator one byte
    // later would have completed intact.
    if (this.pending.length > MAX_LINE_LENGTH) {
      lines.push({ text: normalizeLine(this.pending), overwritesPreviousRow: this.overwritesRow });
      this.pending = '';
      // The break is this file's doing and not the terminal's. The row does go
      // on, but the head of the line is now an entry of its own in the buffer,
      // and a remainder that overwrote it would leave the console holding the
      // tail of a line whose beginning it has thrown away.
      this.overwritesRow = false;
    }

    return lines;
  }

  /** Empties the buffer and returns whatever partial line is left. */
  flush(): ConsoleLine[] {
    // The stream is over, so a return it ended on has nothing left to be
    // ambiguous about: no `\n` is coming, which settles a `'blankRow'` as the
    // bare rewind it turned out to be — nothing to print. Cleared rather than
    // left standing because the assembler outlives the container: a `\n` opening
    // the next one's output is that container's own blank first line, not the
    // tail of a CRLF from the last one.
    this.trailingReturn = 'none';

    // Read before it is cleared, and cleared for the same reason as above. The
    // partial line does belong to the row the last return left the cursor on —
    // that is how SteamCMD's own frame shape ends, with the newest figure still
    // unterminated — but the next container to be attached to this assembler
    // starts on a row of its own and must not overwrite the last words of the
    // one before it.
    const overwritesPreviousRow = this.overwritesRow;
    this.overwritesRow = false;

    if (this.pending === '') {
      return [];
    }

    const text = normalizeLine(this.pending);
    this.pending = '';
    return [{ text, overwritesPreviousRow }];
  }
}

function normalizeLine(line: string): string {
  // Nothing can arrive here with a carriage return on the end any more: every
  // one of them is a terminator the splitter consumed, CRLF included, so no
  // input reaches this line with one left to strip and no test can cover it.
  // Insurance, then, and kept because the two ways of being wrong about it are
  // not equally cheap: a stray `\r` passes for a control character in xterm.js
  // and shifts the display of everything after it, against one regex over a
  // string that is being copied in any case.
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
 *
 * It holds rows, not writes. A progress bar is one row of a terminal however
 * many times it is redrawn, and keeping it as one row is what leaves room for
 * the rest: at {@link CONSOLE_BUFFER_LINES} lines and a refresh twice a second,
 * a download counted frame by frame would evict everything an operator needs to
 * read an install after the fact — the apt output, the app id that was asked
 * for, the warning printed before the transfer began — inside four minutes.
 * Which is why the retention lives here and the splitting lives in
 * {@link LineAssembler}: the live stream is still sent every frame.
 */
export class ConsoleBuffer {
  private readonly lines: string[] = [];

  /**
   * Whether the newest line is a terminal row that a rewrite may still land on.
   *
   * False for anything Hopper wrote itself, which is the point of keeping it:
   * `[Hopper] Giving up on it…` is printed from a timer and lands between two
   * frames of the bar it is giving up on, and the frame that follows must not be
   * allowed to delete the one line explaining why the install stopped. Only
   * {@link pushAssembled} opens a row, and it always leaves a line behind it, so
   * this being true implies there is a line to overwrite.
   */
  private rowOpen = false;

  constructor(private readonly capacity: number = CONSOLE_BUFFER_LINES) {
    if (capacity < 1) {
      throw new Error('The console buffer capacity has to be positive.');
    }
  }

  /** Adds a line of Hopper's own, which stands on a row nothing may overwrite. */
  push(line: string): void {
    this.append(line);
    this.rowOpen = false;
  }

  /**
   * Adds a line off a container's terminal, on the row the terminal put it.
   *
   * A line the cursor never moved down for replaces the one before it instead of
   * following it: five thousand refreshes of a depot download are one row here,
   * the newest, exactly as they are one row on the terminal being imitated.
   */
  pushAssembled(line: ConsoleLine): void {
    if (line.overwritesPreviousRow && this.rowOpen) {
      this.lines[this.lines.length - 1] = line.text;
    } else {
      this.append(line.text);
    }

    this.rowOpen = true;
  }

  pushAll(lines: readonly string[]): void {
    lines.forEach((line) => this.push(line));
  }

  private append(line: string): void {
    this.lines.push(line);

    // `shift` on a 500-element array is negligible next to the cost of a
    // cleverer ring structure that is also easier to break.
    while (this.lines.length > this.capacity) {
      this.lines.shift();
    }
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
    this.rowOpen = false;
  }
}
