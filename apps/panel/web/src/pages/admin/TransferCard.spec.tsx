// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TranslationProvider } from '../../i18n';
import { TransferCard } from './TransferCard';

/**
 * The card exists to warn before the button, so the warnings are what is
 * tested.
 *
 * A transfer stops a running server and then deletes its files on the old
 * node. The two things that make it go wrong — no free port on the target, and
 * a database that stays behind — are both knowable in advance, and both are
 * invisible in the moment an administrator is deciding.
 */

const NODES = {
  data: [
    { uuid: 'node-a', name: 'paris-1' },
    { uuid: 'node-b', name: 'frankfurt-1' },
  ],
};

const SERVER = { uuid: 'srv', name: 'SURVIE' };

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

function mount(plan: unknown): void {
  vi.stubGlobal(
    'fetch',
    vi.fn((input: string) => {
      if (input.includes('/transfer?node=')) return Promise.resolve(json(plan));
      if (input.includes('/api/admin/nodes')) return Promise.resolve(json(NODES));

      return Promise.resolve(json({ defaultLocale: 'en' }));
    }),
  );

  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });

  render(
    <QueryClientProvider client={client}>
      <TranslationProvider>
        <TransferCard server={SERVER} currentNode="paris-1" />
      </TranslationProvider>
    </QueryClientProvider>,
  );
}

const HEALTHY = {
  fromNode: 'paris-1',
  toNode: 'frankfurt-1',
  availableOnTarget: 3,
  strandedDatabases: [],
};

describe('TransferCard', () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('does not offer the node the server is already on', async () => {
    mount(HEALTHY);

    expect(await screen.findByRole('option', { name: 'frankfurt-1' })).toBeTruthy();
    // Choosing it would only produce an error from the API.
    expect(screen.queryByRole('option', { name: 'paris-1' })).toBeNull();
  });

  it('refuses to start before a node has been chosen', async () => {
    mount(HEALTHY);

    const button = await screen.findByRole('button', { name: 'Move the server' });

    expect((button as HTMLButtonElement).disabled).toBe(true);
  });

  it('warns about databases that would stay behind', async () => {
    mount({ ...HEALTHY, strandedDatabases: ['s1_luckperms', 's1_coreprotect'] });

    const select = await screen.findByRole('combobox');

    // Nothing is claimed before a node is chosen. Without this the assertion
    // below would also pass if selecting had done nothing at all.
    expect(screen.queryByText(/s1_luckperms/)).toBeNull();

    fireEvent.change(select, { target: { value: 'node-b' } });

    // Named, not counted. "Two databases will break" tells nobody which.
    expect(await screen.findByText(/s1_luckperms, s1_coreprotect/)).toBeTruthy();
  });

  it('blocks the move when the target has no free port', async () => {
    mount({ ...HEALTHY, availableOnTarget: 0 });

    const select = await screen.findByRole('combobox');
    fireEvent.change(select, { target: { value: 'node-b' } });

    expect(
      await screen.findByText(
        'That node has no free port. Add one to its pool before moving a server there.',
      ),
    ).toBeTruthy();

    const button = screen.getByRole('button', { name: 'Move the server' });
    expect((button as HTMLButtonElement).disabled).toBe(true);
  });
});
