// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TranslationProvider } from '../i18n';
import { UpdateCard } from './UpdateCard';

/**
 * The card that updates the panel, and the reload it promises.
 *
 * "The panel restarts on its own — this page will come back" shipped in three
 * languages while nothing reloaded anything: the poll saw `succeeded` and did
 * nothing with it, so an operator watched "Updating…" for as long as they had
 * patience, on an installation that had finished minutes earlier. Reported
 * from a real one, still showing 0.14.0 next to 0.16.0.
 *
 * A rendered test rather than a reading, because the defect was a missing
 * effect: everything that was written was correct.
 */

const CHECK = {
  version: '0.14.0',
  commit: 'db0f31fb63daff7209c29a2c6e8aac78e1179c00',
  commitDate: null,
  latest: 'v0.16.0',
  latestDate: null,
  updateAvailable: true,
  checkedAt: '2026-08-11T00:49:55.000Z',
};

/**
 * Each call answers the next state, so one mount can watch a whole update.
 *
 * The first entry is what the card sees before anybody clicks, and it has to be
 * `idle`: any other value disables the button — correctly, since an update is
 * already under way — and the click under test does nothing at all.
 */
function mount(states: { state: string; supported?: boolean; log?: string }[]) {
  let index = 0;
  const reload = vi.fn();

  Object.defineProperty(window, 'location', {
    configurable: true,
    value: { ...window.location, reload },
  });

  const fetch = vi.fn((input: string) => {
    if (input === '/api/panel') {
      return Promise.resolve(json({ name: 'Hopper', locale: 'en' }));
    }

    if (input.startsWith('/api/admin/updates/status')) {
      const state = states[Math.min(index, states.length - 1)]!;
      index += 1;
      return Promise.resolve(json({ supported: true, ...state }));
    }

    if (input.startsWith('/api/admin/updates')) {
      return Promise.resolve(json(CHECK));
    }

    throw new Error(`unexpected call to ${input}`);
  });

  vi.stubGlobal('fetch', fetch);

  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });

  render(
    <QueryClientProvider client={client}>
      <TranslationProvider>
        <UpdateCard />
      </TranslationProvider>
    </QueryClientProvider>,
  );

  return { reload, fetch };
}

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

/**
 * Real timers, deliberately.
 *
 * React Query drives `refetchInterval` from its own scheduler, and it does not
 * advance under vitest's fake clock — the first version of this file waited
 * eight simulated seconds for a poll that never ran and reported the effect as
 * missing when it was there. So these tests wait for real, and the poll is two
 * seconds, which is why the timeouts below are generous.
 */
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/**
 * Clicks the update button once it is actually clickable.
 *
 * `findByRole` resolves the moment the button exists, and it exists from the
 * first render — disabled, because the version check has not answered yet.
 * Clicking it then does nothing at all, silently, and every assertion after it
 * fails for a reason that has nothing to do with the code under test.
 */
async function clickUpdate(): Promise<void> {
  await screen.findByText('v0.16.0');

  // `disabled` off the element rather than a matcher: this project carries no
  // jest-dom, so `toBeDisabled` is not a thing here.
  const button = await screen.findByRole<HTMLButtonElement>('button', { name: 'Update now' });

  await waitFor(() => expect(button.disabled).toBe(false));
  fireEvent.click(button);
}

describe('once an update has been asked for', () => {
  it('reloads the page when the unit reports it finished', async () => {
    const { reload } = mount([{ state: 'idle' }, { state: 'running' }, { state: 'succeeded' }]);

    await clickUpdate();

    // Without the effect this waits until the timeout, which is exactly what
    // the operator experienced — with no timeout.
    await waitFor(() => expect(reload).toHaveBeenCalled(), { timeout: 15000 });
  }, 20000);

  it('does not reload while the update is still running', async () => {
    const { reload } = mount([{ state: 'idle' }, { state: 'running' }]);

    await clickUpdate();
    await new Promise((resolve) => setTimeout(resolve, 5000));

    expect(reload).not.toHaveBeenCalled();
  }, 20000);

  it('does not reload on a failure, and shows what the unit said', async () => {
    // Reloading here would hide the log — the only thing that says why.
    const { reload } = mount([
      { state: 'idle' },
      { state: 'running' },
      { state: 'failed', log: 'git: no such ref' },
    ]);

    await clickUpdate();

    expect(await screen.findByText(/no such ref/, undefined, { timeout: 15000 })).toBeTruthy();
    expect(reload).not.toHaveBeenCalled();
  }, 20000);

  it('stops calling itself running once it has failed', async () => {
    // The button used to stay on "Updating…" for ever after the first click,
    // with the failure log printed underneath it.
    mount([{ state: 'idle' }, { state: 'failed', log: 'boom' }]);

    await clickUpdate();

    // "Updating…" while the log says it failed is the state this rules out.
    await screen.findByText(/boom/, undefined, { timeout: 15000 });
    expect(screen.getByRole('button', { name: 'Update now' })).toBeTruthy();
  }, 20000);
});

describe('before anything has been asked for', () => {
  it('does not reload on a succeeded left over from an earlier update', async () => {
    // Whoever opens the settings next would have their page reloaded under
    // them, on a panel nobody is updating.
    const { reload } = mount([{ state: 'succeeded' }]);

    await screen.findByText('v0.16.0');
    await new Promise((resolve) => setTimeout(resolve, 3000));

    expect(reload).not.toHaveBeenCalled();
  }, 20000);
});
