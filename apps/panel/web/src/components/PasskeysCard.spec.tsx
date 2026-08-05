// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TranslationProvider } from '../i18n';
import { PasskeysCard } from './PasskeysCard';

/**
 * The card renders, and says the one thing that decides whether a user needs a
 * second passkey: whether the one they have survives losing the device.
 *
 * A browser with no WebAuthn is not an error state. Roughly nobody has one
 * now, which is exactly why that branch would otherwise ship untried.
 */

const PASSKEYS = [
  {
    id: 1,
    name: 'Work laptop',
    backedUp: false,
    transports: ['internal'],
    createdAt: '2026-08-01T10:00:00.000Z',
    lastUsedAt: null,
  },
  {
    id: 2,
    name: 'Phone',
    backedUp: true,
    transports: ['internal', 'hybrid'],
    createdAt: '2026-08-02T10:00:00.000Z',
    lastUsedAt: '2026-08-04T18:30:00.000Z',
  },
];

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

function mount(): void {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });

  render(
    <QueryClientProvider client={client}>
      <TranslationProvider>
        <PasskeysCard />
      </TranslationProvider>
    </QueryClientProvider>,
  );
}

describe('PasskeysCard', () => {
  beforeEach(() => {
    // A browser that can do WebAuthn. jsdom ships neither.
    vi.stubGlobal('PublicKeyCredential', class {});
    Object.defineProperty(navigator, 'credentials', {
      configurable: true,
      value: { create: () => Promise.resolve(null), get: () => Promise.resolve(null) },
    });

    vi.stubGlobal(
      'fetch',
      vi.fn((input: string) =>
        Promise.resolve(json(input.endsWith('/passkeys') ? PASSKEYS : { defaultLocale: 'en' })),
      ),
    );
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('lists the registered passkeys by name', async () => {
    mount();

    expect(await screen.findByText('Work laptop')).toBeTruthy();
    expect(screen.getByText('Phone')).toBeTruthy();
  });

  it('marks which ones survive losing the device', async () => {
    mount();

    // The distinction is the whole point of showing the badge: a device-bound
    // passkey that is someone's only one is a lockout waiting to happen.
    expect(await screen.findByText('this device only')).toBeTruthy();
    expect(screen.getByText('synchronised')).toBeTruthy();
  });

  it('says so plainly when the browser cannot do passkeys', async () => {
    vi.stubGlobal('PublicKeyCredential', undefined);

    mount();

    expect(await screen.findByText('This browser does not support passkeys.')).toBeTruthy();
    // And offers nothing that would fail on click.
    expect(screen.queryByRole('button', { name: 'Add a passkey' })).toBeNull();
  });

  it('offers to add one when there are none', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn((input: string) =>
        Promise.resolve(json(input.endsWith('/passkeys') ? [] : { defaultLocale: 'en' })),
      ),
    );

    mount();

    expect(await screen.findByText('No passkey yet. Your password still works.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Add a passkey' })).toBeTruthy();
  });
});
