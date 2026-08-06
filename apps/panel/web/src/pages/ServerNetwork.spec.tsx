// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Outlet, Route, Routes } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TranslationProvider } from '../i18n';
import type { ServerContext } from '../lib/server-context';
import { ServerNetworkPage } from './ServerNetwork';

/**
 * Naming a port, from the only screen that can do it.
 *
 * A name is not the alias next to it: the daemon matches a readiness `role`
 * against it and knocks on whatever carries it. The two things this screen has
 * to get right are therefore that the primary port is not offered a name — it
 * is already what a strategy naming nothing resolves to, and the API refuses
 * one anyway — and that a refusal coming back from the API is read, because
 * the whole point of refusing is that somebody sees it.
 */

const ALLOCATIONS = {
  data: [
    { id: 1, ip: '0.0.0.0', port: 25565, alias: null, role: null, primary: true },
    { id: 2, ip: '0.0.0.0', port: 25575, alias: null, role: null, primary: false },
  ],
  meta: { limit: 4, used: 2, availableOnNode: 7 },
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

const context = { can: () => true } as unknown as ServerContext;

function mount(): void {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });

  render(
    <QueryClientProvider client={client}>
      <TranslationProvider>
        <MemoryRouter initialEntries={['/servers/srv-uuid/network']}>
          <Routes>
            <Route path="/servers/:uuid" element={<Outlet context={context} />}>
              <Route path="network" element={<ServerNetworkPage />} />
            </Route>
          </Routes>
        </MemoryRouter>
      </TranslationProvider>
    </QueryClientProvider>,
  );
}

/** Answers the listing, and hands every other call to the caller's stub. */
function stubFetch(onWrite: (input: string, init?: RequestInit) => Response) {
  const fetch = vi.fn((input: string, init?: RequestInit) => {
    if (input === '/api/panel') {
      return Promise.resolve(json({ defaultLocale: 'en' }));
    }

    if (input.endsWith('/allocations') && (init?.method ?? 'GET') === 'GET') {
      return Promise.resolve(json(ALLOCATIONS));
    }

    return Promise.resolve(onWrite(input, init));
  });

  vi.stubGlobal('fetch', fetch);

  return fetch;
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('naming a port', () => {
  it('offers a name for every port except the primary one', async () => {
    stubFetch(() => json({}));
    mount();

    // Two ports, one field: the primary is reached by being the primary, and a
    // second name for it would be a second way to mean one port.
    const fields = await screen.findAllByPlaceholderText('Name — rcon, query…');

    expect(fields).toHaveLength(1);
    // Both rows rendered, so the single field is a choice and not a listing
    // that failed to load.
    expect(screen.getAllByPlaceholderText(/^Note —/)).toHaveLength(2);
  });

  it('saves the name on its own route, leaving the note alone', async () => {
    // Its own request because storing a name asks the node whether its daemon
    // understands names at all, and every edit of a free-text note must not
    // pay for that round trip.
    const fetch = stubFetch(() =>
      json({ id: 2, ip: '0.0.0.0', port: 25575, alias: null, role: 'rcon', primary: false }),
    );

    mount();

    const field = await screen.findByPlaceholderText('Name — rcon, query…');

    fireEvent.change(field, { target: { value: 'rcon' } });
    fireEvent.blur(field);

    await waitFor(() =>
      expect(
        fetch.mock.calls.some(
          ([input, init]) =>
            input === '/api/servers/srv-uuid/allocations/2/role' &&
            init?.body === JSON.stringify({ role: 'rcon' }),
        ),
      ).toBe(true),
    );
  });

  it('shows the refusal rather than a field that looks saved', async () => {
    // The refusal the panel exists to give: a node whose daemon predates names
    // would strip the field and go on using the game port, and nobody would be
    // told. An operator who does not read this believes a check is running.
    stubFetch(() =>
      json(
        { message: 'The daemon on this server’s node is too old to understand named ports.' },
        409,
      ),
    );

    mount();

    const field = await screen.findByPlaceholderText('Name — rcon, query…');

    fireEvent.change(field, { target: { value: 'rcon' } });
    fireEvent.blur(field);

    expect(await screen.findByText(/too old to understand named ports/)).toBeTruthy();
  });
});
