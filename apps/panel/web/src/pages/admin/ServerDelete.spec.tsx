// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TranslationProvider } from '../../i18n';
import { AdminServerDetailPage } from './ServerDetail';

/**
 * Deleting a server, and the list it goes back to.
 *
 * The page navigated to `/admin/servers` and invalidated nothing, so the list
 * came out of the cache with the deleted server still in it — the operator
 * pressed Delete, confirmed, watched the page change, and found the row exactly
 * where it had been. Nothing was wrong on the server; the row was a memory.
 *
 * Tested through the invalidation rather than through the list, because the
 * fault was here: the creation path a few lines above had always invalidated
 * both keys and the deletion invalidated neither, and no amount of rendering
 * the other page would have said so.
 */

const UUID = 'f62a8be1-86c3-4488-9968-7ad4d40d5ebb';

const SERVER = {
  uuid: UUID,
  name: 'Factorio',
  description: '',
  status: 'READY',
  suspended: false,
  node: { uuid: 'node-uuid', name: 'vps-e9d41921' },
  owner: { uuid: 'owner-uuid', username: 'admin', email: 'admin@example.test' },
  template: { uuid: 'template-uuid', name: 'Factorio' },
  memoryBytes: 0,
  diskBytes: 0,
  cpuPercent: 0,
  swapBytes: 0,
  ioWeight: 500,
  pidsLimit: 100,
  backupLimit: 0,
  databaseLimit: 0,
  allocationLimit: 0,
  primaryAllocation: null,
  createdAt: '2026-08-01T00:00:00.000Z',
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function mount() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });

  // Both lists already fetched and fresh, which is the state the bug needed: an
  // empty cache would have refetched anyway and hidden it.
  client.setQueryData(['admin', 'servers'], { data: [SERVER], meta: {} });
  client.setQueryData(['servers'], { data: [SERVER], meta: {} });

  const fetch = vi.fn((input: string, init?: RequestInit) => {
    if (input === '/api/panel') {
      return Promise.resolve(json({ name: 'Hopper', locale: 'en' }));
    }

    if (input === `/api/admin/servers/${UUID}` && init?.method === 'DELETE') {
      return Promise.resolve(new Response(null, { status: 204 }));
    }

    if (input === `/api/admin/servers/${UUID}`) {
      return Promise.resolve(json(SERVER));
    }

    return Promise.resolve(json({ data: [], meta: { total: 0 } }));
  });

  vi.stubGlobal('fetch', fetch);

  render(
    <QueryClientProvider client={client}>
      <TranslationProvider>
        <MemoryRouter initialEntries={[`/admin/servers/${UUID}`]}>
          <Routes>
            <Route path="/admin/servers/:uuid" element={<AdminServerDetailPage />} />
            <Route path="/admin/servers" element={<p>the list</p>} />
          </Routes>
        </MemoryRouter>
      </TranslationProvider>
    </QueryClientProvider>,
  );

  return { client, fetch };
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('deleting a server', () => {
  it('sends both lists back for a refetch, and goes to the list', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    vi.spyOn(window, 'prompt').mockReturnValue(SERVER.name);

    const { client, fetch } = mount();

    fireEvent.click(await screen.findByRole('button', { name: /manage/i }));
    fireEvent.click(await screen.findByRole('button', { name: /^delete/i }));

    await waitFor(() => {
      expect(
        fetch.mock.calls.some(
          ([path, init]) => path === `/api/admin/servers/${UUID}` && init?.method === 'DELETE',
        ),
      ).toBe(true);
    });

    // The whole of the fix: without it the operator lands on a cached list with
    // the row they just deleted still in it.
    await waitFor(() => {
      expect(client.getQueryState(['admin', 'servers'])?.isInvalidated).toBe(true);
      expect(client.getQueryState(['servers'])?.isInvalidated).toBe(true);
    });

    expect(await screen.findByText('the list')).toBeTruthy();
  });
});
