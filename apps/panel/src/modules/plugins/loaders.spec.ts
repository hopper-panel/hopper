import { TEMPLATE_CATALOG } from '@hopper/templates';
import { describe, expect, it } from 'vitest';
import { pluginLoaderFor } from './loaders.js';

/**
 * The table behind both the Plugins tab and the plugin routes.
 *
 * The tab is shown on exactly the servers this names, and the routes refuse
 * exactly the others: one answer, read twice. What is tested here is the part a
 * person would notice — which of the templates Hopper ships get the tab.
 */

describe('pluginLoaderFor', () => {
  it('names the loader of every template that reads plugins or mods', () => {
    for (const key of ['paper', 'purpur', 'fabric', 'neoforge', 'velocity', 'bungeecord']) {
      expect(pluginLoaderFor(key)).toBe(key);
    }
  });

  it('answers null for vanilla, which is Minecraft and still loads nothing', () => {
    // The tab would have opened on a catalogue whose every install is refused.
    expect(pluginLoaderFor('vanilla')).toBeNull();
  });

  it('answers null for a key it has never heard of', () => {
    // An imported egg or a template written in the editor: nothing is known
    // about what it loads, so nothing is offered.
    expect(pluginLoaderFor('some-imported-egg')).toBeNull();
  });

  it('gives the tab to no shipped template outside the Minecraft family', () => {
    const offered = TEMPLATE_CATALOG.filter((template) => pluginLoaderFor(template.key) !== null)
      .map((template) => template.key)
      .sort();

    expect(offered).toEqual(['bungeecord', 'fabric', 'neoforge', 'paper', 'purpur', 'velocity']);
  });
});
