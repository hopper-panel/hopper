// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TranslationProvider } from '../../i18n';
import { AdminApplicationApiPage } from './ApplicationApi';

/**
 * The screen that hands out a credential.
 *
 * Two properties are worth a test, and both are about what the form does when
 * nobody is looking closely. The shortest path through it must not be the one
 * that grants the most — a form defaulting to "read & write everywhere" is one
 * an operator confirms without reading. And a resource with no write route must
 * not offer a write anyway: a checkbox that changes nothing is worse than a
 * missing one, because somebody ticks it and believes their integration can
 * write.
 */

const RESOURCES = {
  resources: [
    { resource: 'servers', levels: ['none', 'read', 'write'] },
    { resource: 'plans', levels: ['none', 'read'] },
  ],
};

function mount(keys: unknown[] = []): { created: () => unknown } {
  let body: unknown = null;

  const fetch = vi.fn((input: string, init?: RequestInit) => {
    if (input === '/api/panel') {
      return Promise.resolve(json({ name: 'Hopper', locale: 'en' }));
    }

    if (input === '/api/admin/application-keys/resources') {
      return Promise.resolve(json(RESOURCES));
    }

    if (input === '/api/admin/application-keys' && init?.method === 'POST') {
      // `body` is the string this harness put there; the cast says so rather
      // than letting a stringification nobody wants slip through.
      body = JSON.parse(init.body as string);
      return Promise.resolve(json({ name: 'Paymenter', token: 'hpa_abc.def' }));
    }

    if (input === '/api/admin/application-keys') {
      return Promise.resolve(json(keys));
    }

    throw new Error(`unexpected call to ${input}`);
  });

  vi.stubGlobal('fetch', fetch);

  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });

  render(
    <QueryClientProvider client={client}>
      <TranslationProvider>
        <AdminApplicationApiPage />
      </TranslationProvider>
    </QueryClientProvider>,
  );

  return { created: () => body };
}

function json(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function openForm(): Promise<void> {
  fireEvent.click(await screen.findByRole('button', { name: 'New credential' }));
  await screen.findByText('Permissions');
}

function radios(name: string): HTMLInputElement[] {
  return screen.getAllByRole<HTMLInputElement>('radio').filter((input) => input.name === name);
}

describe('granting a credential', () => {
  it('starts with everything at none', async () => {
    mount();
    await openForm();

    for (const resource of ['permission-servers', 'permission-plans']) {
      const [none, read, write] = radios(resource);

      expect(none?.checked).toBe(true);
      expect(read?.checked).toBe(false);
      expect(write?.checked).toBe(false);
    }
  });

  it('offers a write only where one exists', async () => {
    // `plans` is written from the administration and never through this API.
    mount();
    await openForm();

    expect(radios('permission-servers')[2]?.disabled).toBe(false);
    expect(radios('permission-plans')[2]?.disabled).toBe(true);
  });

  it('gives "read & write all" as much as each line allows', async () => {
    // Not "write everywhere", which would be refused by the API, and not
    // "skip the read-only ones", which would make the shortcut useless.
    mount();
    await openForm();

    fireEvent.click(screen.getByRole('button', { name: 'Read & write all' }));

    expect(radios('permission-servers')[2]?.checked).toBe(true);
    expect(radios('permission-plans')[1]?.checked).toBe(true);
  });

  it('sends one level per resource', async () => {
    const harness = mount();
    await openForm();

    fireEvent.change(screen.getByPlaceholderText('Paymenter'), {
      target: { value: 'Paymenter' },
    });
    fireEvent.click(radios('permission-servers')[2]!);
    fireEvent.click(radios('permission-plans')[1]!);
    fireEvent.click(screen.getByRole('button', { name: 'Create' }));

    await waitFor(() => expect(harness.created()).not.toBeNull());

    expect(harness.created()).toMatchObject({
      name: 'Paymenter',
      permissions: { servers: 'write', plans: 'read' },
    });
  });

  it('shows the token once, and says so', async () => {
    // It is stored hashed. A screen that showed it without saying that would
    // have operators close the box and come back for it.
    mount();
    await openForm();

    fireEvent.change(screen.getByPlaceholderText('Paymenter'), {
      target: { value: 'Paymenter' },
    });
    fireEvent.click(radios('permission-servers')[1]!);
    fireEvent.click(screen.getByRole('button', { name: 'Create' }));

    expect(await screen.findByText('hpa_abc.def')).toBeTruthy();
    expect(screen.getByText(/Shown once/)).toBeTruthy();
  });
});

describe('the list', () => {
  it('shows what each key may touch, without its secret', async () => {
    mount([
      {
        uuid: 'key-1',
        name: 'Paymenter',
        key: 'hpa_abcdefghijklmnop.••••••••',
        permissions: { servers: 'write', plans: 'read', users: 'none' },
        allowedIps: ['203.0.113.7'],
        lastUsedAt: null,
        expiresAt: null,
        revokedAt: null,
        createdAt: '2026-08-22T10:00:00.000Z',
        createdBy: 'julien',
      },
    ]);

    expect(await screen.findByText('Paymenter')).toBeTruthy();
    expect(screen.getByText('hpa_abcdefghijklmnop.••••••••')).toBeTruthy();

    // The resource at `none` is absent rather than shown as a refusal: a badge
    // list of what a key cannot do is unreadable at six resources.
    expect(screen.getByText(/Servers · Read & write/)).toBeTruthy();
    expect(screen.getByText(/Plans · Read/)).toBeTruthy();
    expect(screen.queryByText(/Customers/)).toBeNull();
  });
});
