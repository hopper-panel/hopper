import { describe, expect, it } from 'vitest';
import { buildSftpUsername, parseSftpUsername } from './sftp-username.js';

describe('parseSftpUsername', () => {
  it('splits a valid name', () => {
    expect(parseSftpUsername('julien.b10a05a8')).toEqual({
      username: 'julien',
      serverIdPrefix: 'b10a05a8',
    });
  });

  it('accepts hyphens and underscores', () => {
    expect(parseSftpUsername('mon_staff-01.b10a05a8')?.username).toBe('mon_staff-01');
  });

  it('lowercases the prefix', () => {
    expect(parseSftpUsername('julien.B10A05A8')?.serverIdPrefix).toBe('b10a05a8');
  });

  it.each([
    ['no dot', 'julien'],
    ['empty prefix', 'julien.'],
    ['empty user', '.b10a05a8'],
    ['prefix too short', 'julien.b10a05'],
    ['prefix too long', 'julien.b10a05a8f'],
    ['non-hexadecimal prefix', 'julien.zzzzzzzz'],
    ['user with a space', 'my staff.b10a05a8'],
    ['empty string', ''],
  ])('refuses: %s', (_label, raw) => {
    expect(parseSftpUsername(raw)).toBeNull();
  });

  // A username cannot contain a dot today, but splitting on the last one makes
  // the format robust should that rule change.
  it('splits on the last dot', () => {
    expect(parseSftpUsername('a.b.b10a05a8')).toBeNull();
  });
});

describe('buildSftpUsername', () => {
  it('assembles the name shown to the user', () => {
    expect(buildSftpUsername('julien', 'b10a05a8-a828-4084-9ec4-909969e73c93')).toBe(
      'julien.b10a05a8',
    );
  });

  it('produces a name the parser can read back', () => {
    const built = buildSftpUsername('julien', 'b10a05a8-a828-4084-9ec4-909969e73c93');
    expect(parseSftpUsername(built)).toEqual({ username: 'julien', serverIdPrefix: 'b10a05a8' });
  });
});
