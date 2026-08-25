// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TranslationProvider } from '../i18n';
import { WrongAddressBanner } from './WrongAddressBanner';

/**
 * The banner that names the address the panel answers to.
 *
 * It is the one thing on the page that can explain an empty console, so it has
 * to appear when the addresses differ — and it has to stay away when they do
 * not. A banner shown to everybody on a correctly configured panel is worse
 * than no banner at all: it is read once, disbelieved, and then ignored on the
 * day it is right.
 */

function mount(url: string | undefined): QueryClient {
  vi.stubGlobal(
    'fetch',
    vi.fn(() =>
      Promise.resolve(
        new Response(JSON.stringify({ name: 'Hopper', defaultLocale: 'en', url }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      ),
    ),
  );

  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });

  render(
    <QueryClientProvider client={client}>
      <TranslationProvider>
        <WrongAddressBanner />
      </TranslationProvider>
    </QueryClientProvider>,
  );

  return client;
}

/**
 * Waits for the answer to have landed in the cache.
 *
 * The two negative tests need this: the banner renders nothing while the
 * request is in flight, so asserting on an empty document straight away would
 * pass whatever the verdict turned out to be.
 */
const settled = (client: QueryClient): Promise<unknown> =>
  waitFor(() => expect(client.getQueryData(['panel', 'branding'])).toBeDefined());

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('WrongAddressBanner', () => {
  it('offers the way to the address the panel answers to', async () => {
    mount('https://panel.example.com');

    const link = await screen.findByRole('link');

    expect(link.getAttribute('href')).toBe('https://panel.example.com');
    expect(screen.getByText(/panel\.example\.com/)).toBeTruthy();
  });

  it('stays away when the browser is already there', async () => {
    await settled(mount(window.location.origin));

    expect(screen.queryByRole('link')).toBeNull();
  });

  it('says nothing to a panel too old to name its address', async () => {
    await settled(mount(undefined));

    expect(screen.queryByRole('link')).toBeNull();
  });
});
