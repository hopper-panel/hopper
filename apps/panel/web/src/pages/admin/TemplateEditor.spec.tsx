// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TranslationProvider } from '../../i18n';
import type { TemplateDetail, TemplateGroupSummary } from '../../lib/api';
import { AdminTemplateEditorPage } from './TemplateEditor';

/**
 * Writing a template from the interface.
 *
 * Five tabs and one save, so the two things worth rendering a browser for are
 * that moving between tabs does not lose an edit, and that a field the contract
 * cannot read never reaches the API — the entry that fails a whole-object parse
 * is the one that takes every server on the template off its node, and the
 * cheapest place to refuse it is against the form field that holds it.
 */

const UUID = '3f7d0f4a-2c31-4b52-9c11-6d2b9e2f0a11';
const GROUP_UUID = 'c4b6a5c8-2a1e-4c8f-9a52-2c2b0d5f7e10';

const GROUPS: TemplateGroupSummary[] = [
  {
    uuid: GROUP_UUID,
    name: 'Minecraft: Java Edition',
    description: '',
    author: '',
    templateCount: 1,
  },
];

const DETAIL: TemplateDetail = {
  uuid: UUID,
  key: 'paper',
  group: { uuid: GROUP_UUID, name: 'Minecraft: Java Edition' },
  name: 'Paper',
  description: '',
  author: 'Hopper',
  modifiedByAdmin: false,
  dockerImages: [{ name: 'Java 21', image: 'eclipse-temurin:21-jre-noble' }],
  startup: 'java -jar server.jar',
  stopCommand: 'command:stop',
  stop: null,
  stopTimeoutSeconds: null,
  startupDetection: ') Done (',
  readiness: null,
  configFiles: [],
  fileDenylist: [],
  installContainer: 'debian:bookworm-slim',
  installEntrypoint: '/bin/bash',
  installScript: '#!/bin/bash\necho hello\n',
  installInactivityTimeoutMs: null,
  installRequiredDiskBytes: null,
  importedFromEgg: null,
  serverCount: 2,
  variables: [],
  createdAt: '2026-08-01T00:00:00.000Z',
  updatedAt: '2026-08-01T00:00:00.000Z',
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function mount(
  entry: string,
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

    if (input === '/api/admin/templates/groups') {
      return Promise.resolve(json(GROUPS));
    }

    if (input === `/api/admin/templates/${UUID}/detail`) {
      return Promise.resolve(json(DETAIL));
    }

    throw new Error(`unexpected call to ${input}`);
  });

  vi.stubGlobal('fetch', fetch);

  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });

  render(
    <QueryClientProvider client={client}>
      <TranslationProvider>
        <MemoryRouter initialEntries={[entry]}>
          <Routes>
            <Route path="/admin/templates/:uuid" element={<AdminTemplateEditorPage />} />
            <Route
              path="/admin/templates/groups/:groupUuid/new"
              element={<AdminTemplateEditorPage />}
            />
          </Routes>
        </MemoryRouter>
      </TranslationProvider>
    </QueryClientProvider>,
  );

  return fetch;
}

function saved(fetch: ReturnType<typeof mount>, method: 'PATCH' | 'POST'): Record<string, unknown> {
  const call = fetch.mock.calls.find(([, init]) => init?.method === method);

  if (!call) {
    throw new Error(`no ${method} was sent`);
  }

  return JSON.parse(call[1]?.body as string) as Record<string, unknown>;
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('the template editor', () => {
  it('warns that saving reaches the servers already built from it', async () => {
    mount(`/admin/templates/${UUID}`);

    // Only when there are any: the notice is about what an edit does to
    // running servers, and on a template with none it would be noise on every
    // screen.
    expect(await screen.findByText(/read live: saving reaches every existing server/)).toBeTruthy();
    expect(screen.getByText('2 server(s)')).toBeTruthy();
  });

  it('keeps an edit made on another tab and saves everything at once', async () => {
    const fetch = mount(`/admin/templates/${UUID}`, (input, init) =>
      input === `/api/admin/templates/${UUID}` && init?.method === 'PATCH'
        ? json({ ...DETAIL, name: 'Paper (patched)' })
        : undefined,
    );

    fireEvent.change(await screen.findByDisplayValue('Paper'), {
      target: { value: 'Paper renamed' },
    });

    fireEvent.click(screen.getByRole('button', { name: 'Installation' }));
    fireEvent.change(screen.getByDisplayValue('debian:bookworm-slim'), {
      target: { value: 'ghcr.io/hopper-panel/source:latest' },
    });

    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => {
      const body = saved(fetch, 'PATCH');

      // Both edits, from two tabs, in one request — the tabs are a way of
      // reading one row, not five saves.
      expect(body.name).toBe('Paper renamed');
      expect(body.installContainer).toBe('ghcr.io/hopper-panel/source:latest');

      // And the fields nobody touched went with them unchanged, because a
      // PATCH that carried only the edited ones would leave the rest to a
      // schema whose defaults would blank them.
      expect(body.startup).toBe('java -jar server.jar');
      expect(body.installScript).toBe('#!/bin/bash\necho hello\n');
      expect(body.startupDetection).toBe(') Done (');
    });
  });

  it('never sends a configuration file the daemon could not read', async () => {
    const fetch = mount(`/admin/templates/${UUID}`);

    fireEvent.click(await screen.findByRole('button', { name: 'Files' }));
    fireEvent.change(screen.getByDisplayValue('[]'), {
      target: { value: '[{"file":"server.properties","parser":"toml","replacements":[]}]' },
    });

    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    expect(await screen.findByText(/0\.parser/)).toBeTruthy();

    // Nothing left the browser. The API refuses this too — but by the time it
    // does, an operator on a slow node has already watched a spinner for it.
    expect(fetch.mock.calls.some(([, init]) => init?.method === 'PATCH')).toBe(false);
  });

  it('says a field on another tab is wrong rather than saving in silence', async () => {
    mount(`/admin/templates/${UUID}`);

    fireEvent.click(await screen.findByRole('button', { name: 'Files' }));
    fireEvent.change(screen.getByDisplayValue('[]'), { target: { value: 'not json' } });

    // Back to a tab that shows none of it, which is where an operator would
    // otherwise press Save and see nothing happen at all.
    fireEvent.click(screen.getByRole('button', { name: 'General' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    expect(await screen.findByText(/Something on another tab is not valid/)).toBeTruthy();
  });

  it('creates a template into the group the route names', async () => {
    const fetch = mount(`/admin/templates/groups/${GROUP_UUID}/new`, (input, init) =>
      input === '/api/admin/templates' && init?.method === 'POST'
        ? json({ ...DETAIL, uuid: 'new-uuid' }, 201)
        : undefined,
    );

    fireEvent.change(await screen.findByPlaceholderText('paper'), { target: { value: 'rust' } });
    fireEvent.change(screen.getByPlaceholderText('Java 21'), { target: { value: 'Rust' } });
    fireEvent.change(screen.getByPlaceholderText('eclipse-temurin:21-jre-noble'), {
      target: { value: 'ghcr.io/hopper-panel/source:latest' },
    });

    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => {
      const body = saved(fetch, 'POST');

      expect(body.key).toBe('rust');
      expect(body.group).toBe('Minecraft: Java Edition');

      // A creation carries no nulls at all: the create schema has nothing to
      // express "no longer declares one" with and refuses them.
      expect(Object.values(body).every((value) => value !== null)).toBe(true);
    });
  });
});
