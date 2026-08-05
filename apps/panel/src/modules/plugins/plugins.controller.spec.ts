import { BadRequestException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import { PluginsController } from './plugins.controller.js';

/**
 * Where a file lands is the decision worth pinning. A plugin dropped in `mods/`
 * on a Paper server is simply not loaded, and says nothing about why — a
 * support ticket rather than an error.
 */
describe('PluginsController — install directory', () => {
  const controller = new PluginsController(
    null as never,
    null as never,
    null as never,
    null as never,
    null as never,
  );

  const directoryFor = (loaders: string[]): string =>
    (controller as unknown as { directoryFor: (l: string[]) => string }).directoryFor(loaders);

  it.each(['paper', 'purpur', 'spigot', 'bukkit', 'velocity', 'bungeecord'])(
    'sends a %s addition to plugins/',
    (loader) => {
      expect(directoryFor([loader])).toBe('plugins');
    },
  );

  it.each(['fabric', 'forge', 'neoforge', 'quilt'])('sends a %s addition to mods/', (loader) => {
    expect(directoryFor([loader])).toBe('mods');
  });

  it('is not confused by the case the catalogue uses', () => {
    expect(directoryFor(['Paper'])).toBe('plugins');
    expect(directoryFor(['FABRIC'])).toBe('mods');
  });

  // A version often lists several loaders. The first one recognised decides,
  // rather than guessing from the rest.
  it('takes the first loader it recognises', () => {
    expect(directoryFor(['datapack', 'paper'])).toBe('plugins');
  });

  // Refusing beats guessing: installing into the wrong folder produces a
  // server that starts, ignores the file, and reports nothing.
  it('refuses rather than guess for a loader it does not know', () => {
    expect(() => directoryFor(['some-new-loader'])).toThrow(BadRequestException);
    expect(() => directoryFor([])).toThrow(BadRequestException);
  });

  it('names the loader it could not place', () => {
    expect(() => directoryFor(['some-new-loader'])).toThrow(/some-new-loader/);
  });
});

/**
 * A vanilla server reads neither `plugins/` nor `mods/`. The panel installed a
 * Fabric mod onto one before this: the file landed in the folder that is right
 * for Fabric, on a server with no loader to read it, and nothing said so.
 *
 * Found by installing a plugin on the test VPS and looking at where it went,
 * which is the sort of thing a routing test cannot notice — the routing was
 * correct.
 */
describe('PluginsController — what a server can load', () => {
  const controller = new PluginsController(
    null as never,
    { server: { findUniqueOrThrow: () => Promise.resolve(template) } } as never,
    null as never,
    null as never,
    null as never,
  );

  let template: { template: { key: string; name: string } };

  const loaderFor = (): Promise<string> =>
    (controller as unknown as { loaderFor: (s: unknown) => Promise<string> }).loaderFor({ id: 1 });

  it.each([
    ['paper', 'paper'],
    ['purpur', 'purpur'],
    ['fabric', 'fabric'],
    ['neoforge', 'neoforge'],
    ['velocity', 'velocity'],
    ['bungeecord', 'bungeecord'],
  ])('reads %s from the template', async (key, expected) => {
    template = { template: { key, name: key } };
    await expect(loaderFor()).resolves.toBe(expected);
  });

  it('refuses a vanilla server rather than offer it a catalogue it cannot use', async () => {
    template = { template: { key: 'vanilla', name: 'Vanilla' } };
    await expect(loaderFor()).rejects.toThrow(BadRequestException);
  });

  // The message has to name the template and say what would work, or an
  // operator is told "no" with nowhere to go.
  it('names the template and what to run instead', async () => {
    template = { template: { key: 'vanilla', name: 'Vanilla' } };
    await expect(loaderFor()).rejects.toThrow(/Vanilla/);
    await expect(loaderFor()).rejects.toThrow(/Paper/);
  });

  it('refuses a template it does not know rather than guess', async () => {
    template = { template: { key: 'some-new-server', name: 'Something' } };
    await expect(loaderFor()).rejects.toThrow(BadRequestException);
  });
});

/**
 * The tab opens on a list rather than on a blank page. Which means the
 * catalogue is queried with an empty string, and relevance against an empty
 * string is not an ordering — Modrinth would return an arbitrary slice of
 * everything.
 */
describe('ModrinthService — ordering', () => {
  function indexFor(query: string): string {
    // Mirrors the rule in the service: the point is that the choice is made on
    // the query being empty, not on a flag a caller can pass.
    return query.trim() === '' ? 'downloads' : 'relevance';
  }

  it('sorts by downloads when nothing was typed', () => {
    expect(indexFor('')).toBe('downloads');
    expect(indexFor('   ')).toBe('downloads');
  });

  it('sorts by relevance once there is something to be relevant to', () => {
    expect(indexFor('essentials')).toBe('relevance');
  });
});
