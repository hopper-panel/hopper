import { describe, expect, it } from 'vitest';
import { cacheControlFor, isApiPath, resolveWebRoot } from './web-assets.js';

/**
 * These tests exist because the deployed panel answered 404 on `/`: the API was
 * running, but no interface was being served. Vite handled it in development,
 * and nobody took over in production.
 */
describe('isApiPath', () => {
  // The SPA fallback returns `index.html` for any unknown URL. Applied to the
  // API, it would hand HTML to a client expecting JSON — a failure far harder
  // to diagnose than a plain 404.
  it.each(['/api', '/api/', '/api/servers', '/api/auth/login'])('recognises %s', (path) => {
    expect(isApiPath(path)).toBe(true);
  });

  it.each(['/', '/servers/abc', '/assets/index-a1b2.js', '/apiary', '/x/api/y'])(
    'leaves %s to the interface',
    (path) => {
      expect(isApiPath(path)).toBe(false);
    },
  );
});

describe('cacheControlFor', () => {
  // Vite stamps a digest into the names of the files in `assets/`: under a
  // given name, the content never changes.
  it('makes the digest-stamped files immutable', () => {
    expect(cacheControlFor('/assets/index-a1b2c3.js')).toContain('immutable');
    expect(cacheControlFor('/assets/index-a1b2c3.js')).toContain('max-age=31536000');
  });

  // `index.html` references those stamped names. If it were cached, a browser
  // would keep loading the old application after an update, asking for files
  // that no longer exist.
  it('forbids caching the document', () => {
    expect(cacheControlFor('/index.html')).toContain('no-cache');
    expect(cacheControlFor('/')).toContain('no-cache');
  });
});

describe('resolveWebRoot', () => {
  // The default is relative to the working directory, which is `apps/panel` in
  // the systemd unit.
  it('resolves the default from the working directory', () => {
    // A suffix and not equality: on Windows, `resolve` prefixes the drive
    // letter. What is checked is that the path is anchored to the working
    // directory.
    const resolved = resolveWebRoot('web/dist', '/opt/hopper/apps/panel').replace(/\\/g, '/');
    expect(resolved).toMatch(/\/opt\/hopper\/apps\/panel\/web\/dist$/);
  });

  // A deployment that puts the front elsewhere has to be able to impose it
  // without the panel reinterpreting the path.
  it('honours an absolute path', () => {
    const resolved = resolveWebRoot('/srv/hopper-ui', '/opt/hopper/apps/panel').replace(/\\/g, '/');
    expect(resolved).toMatch(/\/srv\/hopper-ui$/);
  });
});
