// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TranslationProvider } from '../../i18n';
import { DaemonConfiguration } from './DaemonConfiguration';

/**
 * Asking the machine to write its own `daemon.yml`, and hearing what happened.
 *
 * Both halves are here because both failed on a real installation. The button
 * answered "Internal server error" — `install.sh` created the updater's spool
 * and not this one, so the panel's account could not write the directory the
 * request goes in — and the screen had nothing to say about the outcome
 * afterwards either: it announced that the machine was writing the file and
 * left it there, whatever the root-side unit went on to do.
 */

const NODE = '5a2c1f0b-9d3e-4a71-8b62-0c4e7d9a1b33';
const CONFIG = 'debug: false\nuuid: 5a2c1f0b\n';

const MANUAL = 'sudo hopper node:token --node <name> --output /etc/hopper/daemon.yml';

/** Each poll answers the next state, so one mount can watch a whole apply. */
function mount(states: { state: string; available?: boolean; log?: string }[]): void {
  let index = 0;

  const fetch = vi.fn((input: string) => {
    if (input === '/api/panel') {
      return Promise.resolve(json({ name: 'Hopper', locale: 'en' }));
    }

    if (input === '/api/admin/nodes/local-apply/status') {
      const next = states[Math.min(index, states.length - 1)]!;
      index += 1;

      return Promise.resolve(json({ available: true, manualCommand: MANUAL, ...next }));
    }

    if (input === `/api/admin/nodes/${NODE}/apply-locally`) {
      return Promise.resolve(json({ state: 'requested', available: true, manualCommand: MANUAL }));
    }

    throw new Error(`unexpected call to ${input}`);
  });

  vi.stubGlobal('fetch', fetch);

  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });

  render(
    <QueryClientProvider client={client}>
      <TranslationProvider>
        <DaemonConfiguration nodeUuid={NODE} value={CONFIG} onDismiss={() => {}} />
      </TranslationProvider>
    </QueryClientProvider>,
  );
}

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

/**
 * Real timers, deliberately: React Query drives `refetchInterval` from its own
 * scheduler, which does not advance under vitest's fake clock. The poll is two
 * seconds, which is why the timeouts below are generous.
 */
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function clickApply(): Promise<void> {
  const button = await screen.findByRole<HTMLButtonElement>('button', {
    name: 'Apply on this machine',
  });

  await waitFor(() => expect(button.disabled).toBe(false));
  fireEvent.click(button);
}

describe('once the machine has been asked to configure itself', () => {
  it('says so when the unit reports it finished', async () => {
    mount([{ state: 'idle' }, { state: 'running' }, { state: 'succeeded' }]);

    await clickApply();

    expect(
      await screen.findByText(/wrote its configuration/, undefined, { timeout: 15000 }),
    ).toBeTruthy();
  }, 20000);

  it('shows the failure and the journal that explains it', async () => {
    // The outcome an operator never used to be told: the daemon is still
    // running whatever it was running before, and the screen said the machine
    // was writing the file.
    mount([{ state: 'idle' }, { state: 'failed', log: 'not a node uuid: node01' }]);

    await clickApply();

    expect(await screen.findByText(/could not apply/, undefined, { timeout: 15000 })).toBeTruthy();
    expect(screen.getByText(/not a node uuid/)).toBeTruthy();
  }, 20000);

  it('reports nothing before the answer arrives', async () => {
    mount([{ state: 'idle' }, { state: 'running' }]);

    await clickApply();

    expect(
      await screen.findByText(/restarting its daemon/, undefined, { timeout: 15000 }),
    ).toBeTruthy();
    expect(screen.queryByText(/wrote its configuration/)).toBeNull();
  }, 20000);
});

describe('before anything has been asked for', () => {
  it('does not report a succeeded left over from another node', async () => {
    // The status is a property of the machine, not of the node on screen: a
    // second node created after a successful apply would open on "Done".
    mount([{ state: 'succeeded' }]);

    await screen.findByRole('button', { name: 'Apply on this machine' });
    await new Promise((resolve) => setTimeout(resolve, 500));

    expect(screen.queryByText(/wrote its configuration/)).toBeNull();
  }, 20000);

  it('offers the commands instead of a button the machine cannot honour', async () => {
    // The installation that met this: units present, spool unwritable. A
    // button that answers "Internal server error" is worse than no button.
    mount([{ state: 'idle', available: false }]);

    expect(await screen.findByText(/node:token/, undefined, { timeout: 15000 })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Apply on this machine' })).toBeNull();
  }, 20000);
});
