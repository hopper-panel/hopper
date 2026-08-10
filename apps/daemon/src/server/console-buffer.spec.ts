import { CONSOLE_BUFFER_BYTES, CONSOLE_BUFFER_LINES } from '@hopper/shared';
import { describe, expect, it } from 'vitest';
import {
  ConsoleBuffer,
  LineAssembler,
  MAX_LINE_LENGTH,
  type ConsoleLine,
} from './console-buffer.js';

const TRUNCATION_SUFFIX = '… [line truncated]';

/** Runs a chunking through an assembler and returns every line it produced. */
function assemble(chunks: readonly string[]): ConsoleLine[] {
  const assembler = new LineAssembler();
  const lines = chunks.flatMap((chunk) => assembler.push(chunk));

  return [...lines, ...assembler.flush()];
}

/** The text alone, for the cases that are only about where the splits fall. */
function textOf(lines: readonly ConsoleLine[]): string[] {
  return lines.map((line) => line.text);
}

/** Cuts text into fixed-size chunks, the way a socket would. */
function cut(text: string, size: number): string[] {
  const chunks: string[] = [];

  for (let index = 0; index < text.length; index += size) {
    chunks.push(text.slice(index, index + size));
  }

  return chunks;
}

/** Everything a buffer holds after one assembler has been poured into it. */
function replayOf(chunks: readonly string[]): string[] {
  const buffer = new ConsoleBuffer();
  const assembler = new LineAssembler();

  for (const chunk of chunks) {
    assembler.push(chunk).forEach((line) => buffer.pushAssembled(line));
  }

  assembler.flush().forEach((line) => buffer.pushAssembled(line));

  return buffer.snapshot();
}

/**
 * The splitter exactly as v0.7.1 shipped it, kept here as the reference for the
 * byte-identity assertion below.
 *
 * A copy rather than a git checkout because the promise being kept is about
 * output, and the only way to state it as a test is to run both and compare.
 * Nothing in this file may make it match the new one — it is worth nothing the
 * moment it is adjusted to agree.
 *
 * `normalizeAsBefore` is v0.7.1's `normalizeLine`, truncation and all, and the
 * truncation is not a detail: the corpus below reaches {@link MAX_LINE_LENGTH}
 * on purpose, and a reference that only stripped returns would be a splitter
 * this repository never shipped, losing to the new one on cases the old one
 * actually got right.
 */
function normalizeAsBefore(line: string): string {
  const trimmed = line.replace(/\r+$/, '');

  return trimmed.length > MAX_LINE_LENGTH
    ? trimmed.slice(0, MAX_LINE_LENGTH) + TRUNCATION_SUFFIX
    : trimmed;
}

class NewlineOnlyAssembler {
  private pending = '';

  push(chunk: string): string[] {
    this.pending += chunk;

    if (!this.pending.includes('\n')) {
      if (this.pending.length > MAX_LINE_LENGTH) {
        const line = this.pending.slice(0, MAX_LINE_LENGTH) + TRUNCATION_SUFFIX;
        this.pending = '';
        return [line];
      }
      return [];
    }

    const parts = this.pending.split('\n');
    this.pending = parts.pop() ?? '';

    return parts.map(normalizeAsBefore);
  }

  flush(): string[] {
    if (this.pending === '') {
      return [];
    }

    const line = normalizeAsBefore(this.pending);
    this.pending = '';
    return [line];
  }
}

function assembleAsBefore(chunks: readonly string[]): string[] {
  const assembler = new NewlineOnlyAssembler();
  const lines = chunks.flatMap((chunk) => assembler.push(chunk));

  return [...lines, ...assembler.flush()];
}

/**
 * A Paper server's first seconds, with the CRLF endings a Windows-built jar and
 * a good many Minecraft servers produce — blank line and all.
 */
const MINECRAFT_CRLF_LOG =
  [
    '[12:31:02] [ServerMain/INFO]: Loading Paper 1.21.4-232',
    '[12:31:04] [Server thread/INFO]: Starting minecraft server version 1.21.4',
    '[12:31:04] [Server thread/INFO]: Loading properties',
    '[12:31:04] [Server thread/WARN]: Failed to load eula.txt',
    '',
    '[12:31:05] [Server thread/INFO]: Preparing level "world"',
    '[12:31:11] [Server thread/INFO]: Done (7.213s)! For help, type "help"',
  ].join('\r\n') + '\r\n';

/**
 * A line of exactly {@link MAX_LINE_LENGTH}, which no log above comes near.
 *
 * The cap is where the two splitters have any chance of disagreeing — everything
 * shorter goes through both untouched — so a corpus that never reaches it cannot
 * hold the identity assertion up.
 */
const CAPPED_LINE = '[12:32:07] [Server thread/ERROR]: '.padEnd(MAX_LINE_LENGTH, 'x');
/** One character past it: a plugin concatenating a stack trace, in miniature. */
const OVERSIZED_LINE = `${CAPPED_LINE}y`;

/** One refresh of the depot download SteamCMD prints while it fetches. */
function steamProgress(percent: number): string {
  const total = 6_100_000_000;
  const done = Math.round((total * percent) / 100);

  return `Update state (0x61) downloading, progress: ${percent.toFixed(2)} (${done} / ${total})\r`;
}

describe('LineAssembler', () => {
  it('splits a chunk holding several lines', () => {
    const assembler = new LineAssembler();
    expect(textOf(assembler.push('une\ndeux\ntrois\n'))).toEqual(['une', 'deux', 'trois']);
  });

  // Without reassembly, a line cut across two packets would never match the
  // startup detection regex.
  it('glues back a line that arrived in several chunks', () => {
    const assembler = new LineAssembler();

    expect(textOf(assembler.push('Done (12.3'))).toEqual([]);
    expect(textOf(assembler.push('s)! For help'))).toEqual([]);
    expect(textOf(assembler.push(', type "help"\n'))).toEqual([
      'Done (12.3s)! For help, type "help"',
    ]);
  });

  it('holds an incomplete line until its newline', () => {
    const assembler = new LineAssembler();

    expect(textOf(assembler.push('une\npartielle'))).toEqual(['une']);
    expect(textOf(assembler.push('-suite\n'))).toEqual(['partielle-suite']);
  });

  it('strips the carriage returns of CRLF', () => {
    const assembler = new LineAssembler();
    expect(textOf(assembler.push('windows\r\nunix\n'))).toEqual(['windows', 'unix']);
  });

  it('keeps the empty lines', () => {
    const assembler = new LineAssembler();
    expect(textOf(assembler.push('a\n\nb\n'))).toEqual(['a', '', 'b']);
  });

  it('gives the partial line back on flush', () => {
    const assembler = new LineAssembler();
    assembler.push('no ending');
    expect(textOf(assembler.flush())).toEqual(['no ending']);
    expect(textOf(assembler.flush())).toEqual([]);
  });

  it('truncates an outsized line', () => {
    const assembler = new LineAssembler();
    const [line] = assembler.push('x'.repeat(MAX_LINE_LENGTH + 5000) + '\n');

    expect(line!.text.length).toBeLessThanOrEqual(MAX_LINE_LENGTH + 30);
    expect(line!.text).toContain('truncated');
  });

  // A binary stream with no newline at all would grow the buffer until the
  // daemon ran out of memory.
  it('cuts a newline-free stream instead of swelling forever', () => {
    const assembler = new LineAssembler();
    let emitted: ConsoleLine[] = [];

    for (let index = 0; index < 20; index += 1) {
      emitted = emitted.concat(assembler.push('y'.repeat(1000)));
    }

    expect(emitted.length).toBeGreaterThan(0);
    expect(emitted[0]!.text).toContain('truncated');
  });

  /**
   * The reason this splitter learned about carriage returns.
   *
   * SteamCMD reports a six-gigabyte Garry's Mod depot by rewriting one line in
   * place, twice a second, for as long as the download takes. Split on `\n`
   * alone there is no line in any of it: the operator got one blob cut off at
   * `MAX_LINE_LENGTH` every couple of minutes, with the progress figure buried
   * eight kilobytes in.
   */
  it('gives one line per refresh of a carriage-return progress bar', () => {
    const assembler = new LineAssembler();
    const frames = [0.4, 12.34, 41.62, 78.9, 99.99].map(steamProgress);

    const lines = frames.flatMap((frame) => assembler.push(frame));

    expect(lines).toHaveLength(frames.length);
    expect(lines[0]!.text).toBe(
      'Update state (0x61) downloading, progress: 0.40 (24400000 / 6100000000)',
    );
    expect(lines.at(-1)!.text).toContain('progress: 99.99');
    expect(textOf(lines).join('\n')).not.toContain('truncated');
    // Nothing held back **in this frame shape**, where the return closes each
    // refresh: every one of them has already been handed over, so a download
    // that stalls here leaves its newest figure on the operator's screen rather
    // than inside this object. The shape in the next test ends differently and
    // does keep its last frame until the flush, which is the same one line's
    // worth of lag and not the whole download the newline-only splitter held.
    expect(assembler.flush()).toEqual([]);
  });

  /**
   * The same bar as SteamCMD actually writes it, captured from a real install:
   * the return leads each refresh instead of ending it.
   */
  it('splits a progress bar whose returns lead each refresh', () => {
    const assembler = new LineAssembler();

    expect(textOf(assembler.push('\rUpdate state (0x61) downloading, progress: 41.62'))).toEqual(
      [],
    );
    expect(textOf(assembler.push('\rUpdate state (0x61) downloading, progress: 43.08'))).toEqual([
      'Update state (0x61) downloading, progress: 41.62',
    ]);
    expect(textOf(assembler.flush())).toEqual(['Update state (0x61) downloading, progress: 43.08']);
  });

  /**
   * A forty-minute download must not exhaust the overflow guard even once: a
   * `truncated` marker in the middle of a progress bar is a bug report about
   * this file, and it would arrive during the first Steam install anyone ran.
   */
  it('never truncates a progress bar however long the download', () => {
    const assembler = new LineAssembler();
    let lines: ConsoleLine[] = [];

    for (let refresh = 0; refresh < 5_000; refresh += 1) {
      lines = lines.concat(assembler.push(steamProgress((refresh / 5_000) * 100)));
    }

    expect(lines).toHaveLength(5_000);
    expect(textOf(lines).join('\n')).not.toContain('truncated');
  });

  /**
   * The cost of a line arriving in very small pieces, which is a clock and is
   * here on purpose.
   *
   * `push` used to read `pending + rest` by index, and indexing a pair of
   * strings is what makes the engine join them into a new one. Every packet of a
   * line therefore recopied and rescanned everything of that line held so far —
   * bounded by {@link MAX_LINE_LENGTH} rather than unbounded, so it was eight
   * kilobytes of extra work per packet and not a hang, which is exactly why it
   * was never noticed. It arrived instead as a five-second timeout on the
   * comparison test below, on a CI runner, two versions after the change that
   * caused it.
   *
   * A wall clock is a poor assertion and the margins are what make it a usable
   * one. Four mebibytes one byte at a time is about 60 ms with the fix and about
   * thirty seconds without it; the bound is 3 000 ms, which is fifty times the
   * one and a tenth of the other. It fails on the regression on any machine that
   * can run the rest of this suite, and a slow runner has to be fifty times
   * slower than a laptop to fail on the fix.
   *
   * One byte per push is not a straw man. Docker hands over what the container
   * flushed, and a game printing a spinner or a progress percentage character by
   * character flushes exactly this way.
   */
  it('stays linear when a long line arrives one byte at a time', () => {
    const assembler = new LineAssembler();
    const line = `${'z'.repeat(4 * 1024 * 1024)}\n`;

    const started = performance.now();
    for (let index = 0; index < line.length; index += 1) {
      assembler.push(line[index]!);
    }
    const elapsed = performance.now() - started;

    expect(assembler.flush()).toEqual([]);
    expect(elapsed).toBeLessThan(3_000);
  });

  /**
   * Every existing server's output has to survive this change untouched, and
   * "untouched" is measured against the splitter that shipped, not asserted.
   *
   * The comparison is over the whole sequence of lines rather than push by
   * push: a CRLF cut in half between two packets hands its line over one chunk
   * earlier now, which is the improvement and not a difference in output.
   *
   * The cap is in the corpus, and it has to be. Each splitter has a truncation
   * rule of its own, written differently, and the corpus this test shipped with
   * had a longest line of seventy-five characters: it could not reach the one
   * place the two rules had any chance of disagreeing, so it was asserting
   * identity over the stretch where identity was never in question. Reaching the
   * cap on a line a newline ends still finds them agreeing, which is the answer
   * this test is now entitled to give. Where they do part company takes a
   * carriage return, and that is the next test.
   */
  it('matches the newline-only splitter on newline-terminated output, byte for byte', () => {
    const logs = [
      MINECRAFT_CRLF_LOG,
      // The same server built for Linux: `\n` throughout.
      MINECRAFT_CRLF_LOG.replace(/\r\n/g, '\n'),
      // One jar, one wrapper script: both endings in the same stream.
      MINECRAFT_CRLF_LOG.replace('Loading properties\r\n', 'Loading properties\n'),
      // Cut off mid-line, which is how the stream of a crashing server ends.
      MINECRAFT_CRLF_LOG + '[12:33:40] [Server thread/ERROR]: java.lang.OutOfMemo',
      // Blank lines at both ends, where an off-by-one would hide.
      `\r\n${MINECRAFT_CRLF_LOG}\r\n`,
      // Exactly the cap, one past it, and one past it in CRLF — the boundary
      // itself, with a real log either side so that a splitter losing its place
      // over the cut has somewhere to show it.
      `${MINECRAFT_CRLF_LOG}${CAPPED_LINE}\n${MINECRAFT_CRLF_LOG}`,
      `${MINECRAFT_CRLF_LOG}${OVERSIZED_LINE}\n${MINECRAFT_CRLF_LOG}`,
      `${MINECRAFT_CRLF_LOG}${OVERSIZED_LINE}\r\n${MINECRAFT_CRLF_LOG}`,
      // Forty kilobytes with no ending, which is `cat` on a jar file: several
      // cuts in a row, and where they fall depends on the packets.
      `${'z'.repeat(40 * 1024)}\n`,
    ];

    // Every chunk size from a byte upwards: at size 1 every single CRLF in the
    // log is split down the middle, which is the case that broke first. 16384 is
    // the packet Docker actually hands over, and where a 40 KiB line gets cut
    // depends entirely on that — one truncated line per packet, in both
    // splitters, in the same places.
    for (const log of logs) {
      for (const size of [1, 2, 3, 7, 64, 512, 8192, 16_384, log.length]) {
        const chunks = cut(log, size);

        expect(textOf(assemble(chunks))).toEqual(assembleAsBefore(chunks));
      }
    }

    // And the log itself, so that a reference quietly agreeing with a broken
    // splitter on an empty array cannot pass this.
    expect(textOf(assemble([MINECRAFT_CRLF_LOG]))).toEqual([
      '[12:31:02] [ServerMain/INFO]: Loading Paper 1.21.4-232',
      '[12:31:04] [Server thread/INFO]: Starting minecraft server version 1.21.4',
      '[12:31:04] [Server thread/INFO]: Loading properties',
      '[12:31:04] [Server thread/WARN]: Failed to load eula.txt',
      '',
      '[12:31:05] [Server thread/INFO]: Preparing level "world"',
      '[12:31:11] [Server thread/INFO]: Done (7.213s)! For help, type "help"',
    ]);
  });

  /**
   * Where the two splitters part company, and it is on purpose.
   *
   * A carriage return is a terminator here and was ordinary content in v0.7.1,
   * so a line at the cap that a return ended counted one byte over it there and
   * came out cut. This one is not a close call: the frame is complete, the byte
   * that pushed it past the cap is the terminator, and `… [line truncated]` on
   * the end of a line with nothing missing from it is a lie the operator has no
   * way to check.
   *
   * Pinned at every chunk size, both sides, so that the day someone makes these
   * two agree again they have to decide which of them moved. The old answer is
   * the same at all of them here; where it was not is the test after this one.
   */
  it('keeps a capped line that a bare return ended, where v0.7.1 cut it', () => {
    for (const size of [1, 2, 3, 7, 64, 512, 8192, MAX_LINE_LENGTH + 1]) {
      const chunks = cut(`${CAPPED_LINE}\r`, size);

      expect(textOf(assemble(chunks))).toEqual([CAPPED_LINE]);
      expect(assembleAsBefore(chunks)).toEqual([CAPPED_LINE + TRUNCATION_SUFFIX]);
    }
  });

  /**
   * The same line ended in CRLF, where v0.7.1 answered two different things
   * about one input depending on how the socket happened to break it up.
   *
   * That is the latent bug being left behind rather than a behaviour worth
   * keeping: a truncation marker that appears or not according to the packet
   * boundaries is unreproducible by the person reporting it.
   */
  it('gives the same answer at every chunk size where v0.7.1 did not', () => {
    const withCrlf = `${CAPPED_LINE}\r\n`;

    // One byte at a time, the `\r` reaches v0.7.1 while the `\n` that would have
    // saved it is still in the socket: `pending` is a byte over the cap with no
    // newline in it, and the guard cuts a line that was about to end.
    expect(assembleAsBefore(cut(withCrlf, 1))).toEqual([CAPPED_LINE + TRUNCATION_SUFFIX, '']);
    // Two bytes at a time, the pair arrives together and the same input comes
    // out whole.
    expect(assembleAsBefore(cut(withCrlf, 2))).toEqual([CAPPED_LINE]);

    for (const size of [1, 2, 3, 7, 64, 512, 8192, withCrlf.length]) {
      expect(textOf(assemble(cut(withCrlf, size)))).toEqual([CAPPED_LINE]);
    }
  });

  /**
   * The divergence with teeth: what comes *after* an overlong line.
   *
   * v0.7.1 read up to the next newline before cutting anything, so everything
   * between the cap and that newline went into the bin with the overflow — and a
   * progress bar has no newline for forty minutes. Here the return ends the
   * oversized line where it happened, and the next line is a line.
   */
  it('keeps what follows an overlong line that a return ended', () => {
    const stream = `${OVERSIZED_LINE}\rSuccess! App '4020' fully installed.\n`;
    const survives = [CAPPED_LINE + TRUNCATION_SUFFIX, "Success! App '4020' fully installed."];

    for (const size of [1, 2, 3, 7, 64, 512, 8192, stream.length]) {
      expect(textOf(assemble(cut(stream, size)))).toEqual(survives);
    }

    // Swallowed whole at the packet size Docker actually uses, and mangled into
    // a line with a control character on the front at one byte a time.
    expect(assembleAsBefore(cut(stream, 16_384))).toEqual([CAPPED_LINE + TRUNCATION_SUFFIX]);
    expect(assembleAsBefore(cut(stream, 1))).toEqual([
      CAPPED_LINE + TRUNCATION_SUFFIX,
      "\rSuccess! App '4020' fully installed.",
    ]);
  });

  /**
   * The overflow guard's boundary, which is a `>` and has to stay one.
   *
   * A line of exactly the cap is not over it, and the byte after it may be the
   * terminator that completes it — so it waits. A `>=` would cut a complete line
   * one byte before its ending arrived and then apologise for it with a marker
   * saying something was missing, which nothing was.
   */
  it('holds an unterminated line of exactly the cap, and cuts the next byte', () => {
    const held = new LineAssembler();

    expect(held.push('x'.repeat(MAX_LINE_LENGTH))).toEqual([]);
    // And it was worth holding: the terminator finishes it intact, with no
    // truncation marker on a line that had nothing missing.
    expect(textOf(held.push('\n'))).toEqual(['x'.repeat(MAX_LINE_LENGTH)]);

    const cutOff = new LineAssembler();
    const [line] = cutOff.push('x'.repeat(MAX_LINE_LENGTH + 1));

    expect(line!.text).toBe('x'.repeat(MAX_LINE_LENGTH) + TRUNCATION_SUFFIX);
    // Nothing of the line is left behind to be handed over twice.
    expect(cutOff.flush()).toEqual([]);
  });

  /**
   * Docker does not align its packets to line endings, so this happens on its
   * own soon enough on a busy server. Counted as two terminators it would give
   * a Minecraft log a blank line between every pair of real ones.
   */
  it('keeps a CRLF that arrived split across two chunks as one line', () => {
    const assembler = new LineAssembler();

    expect(textOf(assembler.push('[12:31:11] [Server thread/INFO]: Done (7.213s)!\r'))).toEqual([
      '[12:31:11] [Server thread/INFO]: Done (7.213s)!',
    ]);
    expect(textOf(assembler.push('\n[12:31:12] [Server thread/INFO]: Timings Reset\r\n'))).toEqual([
      '[12:31:12] [Server thread/INFO]: Timings Reset',
    ]);
    expect(assembler.flush()).toEqual([]);
  });

  // The newline settling a split CRLF can be a packet further off still, and an
  // empty chunk in between decides nothing.
  it('waits out an empty chunk before ruling on a split CRLF', () => {
    const assembler = new LineAssembler();

    expect(textOf(assembler.push('windows\r'))).toEqual(['windows']);
    expect(textOf(assembler.push(''))).toEqual([]);
    expect(textOf(assembler.push('\nunix\n'))).toEqual(['unix']);
  });

  /**
   * The one case where a return really cannot be read until the next byte, and
   * the reason the outstanding return is a union rather than a flag.
   *
   * A `\r` ending a chunk with nothing before it on the row is either the head
   * of a CRLF — a blank line the server printed, which has to appear — or a bare
   * rewind over an untouched row, which is nothing. Nothing else in the stream
   * tells them apart, and guessing "nothing" swallowed a blank line out of every
   * Minecraft log whose packets happened to land between the `\r` and the `\n`.
   */
  it('holds a blank CRLF line split at the boundary until the newline lands', () => {
    const blank = new LineAssembler();

    expect(textOf(blank.push('a\r\n\r'))).toEqual(['a']);
    expect(textOf(blank.push('\nb\r\n'))).toEqual(['', 'b']);

    const rewind = new LineAssembler();

    expect(textOf(rewind.push('a\r\n\r'))).toEqual(['a']);
    expect(textOf(rewind.push('b\r\n'))).toEqual(['b']);
  });

  // A line feed the container really did send, straight after a CRLF, is a
  // blank line of its own and has to stay one.
  it('keeps a blank line written as CRLF', () => {
    expect(textOf(assemble(['a\r\n\r\nb\r\n']))).toEqual(['a', '', 'b']);
    expect(textOf(assemble(['a\r\n\nb\n']))).toEqual(['a', '', 'b']);
  });

  /**
   * A run of returns with nothing between them is a cursor rewinding over a row
   * nothing was written to, which is why it yields nothing. Emitting a blank
   * line per return would let a progress bar that stops moving — a stalled
   * download, exactly when the console matters — scroll the last real output
   * off the top.
   */
  it('emits nothing for a run of carriage returns over an empty line', () => {
    expect(assemble(['\r\r\r'])).toEqual([]);
    expect(textOf(assemble(['a\r\r\rb\n']))).toEqual(['a', 'b']);
    expect(textOf(assemble(['\r\n\r\n']))).toEqual(['', '']);
  });

  /**
   * A container killed mid-refresh, or a `curl` whose last words end in a
   * return: the line was handed over when the return arrived, so the flush has
   * nothing left to add and must not invent an empty line.
   */
  it('has nothing left to flush after a stream ending on a bare return', () => {
    const assembler = new LineAssembler();

    expect(textOf(assembler.push('Success! App "4020" fully installed.\r'))).toEqual([
      'Success! App "4020" fully installed.',
    ]);
    expect(assembler.flush()).toEqual([]);

    // The assembler outlives the container. A newline opening the next one's
    // output is that container's own blank first line, not the tail of a CRLF
    // from the last.
    expect(textOf(assembler.push('\nnext container\n'))).toEqual(['', 'next container']);
  });

  // Two paths to the same cap: a stream with no terminator at all, held back by
  // the guard, and an overlong line that does end in one. Both go through the
  // same normalisation, so both come out cut in the same place and carrying the
  // same marker.
  it('truncates an overlong stream with a terminator and without one', () => {
    const withoutTerminator = new LineAssembler();
    const [blob] = withoutTerminator.push('z'.repeat(MAX_LINE_LENGTH + 1));

    expect(blob!.text).toContain('truncated');
    expect(blob!.text.length).toBe(MAX_LINE_LENGTH + TRUNCATION_SUFFIX.length);

    const withTerminator = new LineAssembler();
    const lines = withTerminator.push(`short\r${'z'.repeat(MAX_LINE_LENGTH + 1)}\r`);

    expect(lines[0]!.text).toBe('short');
    expect(lines[1]!.text).toContain('truncated');
    expect(lines[1]!.text.length).toBe(MAX_LINE_LENGTH + TRUNCATION_SUFFIX.length);
  });
});

/**
 * Which terminal row each line was written on — the half of the split the live
 * stream ignores and the replay lives on.
 */
describe('LineAssembler rows', () => {
  /**
   * The claim the buffer acts on: a bar that redraws itself is one row.
   *
   * The first frame starts a row of its own, because whatever came before it
   * ended with a line feed or there was nothing before it at all. Every refresh
   * after that lands on the same row, which is exactly what the terminal did
   * with them.
   */
  it('marks every refresh after the first as a rewrite of the same row', () => {
    const assembler = new LineAssembler();
    const frames = [0.4, 12.34, 41.62, 78.9].map(steamProgress);

    const rows = frames.flatMap((frame) => assembler.push(frame));

    expect(rows.map((row) => row.overwritesPreviousRow)).toEqual([false, true, true, true]);
  });

  /**
   * The mistake this is built to avoid, and it is a costly one.
   *
   * At one byte a chunk every CRLF in a Minecraft log is split, so every line is
   * handed over on a `\r` whose `\n` has not arrived. A line that guessed its own
   * terminator would call each of them a rewrite of the one before, and a buffer
   * obeying that would keep the last line of the log and drop the other six. The
   * row is read off the *previous* terminator, which by then is known, so this
   * comes out as seven rows however the packets fall.
   */
  it('marks nothing as a rewrite in a CRLF log, however the packets fall', () => {
    for (const size of [1, 2, 3, 7, 64, MINECRAFT_CRLF_LOG.length]) {
      const rows = assemble(cut(MINECRAFT_CRLF_LOG, size));

      expect(rows.map((row) => row.overwritesPreviousRow)).toEqual(rows.map(() => false));
    }
  });

  /**
   * A line feed is a line feed wherever it falls: `\r` then text then `\n` is one
   * row, and the row after it is a new one.
   */
  it('starts a fresh row after a line feed', () => {
    const rows = assemble(['working…\rdone\nnext\n']);

    expect(rows.map((row) => [row.text, row.overwritesPreviousRow])).toEqual([
      // Nothing had been written on this row before it.
      ['working…', false],
      // Written over `working…`, which is what a terminal shows for those bytes.
      ['done', true],
      // The line feed after `done` moved the cursor down.
      ['next', false],
    ]);
  });

  /**
   * A bare return over a row nothing was written to moves nothing, so it must
   * not make the next line a rewrite either — `a\n\rb` is two rows on a terminal,
   * the return having rewound over an empty one.
   */
  it('does not turn a rewind over an empty row into a rewrite', () => {
    const rows = assemble(['a\n\rb\n']);

    expect(rows.map((row) => [row.text, row.overwritesPreviousRow])).toEqual([
      ['a', false],
      ['b', false],
    ]);
  });

  /**
   * The blank line a split CRLF turns out to have been is never a rewrite, and
   * this is the sequence that settles why.
   *
   * `a\r` puts `a` on a row and rewinds; the `\r` opening the next packet rewinds
   * again over the same row without erasing a character of it; the `\n` after
   * that moves down. A terminal still shows `a` — so a blank line allowed to
   * overwrite here would delete a line the operator can see, to stand in for a
   * row that was never empty. An extra blank line is the cheaper mistake.
   */
  it('never lets a blank line from a split CRLF overwrite the row above it', () => {
    const rows = assemble(['a\r', '\r', '\n']);

    expect(rows.map((row) => [row.text, row.overwritesPreviousRow])).toEqual([
      ['a', false],
      ['', false],
    ]);
  });

  /**
   * The same bytes in one packet, which is the case that actually happens.
   *
   * Docker hands over up to sixteen kilobytes at a time and a log line is
   * eighty bytes, so a sequence like this arrives whole far more often than it
   * arrives split — the test above covers the rare path and this covers the
   * common one. They were not always the same code: the rule lived on the
   * boundary branch alone, and in one packet the blank inherited the rewind and
   * deleted the line above it.
   */
  it('applies the same rule when the whole sequence arrives at once', () => {
    expect(assemble(['a\r\r\n']).map((row) => [row.text, row.overwritesPreviousRow])).toEqual([
      ['a', false],
      ['', false],
    ]);
  });

  /**
   * What that defect cost, as the thing an operator loses.
   *
   * A Bukkit readiness line logged with a stray return before its CRLF was
   * replaced in the buffer by an empty string — a blank where "Done" should be,
   * and the line a readiness pattern matches on gone from the replay.
   */
  it('keeps a line a stray return happens to precede', () => {
    expect(replayOf(['[12:31:11] [Server thread/INFO]: Done (7.213s)!\r\r\n'])).toEqual([
      '[12:31:11] [Server thread/INFO]: Done (7.213s)!',
      '',
    ]);
  });

  /**
   * The row flag must not depend on where the socket cut the bytes. That is the
   * contract of this class, and the defect above broke it for a whole family of
   * inputs.
   */
  it('gives the same answer however the packets fall', () => {
    const stream = 'a\r\r\nb\n';
    const whole = assemble([stream]);

    for (const size of [1, 2, 3, 4, 5]) {
      const chunks: string[] = [];

      for (let at = 0; at < stream.length; at += size) {
        chunks.push(stream.slice(at, at + size));
      }

      expect(assemble(chunks)).toEqual(whole);
    }
  });

  /**
   * The frame shape SteamCMD really writes, where the last figure is still
   * unterminated when the stream ends: the flush hands it over on the row the
   * returns left the cursor on, so the whole download is one row and not two.
   */
  it('flushes the last unterminated frame onto the row before it', () => {
    const rows = assemble(['\rprogress: 41.62', '\rprogress: 43.08', '\rprogress: 44.91']);

    expect(rows.map((row) => [row.text, row.overwritesPreviousRow])).toEqual([
      ['progress: 41.62', false],
      ['progress: 43.08', true],
      ['progress: 44.91', true],
    ]);
  });

  /**
   * The assembler outlives the container it was attached to — one per server,
   * flushed when the stream ends and reused by the next start. A new container's
   * first line is not a rewrite of the last words of the one before it, however
   * the last one left its cursor.
   */
  it('starts a fresh row for the next container after a flush', () => {
    const assembler = new LineAssembler();

    // Two frames in one chunk, so that the first return is settled as a bare one
    // and the row really is open when the stream ends.
    expect(assembler.push('progress: 41.62\rprogress: 43.08\r').at(-1)!.overwritesPreviousRow).toBe(
      true,
    );
    expect(assembler.flush()).toEqual([]);

    expect(assembler.push('next container\n')[0]!.overwritesPreviousRow).toBe(false);
  });
});

describe('ConsoleBuffer', () => {
  it('keeps the lines in order', () => {
    const buffer = new ConsoleBuffer(10);
    buffer.pushAll(['a', 'b', 'c']);
    expect(buffer.snapshot()).toEqual(['a', 'b', 'c']);
  });

  it('never exceeds its capacity', () => {
    const buffer = new ConsoleBuffer(3);
    buffer.pushAll(['a', 'b', 'c', 'd', 'e']);

    expect(buffer.size).toBe(3);
    expect(buffer.snapshot()).toEqual(['c', 'd', 'e']);
  });

  it('returns a copy, not the internal reference', () => {
    const buffer = new ConsoleBuffer(5);
    buffer.push('a');

    const snapshot = buffer.snapshot();
    snapshot.push('injected');

    expect(buffer.snapshot()).toEqual(['a']);
  });

  it('clears on request', () => {
    const buffer = new ConsoleBuffer(5);
    buffer.pushAll(['a', 'b']);
    buffer.clear();
    expect(buffer.snapshot()).toEqual([]);
  });

  it('refuses a zero capacity', () => {
    expect(() => new ConsoleBuffer(0)).toThrow();
  });

  it('keeps a run of rewrites as the one row a terminal would show', () => {
    const buffer = new ConsoleBuffer(10);

    buffer.pushAssembled({ text: 'progress: 1%', overwritesPreviousRow: false });
    buffer.pushAssembled({ text: 'progress: 2%', overwritesPreviousRow: true });
    buffer.pushAssembled({ text: 'progress: 3%', overwritesPreviousRow: true });

    expect(buffer.snapshot()).toEqual(['progress: 3%']);
  });

  /**
   * What this whole arrangement is for.
   *
   * A Steam depot refreshes about twice a second and a forty-minute download is
   * five thousand of them — ten times the buffer. Counted one to a line, an
   * operator opening the console afterwards to find out why an install failed
   * would be handed five hundred rows of progress bar and nothing else: not the
   * apt output, not the app id that was asked for, not the warning printed
   * before the transfer began. Every one of those is still here.
   */
  it('does not let a download evict the install log in front of it', () => {
    const preamble = [
      'Reading package lists...',
      'Setting up lib32gcc-s1 (12.2.0-14) ...',
      '[Hopper] The install script asked for app 4020.',
    ];
    const frames = Array.from({ length: 5_000 }, (unused, refresh) =>
      steamProgress((refresh / 5_000) * 100),
    );

    const replay = replayOf([`${preamble.join('\n')}\n`, ...frames]);

    expect(replay.slice(0, preamble.length)).toEqual(preamble);
    expect(replay).toHaveLength(preamble.length + 1);
    expect(replay.at(-1)).toContain('progress: 99.98');
    expect(replay.length).toBeLessThan(CONSOLE_BUFFER_LINES);
  });

  /**
   * A rewrite may only overwrite a row a terminal put there.
   *
   * `[Hopper] …` lines are printed from timers and from the middle of power
   * actions, so one lands between two frames of a bar sooner or later — and the
   * one that lands there is `Giving up on it`, which is the only line saying why
   * the install stopped. It is not part of anybody's progress bar and the next
   * frame does not get to delete it.
   */
  it('never overwrites a line Hopper wrote itself', () => {
    const buffer = new ConsoleBuffer(10);

    buffer.pushAssembled({ text: 'progress: 41.62', overwritesPreviousRow: false });
    buffer.push('[Hopper] Giving up on it: the install container is being stopped.');
    buffer.pushAssembled({ text: 'progress: 41.63', overwritesPreviousRow: true });
    buffer.pushAssembled({ text: 'progress: 41.64', overwritesPreviousRow: true });

    expect(buffer.snapshot()).toEqual([
      'progress: 41.62',
      '[Hopper] Giving up on it: the install container is being stopped.',
      // Appended rather than written over the daemon's line, and then the row it
      // opened carries on as a row.
      'progress: 41.64',
    ]);
  });

  // A reinstall clears the console. The row that was open belonged to the
  // container being replaced, and the first line of the new one is not a
  // rewrite of anything.
  it('closes the open row when it is cleared', () => {
    const buffer = new ConsoleBuffer(10);

    buffer.pushAssembled({ text: 'progress: 41.62', overwritesPreviousRow: false });
    buffer.clear();
    buffer.pushAssembled({ text: 'Reading package lists...', overwritesPreviousRow: true });

    expect(buffer.snapshot()).toEqual(['Reading package lists...']);
  });

  // The oldest lines still go, and a collapsed row is one line for that purpose
  // like any other.
  it('still drops the oldest lines when rewrites are in the mix', () => {
    const buffer = new ConsoleBuffer(2);

    buffer.pushAssembled({ text: 'a', overwritesPreviousRow: false });
    buffer.pushAssembled({ text: 'b', overwritesPreviousRow: false });
    buffer.pushAssembled({ text: 'c', overwritesPreviousRow: false });
    buffer.pushAssembled({ text: 'c bis', overwritesPreviousRow: true });

    expect(buffer.snapshot()).toEqual(['b', 'c bis']);
  });
});

/**
 * How much of an installation survives to be read afterwards.
 *
 * Reported as "long text disappears in the console": an operator reinstalled a
 * server, opened the console, and was replayed the tail of a pip install with
 * the beginning gone — the apt output and the first half of the downloads,
 * which is the half that says what failed. The buffer held five hundred lines
 * and the install printed more.
 *
 * The line count was low because it was standing in for a memory bound, and it
 * is a bad one: a line runs to `MAX_LINE_LENGTH`, so five hundred of them was a
 * four-megabyte worst case. Bounding the bytes directly lets the count go up
 * and brings the worst case down at the same time.
 */
describe('ConsoleBuffer retention', () => {
  it('keeps a whole installation, not its tail', () => {
    const buffer = new ConsoleBuffer();

    // What apt and pip print between them, in the shape they print it.
    for (let index = 0; index < 1500; index += 1) {
      buffer.push(`Downloading package-${index}-py3-none-any.whl (54 kB)`);
    }

    const snapshot = buffer.snapshot();

    expect(snapshot).toHaveLength(1500);
    // The first line is the one that used to be gone, and it is the one an
    // operator reads to find out where an install went wrong.
    expect(snapshot[0]).toContain('package-0-');
  });

  it('stops at the byte budget rather than at the line count', () => {
    const buffer = new ConsoleBuffer();
    const long = 'x'.repeat(MAX_LINE_LENGTH);

    // Well under the line limit, well over the byte one.
    for (let index = 0; index < 200; index += 1) {
      buffer.push(long);
    }

    const held = buffer.snapshot().reduce((total, line) => total + line.length, 0);

    expect(buffer.size).toBeLessThan(200);
    expect(held).toBeLessThanOrEqual(CONSOLE_BUFFER_BYTES);
  });

  it('keeps one line that is larger than the whole budget', () => {
    const buffer = new ConsoleBuffer(2000, 64);

    buffer.push('x'.repeat(500));

    // Evicting it would leave a console showing nothing at all, which is worse
    // than one showing a single enormous line — and the assembler's own cap is
    // what stops that line being unbounded.
    expect(buffer.size).toBe(1);
  });

  /**
   * A progress bar replaces its row rather than appending, and it does so twice
   * a second for the length of a download. If the running total only ever grew,
   * the byte budget would evict the entire buffer within a minute of a depot
   * starting — the exact failure this class keeps rows rather than writes to
   * avoid, reintroduced through the back door.
   */
  it('does not leak bytes when a row is redrawn', () => {
    // A budget the redraws would blow through if each one counted: fifty
    // frames of a hundred characters is five kilobytes of writes against one
    // kilobyte of retention, for output that occupies one row. At the real
    // budget this same leak takes a two-hour download to show, which is how it
    // would have reached an operator rather than a test.
    const buffer = new ConsoleBuffer(2000, 1024);

    buffer.push('an ordinary line');

    for (let index = 0; index < 50; index += 1) {
      buffer.pushAssembled({
        text: `${index} MB downloaded`.padEnd(100, ' '),
        overwritesPreviousRow: index > 0,
      });
    }

    // The line that follows the download is what makes the leak visible: the
    // eviction check runs on an append, so a total inflated by fifty frames
    // pays for itself here by throwing away everything before it.
    buffer.push('Installation finished.');

    expect(buffer.snapshot()[0]).toBe('an ordinary line');
    expect(buffer.size).toBe(3);
  });
});
