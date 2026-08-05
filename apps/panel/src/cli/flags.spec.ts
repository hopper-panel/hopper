import { describe, expect, it } from 'vitest';
import { parseFlags, textOf } from './flags.js';

describe('parseFlags', () => {
  it('reads an option and its value', () => {
    expect(parseFlags(['--username', 'julien']).get('username')).toBe('julien');
  });

  it('accepts the joined form', () => {
    expect(parseFlags(['--username=julien']).get('username')).toBe('julien');
  });

  it('keeps a value containing an equals sign', () => {
    // A base64-generated password often ends with "=".
    expect(parseFlags(['--password=aG9wcGVy==']).get('password')).toBe('aG9wcGVy==');
  });

  it('treats an option with no value as a flag', () => {
    expect(parseFlags(['--admin']).get('admin')).toBe(true);
  });

  it('does not take the next option as a flag value', () => {
    // The trap: `--admin --username x` has to create an administrator named x,
    // not an ordinary user named x with `admin=--username`.
    const flags = parseFlags(['--admin', '--username', 'x']);

    expect(flags.get('admin')).toBe(true);
    expect(flags.get('username')).toBe('x');
  });

  it('ignores what is not an option', () => {
    expect([...parseFlags(['doctor', 'bruit', '--verbose']).keys()]).toEqual(['verbose']);
  });

  it('keeps the last value of a repeated option', () => {
    expect(parseFlags(['--name', 'a', '--name', 'b']).get('name')).toBe('b');
  });

  it('accepts an explicitly empty value', () => {
    expect(parseFlags(['--description=']).get('description')).toBe('');
  });
});

describe('textOf', () => {
  it('returns the textual value', () => {
    expect(textOf(parseFlags(['--name', 'paris']), 'name')).toBe('paris');
  });

  it('returns undefined for a missing option', () => {
    expect(textOf(parseFlags([]), 'name')).toBeUndefined();
  });

  it('returns undefined for a bare option', () => {
    // `--password` with no value must not pass for an empty password: it would
    // be accepted by the schema, hashed, and impossible to recover.
    expect(textOf(parseFlags(['--password']), 'password')).toBeUndefined();
  });
});
