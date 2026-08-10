// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TranslationProvider } from '../../i18n';
import type { NodeSummary } from '../../lib/api';
import { AdminNodeDetailPage } from './NodeDetail';

/**
 * Editing and deleting a node, which had no interface at all.
 *
 * Written after an operator ended up with three nodes for one machine — one
 * unreachable, one whose token the daemon refused, one working — and no way to
 * correct an address or remove a row without opening the database. The API had
 * carried `PATCH` and `DELETE` since the beginning.
 *
 * The capacity conversion is the part these tests exist for. The column is in
 * bytes and the field is in gibibytes, so a dialog that renders the raw value
 * and posts it back multiplies a node's declared capacity by a billion — and
 * the panel sells servers against that number.
 */

const NODE_UUID = 'a3c2e1d0-5b44-4f21-8e73-9c1a2b3d4e5f';

const NODE: NodeSummary = {
  uuid: NODE_UUID,
  name: 'node01',
  description: '',
  fqdn: '127.0.0.1',
  scheme: 'http',
  port: 8443,
  sftpPort: 2022,
  memoryBytes: 64 * 1024 ** 3,
  diskBytes: 500 * 1024 ** 3,
  memoryOverallocation: 0,
  diskOverallocation: 0,
  maintenance: false,
  daemonTokenId: 'tok_123',
  serverCount: 0,
  allocationCount: 0,
  createdAt: '2026-08-10T12:00:00.000Z',
};

function json(body: unknown, status = 200): Response {
  return new Response(status === 204 ? null : JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function mount(
  onCall: (input: string, init?: RequestInit) => Response | undefined = () => undefined,
) {
  const fetch = vi.fn((input: string, init?: RequestInit) => {
    if (input === '/api/panel') {
      return Promise.resolve(json({ name: 'Hopper', locale: 'en' }));
    }

    const answer = onCall(input, init);

    if (answer) {
      return Promise.resolve(answer);
    }

    if (input === `/api/admin/nodes/${NODE_UUID}`) {
      return Promise.resolve(json(NODE));
    }

    if (input.startsWith(`/api/admin/nodes/${NODE_UUID}/allocations`)) {
      return Promise.resolve(json({ data: [], meta: { page: 1, perPage: 100, total: 0 } }));
    }

    if (input === `/api/admin/nodes/${NODE_UUID}/health`) {
      return Promise.resolve(json({ reachable: true, latencyMs: 4 }));
    }

    throw new Error(`unexpected call to ${input}`);
  });

  vi.stubGlobal('fetch', fetch);

  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });

  render(
    <QueryClientProvider client={client}>
      <TranslationProvider>
        <MemoryRouter initialEntries={[`/admin/nodes/${NODE_UUID}`]}>
          <Routes>
            <Route path="/admin/nodes/:uuid" element={<AdminNodeDetailPage />} />
            <Route path="/admin/nodes" element={<p>the node list</p>} />
          </Routes>
        </MemoryRouter>
      </TranslationProvider>
    </QueryClientProvider>,
  );

  return { fetch };
}

/** Opens the edit dialog and waits for its fields to be there. */
async function openEditor(): Promise<void> {
  fireEvent.click(await screen.findByRole('button', { name: 'Edit' }));
  await screen.findByDisplayValue('127.0.0.1');
}

function bodyOf(fetch: ReturnType<typeof vi.fn>, method: string): Record<string, unknown> {
  const call = fetch.mock.calls.find(
    ([, init]) => (init as RequestInit | undefined)?.method === method,
  );

  const body = (call?.[1] as RequestInit).body;

  return JSON.parse(typeof body === 'string' ? body : '{}') as Record<string, unknown>;
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('editing a node', () => {
  it('opens on the values the node already has', async () => {
    mount();
    await openEditor();

    // Gibibytes, not the 68719476736 the API sent.
    expect(screen.getByDisplayValue('64')).toBeTruthy();
    expect(screen.getByDisplayValue('500')).toBeTruthy();
    expect(screen.getByDisplayValue('8443')).toBeTruthy();
  });

  it('sends the corrected address, and the capacity back in bytes', async () => {
    const { fetch } = mount((input, init) =>
      input === `/api/admin/nodes/${NODE_UUID}` && init?.method === 'PATCH'
        ? json({ ...NODE, fqdn: '192.168.1.141' })
        : undefined,
    );

    await openEditor();
    fireEvent.change(screen.getByDisplayValue('127.0.0.1'), {
      target: { value: '192.168.1.141' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => {
      expect(fetch.mock.calls.some(([, init]) => (init as RequestInit)?.method === 'PATCH')).toBe(
        true,
      );
    });

    const body = bodyOf(fetch, 'PATCH');

    expect(body.fqdn).toBe('192.168.1.141');
    // The mutation this catches: posting `memoryGib` as-is, or forgetting to
    // divide when the dialog opened. Either way the node would be declared
    // with 64 bytes or 68 exabytes of memory.
    expect(body.memoryBytes).toBe(64 * 1024 ** 3);
    expect(body.diskBytes).toBe(500 * 1024 ** 3);
  });

  it('closes once the save has gone through', async () => {
    mount((input, init) =>
      input === `/api/admin/nodes/${NODE_UUID}` && init?.method === 'PATCH'
        ? json(NODE)
        : undefined,
    );

    await openEditor();
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => {
      expect(screen.queryByDisplayValue('127.0.0.1')).toBeNull();
    });
  });

  it('stays open and shows what the API refused', async () => {
    // A refusal belongs next to the field that caused it. Closing on failure
    // would drop what was typed and leave the reason nowhere.
    mount((input, init) =>
      input === `/api/admin/nodes/${NODE_UUID}` && init?.method === 'PATCH'
        ? json({ message: 'The FQDN may only contain letters, digits, dots and hyphens.' }, 400)
        : undefined,
    );

    await openEditor();
    fireEvent.change(screen.getByDisplayValue('127.0.0.1'), { target: { value: 'not a host' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    expect(await screen.findByText(/may only contain letters/)).toBeTruthy();
    expect(screen.getByDisplayValue('not a host')).toBeTruthy();
  });
});

describe('deleting a node', () => {
  it('asks before deleting, and does nothing when the answer is no', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    const { fetch } = mount();

    fireEvent.click(await screen.findByRole('button', { name: 'Delete' }));

    expect(confirm).toHaveBeenCalled();
    expect(fetch.mock.calls.some(([, init]) => (init as RequestInit)?.method === 'DELETE')).toBe(
      false,
    );
  });

  it('deletes and goes back to the list', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    const { fetch } = mount((input, init) =>
      input === `/api/admin/nodes/${NODE_UUID}` && init?.method === 'DELETE'
        ? json(null, 204)
        : undefined,
    );

    fireEvent.click(await screen.findByRole('button', { name: 'Delete' }));

    expect(await screen.findByText('the node list')).toBeTruthy();
    expect(fetch.mock.calls.some(([, init]) => (init as RequestInit)?.method === 'DELETE')).toBe(
      true,
    );
  });

  it('shows how many servers stand in the way, rather than a bare failure', async () => {
    // The count is the whole instruction: it is what tells the operator
    // whether to move three servers or forty.
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    mount((input, init) =>
      input === `/api/admin/nodes/${NODE_UUID}` && init?.method === 'DELETE'
        ? json({ message: 'This node still hosts 3 server(s). Delete or move them first.' }, 400)
        : undefined,
    );

    fireEvent.click(await screen.findByRole('button', { name: 'Delete' }));

    expect(await screen.findByText(/still hosts 3 server\(s\)/)).toBeTruthy();
  });
});
