// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useNavigate } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TranslationProvider } from '../../i18n';
import { AdminServersPage } from './Servers';

/**
 * The server list, and how much of a row you have to hit.
 *
 * Only the name was a link: on a five-column row that is a target a few
 * characters wide with four columns of dead space beside it, while every other
 * list in the administration wraps its whole card in a link. The row is the
 * click target now, and the anchor stays — it is what carries keyboard focus,
 * middle-click and "open in a new tab", none of which an onClick offers.
 */

const SERVER = {
  uuid: 'f62a8be1-86c3-4488-9968-7ad4d40d5ebb',
  name: 'Bot',
  description: '',
  status: 'READY',
  memoryBytes: 1024 ** 3,
  diskBytes: 10 * 1024 ** 3,
  cpuPercent: 0,
  node: { uuid: 'node-uuid', name: 'vps-e9d41921', fqdn: 'vps-e9d41921.vps.ovh.net' },
  template: { uuid: 'template-uuid', name: 'Discord bot (Python)' },
  primaryAllocation: { ip: '0.0.0.0', port: 34198, alias: null },
  isOwner: true,
  createdAt: '2026-08-09T00:00:00.000Z',
};

/** Somewhere to press Back from, so the history can be examined. */
function ServerPage() {
  const navigate = useNavigate();

  return (
    <>
      <p>the server page</p>
      <button type="button" onClick={() => void navigate(-1)}>
        back
      </button>
    </>
  );
}

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

function mount() {
  vi.stubGlobal(
    'fetch',
    vi.fn((input: string) =>
      Promise.resolve(
        input === '/api/panel'
          ? json({ name: 'Hopper', locale: 'en' })
          : input.startsWith('/api/admin/servers')
            ? json({ data: [SERVER], meta: { total: 1, currentPage: 1, perPage: 25, lastPage: 1 } })
            : json({ data: [], meta: { total: 0 } }),
      ),
    ),
  );

  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });

  render(
    <QueryClientProvider client={client}>
      <TranslationProvider>
        <MemoryRouter initialEntries={['/admin/servers']}>
          <Routes>
            <Route path="/admin/servers" element={<AdminServersPage />} />
            <Route path="/admin/servers/:uuid" element={<ServerPage />} />
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

describe('the admin server list', () => {
  it('opens the server from anywhere on its row', async () => {
    mount();

    // The memory cell — as far from the name as a click gets on this row, and
    // dead space until now.
    fireEvent.click(await screen.findByText('1 GiB'));

    expect(await screen.findByText('the server page')).toBeTruthy();
  });

  it('still opens it from the name', async () => {
    mount();

    fireEvent.click(await screen.findByText('Bot'));

    expect(await screen.findByText('the server page')).toBeTruthy();
  });

  /**
   * The anchor navigates by itself, so the row must not act on the same click.
   *
   * Asserted through the history rather than through a spy on the row, because
   * a spy only proves the listener ran — which it should. What matters is
   * whether it *acted*: two navigations to one route push two identical
   * entries, and Back then appears to do nothing the first time it is pressed.
   */
  it('pushes one history entry when the name itself is clicked', async () => {
    mount();

    fireEvent.click(await screen.findByRole('link', { name: 'Bot' }));
    expect(await screen.findByText('the server page')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'back' }));

    // One Back is enough. With the guard removed it takes two, because the row
    // pushed the same route a second time.
    expect(await screen.findByText('Bot')).toBeTruthy();
  });
});
