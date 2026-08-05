import { describe, expect, it } from 'vitest';
import { ALLOWED_FETCH_HOSTS, fetchRemoteFileRequestSchema } from './files.js';

/**
 * The panel chooses the URL the daemon downloads from, so the allowlist is what
 * stands between this route and an open proxy running inside the operator's
 * network. These pin the shape; the daemon has the host check itself, because
 * the panel is the thing an attacker reaches first.
 */
describe('fetchRemoteFileRequestSchema', () => {
  const valid = {
    url: 'https://cdn.modrinth.com/data/AABBCC/versions/1/plugin.jar',
    directory: 'plugins',
    name: 'plugin.jar',
  };

  it('accepts a well-formed request', () => {
    expect(fetchRemoteFileRequestSchema.safeParse(valid).success).toBe(true);
  });

  // The jail folds `../` back inside the volume rather than refusing it, so a
  // name that is really a path lands somewhere other than the folder on screen
  // and the response still reports success. It is refused here, in the
  // contract, exactly as an upload's name is.
  it.each(['../evil.jar', 'plugins/evil.jar', String.raw`a\b.jar`, '.', '..'])(
    'refuses %s as a file name',
    (name) => {
      expect(fetchRemoteFileRequestSchema.safeParse({ ...valid, name }).success).toBe(false);
    },
  );

  it('refuses an address that is not a URL', () => {
    expect(fetchRemoteFileRequestSchema.safeParse({ ...valid, url: 'not-a-url' }).success).toBe(
      false,
    );
  });

  it('accepts a SHA-512 and refuses anything shorter', () => {
    expect(
      fetchRemoteFileRequestSchema.safeParse({ ...valid, sha512: 'a'.repeat(128) }).success,
    ).toBe(true);
    expect(
      fetchRemoteFileRequestSchema.safeParse({ ...valid, sha512: 'a'.repeat(64) }).success,
    ).toBe(false);
    // A SHA-256 in hex is 64 characters; passing one would otherwise be
    // accepted as "some hash" and never match, failing every download.
    expect(fetchRemoteFileRequestSchema.safeParse({ ...valid, sha512: 'ZZZ' }).success).toBe(false);
  });

  it('leaves the checksum optional', () => {
    const { sha512, ...without } = { ...valid, sha512: undefined };
    void sha512;
    expect(fetchRemoteFileRequestSchema.safeParse(without).success).toBe(true);
  });

  // The list is deliberately short. Every entry is a host the daemon will make
  // a request to from inside the operator's network, so adding one is a
  // security decision, not a configuration change.
  describe('the allowlist', () => {
    it('holds only hosts that serve a catalogue', () => {
      expect([...ALLOWED_FETCH_HOSTS]).toEqual(['cdn.modrinth.com']);
    });

    it('names no address that could be internal', () => {
      for (const host of ALLOWED_FETCH_HOSTS) {
        expect(host).not.toMatch(/^(localhost|127\.|10\.|192\.168\.|169\.254\.)/);
        expect(host).toContain('.');
      }
    });
  });
});
