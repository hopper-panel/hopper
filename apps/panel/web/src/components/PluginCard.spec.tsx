// @vitest-environment jsdom

import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TranslationProvider } from '../i18n';
import { PluginCard, type PluginHit } from './PluginCard';

/**
 * The card, and the three judgement calls in it.
 *
 * Every icon on this page rendered as a broken image in production, because
 * the panel's Content-Security-Policy allowed `'self' data:` and the catalogue
 * serves its icons from a CDN. The browser refused them silently — nothing
 * reached a log the panel could see, and the API answered 200 the whole time.
 *
 * The policy is fixed in `main.ts`. What is checked here is the markup that
 * has to be right for the fix to be worth anything, and the fallback for the
 * plugins the catalogue has no icon for at all.
 */

const HIT: PluginHit = {
  projectId: 'p1',
  slug: 'veinminer',
  title: 'VeinMiner',
  description: 'Mine the whole vein on mining a single ore.',
  downloads: 68_699_360,
  iconUrl: 'https://cdn.modrinth.com/data/p1/icon.png',
  categories: ['paper', 'folia', 'utility', 'game-mechanics'],
};

function mount(hit: PluginHit) {
  vi.stubGlobal(
    'fetch',
    vi.fn(() =>
      Promise.resolve(
        new Response(JSON.stringify({ defaultLocale: 'en' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      ),
    ),
  );

  return render(
    <TranslationProvider>
      <PluginCard hit={hit} expanded={false} onToggle={() => {}} />
    </TranslationProvider>,
  );
}

describe('PluginCard', () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('loads the icon lazily and without a referrer', () => {
    const { container } = mount(HIT);

    const icon = container.querySelector('img');

    expect(icon?.getAttribute('src')).toBe(HIT.iconUrl);
    // Modrinth learns that somebody wanted an icon, not which panel they were
    // looking at.
    expect(icon?.getAttribute('referrerpolicy')).toBe('no-referrer');
    // A dozen of these are below the fold and the operator reads three.
    expect(icon?.getAttribute('loading')).toBe('lazy');
  });

  it('falls back to the initial rather than an empty square', () => {
    const { container } = mount({ ...HIT, iconUrl: null });

    expect(container.querySelector('img')).toBeNull();
    expect(screen.getByText('V')).toBeTruthy();
  });

  it('reads the download count at a glance', () => {
    mount(HIT);

    // "68 699 360" is eight characters of noise beside a name, and nobody
    // compares two of them.
    expect(screen.getByText('68.7M downloads')).toBeTruthy();
    expect(screen.queryByText(/68,699,360|68 699 360/)).toBeNull();
  });

  it('tells the loaders apart from the categories', () => {
    mount(HIT);

    // The loader decides whether this can run here at all; "utility" describes
    // what it does. Modrinth returns them in one list, which made every card
    // read as a pile of tags with the important one buried in it.
    for (const loader of ['paper', 'folia']) {
      expect(screen.getByText(loader)).toBeTruthy();
    }

    expect(screen.getByText('utility')).toBeTruthy();
  });

  it('links out to the project page', () => {
    const { container } = mount(HIT);

    const link = container.querySelector('a');

    expect(link?.getAttribute('href')).toBe('https://modrinth.com/project/veinminer');
    // A page the panel does not control never gets a handle on this window.
    expect(link?.getAttribute('rel')).toContain('noopener');
  });
});
