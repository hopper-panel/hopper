// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TranslationProvider } from '../../i18n';
import type { TemplateGroupSummary } from '../../lib/api';
import { AdminTemplatesPage } from './Templates';

/**
 * The catalogue's top level, and the count it used to render as `undefined`.
 *
 * This page had no test and did not need a DOM to be wrong: it read
 * `result.kept` off a response whose field is `skipped`, and TypeScript checked
 * the read against a declaration written on the page itself. The sentence
 * "undefined kept because an administrator edited them" appeared after every
 * synchronisation on every installation.
 */

const GROUPS: TemplateGroupSummary[] = [
  {
    uuid: 'c4b6a5c8-2a1e-4c8f-9a52-2c2b0d5f7e10',
    name: 'Minecraft: Java Edition',
    description: 'Vanilla and its forks.',
    author: 'Hopper',
    templateCount: 5,
  },
];

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function mount(onCall: (input: string, init?: RequestInit) => Response | undefined) {
  const fetch = vi.fn((input: string, init?: RequestInit) => {
    if (input === '/api/panel') {
      return Promise.resolve(json({ name: 'Hopper', locale: 'en' }));
    }

    const answer = onCall(input, init);

    if (answer) {
      return Promise.resolve(answer);
    }

    if (input === '/api/admin/templates/groups') {
      return Promise.resolve(json(GROUPS));
    }

    throw new Error(`unexpected call to ${input}`);
  });

  vi.stubGlobal('fetch', fetch);

  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });

  render(
    <QueryClientProvider client={client}>
      <TranslationProvider>
        <MemoryRouter initialEntries={['/admin/templates']}>
          <AdminTemplatesPage />
        </MemoryRouter>
      </TranslationProvider>
    </QueryClientProvider>,
  );

  return fetch;
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('the template groups page', () => {
  it('lists the groups and how many templates each holds', async () => {
    mount(() => undefined);

    expect(await screen.findByText('Minecraft: Java Edition')).toBeTruthy();
    expect(screen.getByText('Vanilla and its forks.')).toBeTruthy();
    expect(screen.getByText('5')).toBeTruthy();
  });

  it('reports what a resynchronisation did, with the figure the API returned', async () => {
    mount((input, init) =>
      input === '/api/admin/templates/sync' && init?.method === 'POST'
        ? json({ created: 1, updated: 2, skipped: 3 })
        : undefined,
    );

    fireEvent.click(await screen.findByRole('button', { name: 'Resynchronise' }));

    const notice = await screen.findByRole('status');

    // The whole sentence, because the bug was one word of it: the count of
    // templates a synchronisation left alone is the only thing on this page
    // that says an operator's edits survived the update they just ran.
    expect(notice.textContent).toBe(
      '1 created, 2 updated, 3 kept because an administrator edited them.',
    );
  });

  it('creates a group', async () => {
    const fetch = mount((input, init) =>
      input === '/api/admin/templates/groups' && init?.method === 'POST'
        ? json({ ...GROUPS[0], name: 'Rust', templateCount: 0 }, 201)
        : undefined,
    );

    fireEvent.click(await screen.findByRole('button', { name: 'New group' }));
    fireEvent.change(screen.getByPlaceholderText('Rust'), { target: { value: 'Rust' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create the group' }));

    await waitFor(() => {
      const posted = fetch.mock.calls.find(
        ([input, init]) => input === '/api/admin/templates/groups' && init?.method === 'POST',
      );

      expect(posted).toBeTruthy();
      expect(JSON.parse(posted?.[1]?.body as string)).toEqual({
        name: 'Rust',
        description: '',
        author: '',
      });
    });
  });
});
