import { describe, expect, it } from 'vitest';
import { ConsoleBuffer, LineAssembler, MAX_LINE_LENGTH } from './console-buffer.js';

describe('LineAssembler', () => {
  it('splits a chunk holding several lines', () => {
    const assembler = new LineAssembler();
    expect(assembler.push('une\ndeux\ntrois\n')).toEqual(['une', 'deux', 'trois']);
  });

  // Without reassembly, a line cut across two packets would never match the
  // startup detection regex.
  it('glues back a line that arrived in several chunks', () => {
    const assembler = new LineAssembler();

    expect(assembler.push('Done (12.3')).toEqual([]);
    expect(assembler.push('s)! For help')).toEqual([]);
    expect(assembler.push(', type "help"\n')).toEqual(['Done (12.3s)! For help, type "help"']);
  });

  it('holds an incomplete line until its newline', () => {
    const assembler = new LineAssembler();

    expect(assembler.push('une\npartielle')).toEqual(['une']);
    expect(assembler.push('-suite\n')).toEqual(['partielle-suite']);
  });

  it('strips the carriage returns of CRLF', () => {
    const assembler = new LineAssembler();
    expect(assembler.push('windows\r\nunix\n')).toEqual(['windows', 'unix']);
  });

  it('keeps the empty lines', () => {
    const assembler = new LineAssembler();
    expect(assembler.push('a\n\nb\n')).toEqual(['a', '', 'b']);
  });

  it('gives the partial line back on flush', () => {
    const assembler = new LineAssembler();
    assembler.push('no ending');
    expect(assembler.flush()).toEqual(['no ending']);
    expect(assembler.flush()).toEqual([]);
  });

  it('truncates an outsized line', () => {
    const assembler = new LineAssembler();
    const [line] = assembler.push('x'.repeat(MAX_LINE_LENGTH + 5000) + '\n');

    expect(line!.length).toBeLessThanOrEqual(MAX_LINE_LENGTH + 30);
    expect(line).toContain('truncated');
  });

  // A binary stream with no newline at all would grow the buffer until the
  // daemon ran out of memory.
  it('cuts a newline-free stream instead of swelling forever', () => {
    const assembler = new LineAssembler();
    let emitted: string[] = [];

    for (let index = 0; index < 20; index += 1) {
      emitted = emitted.concat(assembler.push('y'.repeat(1000)));
    }

    expect(emitted.length).toBeGreaterThan(0);
    expect(emitted[0]).toContain('truncated');
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
});
