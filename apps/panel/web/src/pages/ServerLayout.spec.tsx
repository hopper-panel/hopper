// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TranslationProvider } from '../i18n';
import { ServerLayout } from './ServerLayout';

// The layout owns the console connection; a WebSocket has no business in a
// test about which tabs are drawn.
vi.mock('../lib/use-console', () => ({ useConsole: () => ({}) }));

/**
 * Which tabs a server gets, from what the panel says about it.
 *
 * The Plugins tab follows `pluginLoader` in the server summary, which the panel
 * reads from the same table the plugin routes refuse against. Both halves are
 * tested on their own side; this is the join — the field arriving, and the tab
 * listening to it — which is the part that can break with every test on either
 * side still green.
 */

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

function mount(pluginLoader: string | null): void {
  vi.stubGlobal(
    'fetch',
    vi.fn((input: string) => {
      if (input === '/api/panel') {
        return Promise.resolve(json({ defaultLocale: 'en' }));
      }

      if (input.endsWith('/permissions')) {
        // Every permission: whatever is missing below is missing for a reason
        // other than access.
        return Promise.resolve(json({ permissions: ['file.read', 'file.create'], isOwner: true }));
      }

      return Promise.resolve(
        json({
          uuid: 'srv-uuid',
          name: 'Test server',
          template: { uuid: 'template-uuid', name: 'Template' },
          pluginLoader,
        }),
      );
    }),
  );

  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });

  render(
    <QueryClientProvider client={client}>
      <TranslationProvider>
        <MemoryRouter initialEntries={['/server/srv-uuid']}>
          <Routes>
            <Route path="/server/:uuid" element={<ServerLayout />} />
          </Routes>
        </MemoryRouter>
      </TranslationProvider>
    </QueryClientProvider>,
  );
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('ServerLayout tabs', () => {
  it('shows Plugins on a server that loads them', async () => {
    mount('paper');

    expect(await screen.findByRole('link', { name: 'Files' })).toBeTruthy();
    expect(screen.queryByRole('link', { name: 'Plugins' })).not.toBeNull();
  });

  it('hides Plugins on a server that loads nothing', async () => {
    // Garry's Mod, Factorio, a Discord bot — and vanilla Minecraft, which is
    // the same answer for the same reason.
    mount(null);

    // Files is waited on first, so the absence below is read off a rendered bar
    // rather than off a page still loading.
    expect(await screen.findByRole('link', { name: 'Files' })).toBeTruthy();
    expect(screen.queryByRole('link', { name: 'Plugins' })).toBeNull();
  });
});
