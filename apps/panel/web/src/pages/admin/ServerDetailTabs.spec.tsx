// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen } from '@testing-library/react';
import type { ReactElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TranslationProvider } from '../../i18n';
import { DatabasesTab, NetworkTab } from './ServerDetailTabs';

/**
 * These two tabs threw on their first render in front of an operator:
 *
 *     Uncaught TypeError: r.data?.map is not a function
 *
 * Both endpoints answer with `{ data, meta }`. Both components declared a bare
 * array and called `.map` on the response. TypeScript had nothing to complain
 * about — `api.get<T>` returns whatever T the caller claims, and the claim was
 * the error. The build was green, the types were wrong, and a crash inside a
 * render takes the page down rather than showing a message.
 *
 * So the fixtures below are copied from what the panel actually returns, and
 * the assertions are on what an administrator ends up reading. A test that
 * mocked the components' own interfaces would have passed against the bug.
 */

const ALLOCATIONS = {
  data: [
    { id: 1, ip: '0.0.0.0', port: 25565, alias: null, primary: true },
    { id: 2, ip: '0.0.0.0', port: 25577, alias: 'dynmap', primary: false },
  ],
  meta: { limit: 4, used: 2, availableOnNode: 7 },
};

const DATABASES = {
  data: [
    {
      uuid: 'db-1',
      name: 's1_survie',
      username: 'u_s1',
      remote: '%',
      host: { name: 'local mysql', address: '127.0.0.1', port: 3306 },
    },
  ],
  meta: { limit: 2, used: 1, hostsAvailable: 1 },
};

const SERVER = { uuid: 'srv-uuid', name: 'SURVIE', description: '' };

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

/** No retries: a failed query must surface here, not be papered over. */
function mount(element: ReactElement): void {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });

  render(
    <QueryClientProvider client={client}>
      <TranslationProvider>{element}</TranslationProvider>
    </QueryClientProvider>,
  );
}

describe('the administration tabs that talk to the owner endpoints', () => {
  beforeEach(() => {
    vi.stubGlobal(
      'fetch',
      vi.fn((input: string) => {
        if (input.endsWith('/allocations')) return Promise.resolve(json(ALLOCATIONS));
        if (input.endsWith('/databases')) return Promise.resolve(json(DATABASES));
        // TranslationProvider asks for the branding; anything else is a route
        // this test did not expect and should not silently succeed.
        if (input === '/api/panel') return Promise.resolve(json({ defaultLocale: 'en' }));

        return Promise.resolve(new Response('', { status: 404 }));
      }),
    );
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('lists the ports the server holds', async () => {
    mount(<NetworkTab server={SERVER} />);

    // The alias replaces the address when there is one — an operator named it
    // for a reason.
    expect(await screen.findByText('dynmap:25577')).toBeTruthy();
    expect(screen.getByText('0.0.0.0:25565')).toBeTruthy();
  });

  it('says how many ports are used against the limit', async () => {
    mount(<NetworkTab server={SERVER} />);

    expect(await screen.findByText('2 of 4 port(s) assigned.')).toBeTruthy();
  });

  it('offers another port while the node has some free and the limit allows it', async () => {
    mount(<NetworkTab server={SERVER} />);

    const add = await screen.findByRole('button', { name: 'Add a port' });

    expect((add as HTMLButtonElement).disabled).toBe(false);
  });

  it('refuses to offer one once the server is at its limit', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn((input: string) =>
        Promise.resolve(
          input.endsWith('/allocations')
            ? json({ ...ALLOCATIONS, meta: { limit: 2, used: 2, availableOnNode: 7 } })
            : json({ defaultLocale: 'en' }),
        ),
      ),
    );

    mount(<NetworkTab server={SERVER} />);

    const add = await screen.findByRole('button', { name: 'Add a port' });

    expect((add as HTMLButtonElement).disabled).toBe(true);
  });

  it('lists the databases by the name the API gives them', async () => {
    mount(<DatabasesTab server={SERVER} />);

    // `name`, not `database`: the component read a field that has never
    // existed, so every row would have rendered an empty cell even after the
    // envelope was unwrapped.
    expect(await screen.findByText('s1_survie')).toBeTruthy();
    expect(screen.getByText(/u_s1@% · local mysql/)).toBeTruthy();
  });
});
