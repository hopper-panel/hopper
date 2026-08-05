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
