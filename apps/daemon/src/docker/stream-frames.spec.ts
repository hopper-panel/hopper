import { describe, expect, it } from 'vitest';
import { DockerFrameReader } from './stream-frames.js';

/**
 * Reading an attach stream that has no tty behind it.
 *
 * The install container lost its tty because SteamCMD will not install through
 * one — measured, and the reason this class exists at all. What it must not
 * cost is the install console: an operator watching six gigabytes arrive reads
 * these lines to find out whether anything is happening.
 */

const STDOUT = 1;
const STDERR = 2;

/** One Docker frame: stream byte, three zeroes, big-endian length, payload. */
function frame(stream: number, payload: string): Buffer {
  const body = Buffer.from(payload, 'utf8');
  const header = Buffer.alloc(8);

  header[0] = stream;
  header.writeUInt32BE(body.length, 4);

  return Buffer.concat([header, body]);
}

describe('DockerFrameReader', () => {
  it('strips the header off a frame', () => {
    const reader = new DockerFrameReader();

    expect(reader.push(frame(STDOUT, 'Installing…\n'))).toBe('Installing…\n');
  });

  it('reads several frames out of one chunk', () => {
    const reader = new DockerFrameReader();

    const chunk = Buffer.concat([frame(STDOUT, 'one\n'), frame(STDERR, 'two\n')]);

    expect(reader.push(chunk)).toBe('one\ntwo\n');
  });

  it('keeps stdout and stderr in the order they were written', () => {
    // One console, as a tty gave: a script that writes its progress to stdout
    // and its warnings to stderr has to be readable as it was written.
    const reader = new DockerFrameReader();

    expect(reader.push(frame(STDERR, 'warning\n'))).toBe('warning\n');
    expect(reader.push(frame(STDOUT, 'done\n'))).toBe('done\n');
  });

  it('waits for a header split across two reads', () => {
    // A socket read ends wherever it ends. Four bytes of header is not a frame
    // and must not be guessed at.
    const reader = new DockerFrameReader();
    const whole = frame(STDOUT, 'progress: 41.62\n');

    expect(reader.push(whole.subarray(0, 4))).toBe('');
    expect(reader.push(whole.subarray(4))).toBe('progress: 41.62\n');
  });

  it('waits for a payload split across two reads', () => {
    // Held whole rather than emitted as it arrives: a frame is one write by the
    // container, so it is small, and half of one is not a thing to show. What
    // keeps the stall detector honest through this is that it counts raw bytes
    // off the socket, upstream of here.
    const reader = new DockerFrameReader();
    const whole = frame(STDOUT, 'a download, mid-flight\n');

    expect(reader.push(whole.subarray(0, 12))).toBe('');
    expect(reader.push(whole.subarray(12))).toBe('a download, mid-flight\n');
  });

  it('holds a multi-byte character back rather than mangling it', () => {
    // The seam `chunk.toString("utf8")` had at every chunk boundary, and now
    // has at every frame boundary too: the install scripts print em dashes and
    // the templates are written in a language with accents.
    const reader = new DockerFrameReader();
    const bytes = Buffer.from('é', 'utf8');

    // One character, two frames — which is what Docker does when its own read
    // lands between the two bytes.
    const first = Buffer.concat([Buffer.from([STDOUT, 0, 0, 0, 0, 0, 0, 1]), bytes.subarray(0, 1)]);
    const second = Buffer.concat([Buffer.from([STDOUT, 0, 0, 0, 0, 0, 0, 1]), bytes.subarray(1)]);

    expect(reader.push(first)).toBe('');
    expect(reader.push(second)).toBe('é');
  });

  it('carries a frame boundary through the middle of a line', () => {
    // Frames are not lines. Docker splits on its own read sizes, and the
    // assembler downstream is the thing that knows what a line is.
    const reader = new DockerFrameReader();

    expect(reader.push(frame(STDOUT, 'Update state (0x61) '))).toBe('Update state (0x61) ');
    expect(reader.push(frame(STDOUT, 'downloading\n'))).toBe('downloading\n');
  });

  it('gives up on framing rather than printing binary', () => {
    // It should never come to this: the daemon creates the containers it
    // attaches to, so it knows which of them have a tty. But a console filling
    // with control characters is the worst failure available here — it is the
    // screen somebody is watching to find out why their install is stuck.
    const reader = new DockerFrameReader();

    expect(reader.push(Buffer.from('a tty stream, unframed\n', 'utf8'))).toBe(
      'a tty stream, unframed\n',
    );
    expect(reader.sawUnframedBytes).toBe(true);
  });

  it('stays in text once it has given up', () => {
    const reader = new DockerFrameReader();

    reader.push(Buffer.from('plain\n', 'utf8'));

    // Not re-examined: a stream that was never framed does not become framed,
    // and a byte that happens to look like a header must not turn it back.
    expect(reader.push(frame(STDOUT, 'x'))).toContain('x');
  });
});
