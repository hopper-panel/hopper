import { StringDecoder } from 'node:string_decoder';

/**
 * Docker's multiplexed attach stream, turned back into text.
 *
 * A container created with `Tty: true` writes straight down the attach socket,
 * and reading it is `chunk.toString()`. Without a tty, Docker interleaves the
 * two output streams and frames each piece: eight bytes of header — one for
 * which stream it came from, three reserved and zero, four for the payload
 * length, big-endian — and then the payload. Read as text, those headers are
 * eight bytes of control characters in the middle of every line.
 *
 * Both streams are merged into one, which is what a tty gave: an install script
 * writing to stderr belongs in the console beside what it wrote to stdout,
 * in the order it wrote them.
 *
 * A frame straddles chunks whenever a download is fast enough to fill a socket
 * read, so the header and the payload are both reassembled here rather than
 * assumed whole. The text is decoded through a {@link StringDecoder} for the
 * same reason one level down: a multi-byte character split across two frames
 * used to come out as two replacement characters, and did so before this class
 * existed too — `chunk.toString('utf8')` has the same seam at every chunk
 * boundary.
 */
export class DockerFrameReader {
  private pending: Buffer = Buffer.alloc(0);
  private readonly decoder = new StringDecoder('utf8');

  /**
   * True once a header made no sense, after which everything is passed through
   * as text.
   *
   * It should never happen: the daemon creates the containers it attaches to,
   * so it knows which of them have a tty. The fallback is here because the
   * alternative failure is the worst one available — an install console filling
   * with binary, on the screen somebody is watching to find out why their
   * installation is not working.
   */
  private unframed = false;

  push(chunk: Buffer): string {
    if (this.unframed) {
      return this.decoder.write(chunk);
    }

    this.pending = this.pending.length === 0 ? chunk : Buffer.concat([this.pending, chunk]);

    let text = '';

    for (;;) {
      if (this.pending.length < HEADER_BYTES) {
        return text;
      }

      // The three reserved bytes, and the stream byte's own range. Checked
      // rather than skipped: this is the only place that can tell a frame from
      // a stream that was never framed, and it costs three comparisons per
      // frame.
      const stream = this.pending[0]!;
      const reserved = this.pending.readUIntBE(1, 3);

      if (stream > STDERR_STREAM || reserved !== 0) {
        this.unframed = true;

        const rest = this.pending;
        this.pending = Buffer.alloc(0);

        return text + this.decoder.write(rest);
      }

      const size = this.pending.readUInt32BE(4);

      if (this.pending.length < HEADER_BYTES + size) {
        return text;
      }

      text += this.decoder.write(this.pending.subarray(HEADER_BYTES, HEADER_BYTES + size));
      this.pending = this.pending.subarray(HEADER_BYTES + size);
    }
  }

  /** Whether a header failed to parse, and everything since has been raw text. */
  get sawUnframedBytes(): boolean {
    return this.unframed;
  }
}

const HEADER_BYTES = 8;
const STDERR_STREAM = 2;
