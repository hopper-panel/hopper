// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TranslationProvider } from '../../i18n';
import type { TemplateGroupSummary, TemplateSummary } from '../../lib/api';
import { AdminTemplateGroupPage } from './TemplateGroup';

/**
 * A group, its templates, and uploading an egg into it.
 *
 * The fixtures below are the API's answers field for field, and that is the
 * point of the file. The "edited" badge is the only thing anywhere that says a
 * template will survive the next resynchronisation, and it had never rendered
 * on any installation: the page declared `modifiedByAdmin` on an interface of
 * its own and the response did not carry it. TypeScript checked the JSX against
 * the declaration, so nothing failed anywhere — which is exactly the shape of
 * failure a rendered test catches and a type does not.
 */

const GROUP_UUID = 'c4b6a5c8-2a1e-4c8f-9a52-2c2b0d5f7e10';

const GROUPS: TemplateGroupSummary[] = [
  {
    uuid: GROUP_UUID,
    name: 'Minecraft: Java Edition',
    description: '',
    author: '',
    templateCount: 2,
  },
];

const TEMPLATES: TemplateSummary[] = [
  {
    uuid: '3f7d0f4a-2c31-4b52-9c11-6d2b9e2f0a11',
    key: 'paper',
    name: 'Paper',
    description: 'A Minecraft server.',
    author: 'Hopper',
    modifiedByAdmin: true,
    serverCount: 4,
    group: { uuid: GROUP_UUID, name: 'Minecraft: Java Edition' },
    dockerImages: [{ name: 'Java 21', image: 'eclipse-temurin:21-jre-noble' }],
    startup: 'java -jar server.jar',
    variables: [],
  },
  {
    uuid: '5a2e1c7b-9f88-4d10-8b41-1c7d3e5a9f22',
    key: 'vanilla',
    name: 'Vanilla',
    description: '',
    author: 'Hopper',
    modifiedByAdmin: false,
    serverCount: 0,
    group: { uuid: GROUP_UUID, name: 'Minecraft: Java Edition' },
    dockerImages: [{ name: 'Java 21', image: 'eclipse-temurin:21-jre-noble' }],
    startup: 'java -jar server.jar',
    variables: [],
  },
  {
    // Another group's: the page filters, and a filter that does nothing looks
    // exactly like a filter that works until something is on the other side.
    uuid: '9c4b1a2d-7e60-4a33-9f52-3b8c6d1e4f70',
    key: 'gmod',
    name: "Garry's Mod",
    description: '',
    author: 'Hopper',
    modifiedByAdmin: false,
    serverCount: 1,
    group: { uuid: '1111aaaa-2222-bbbb-3333-cccc4444dddd', name: 'Source Engine' },
    dockerImages: [{ name: 'Source', image: 'ghcr.io/hopper-panel/source' }],
    startup: './srcds_run',
    variables: [],
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

    if (input === '/api/admin/templates') {
      return Promise.resolve(json(TEMPLATES));
    }

    throw new Error(`unexpected call to ${input}`);
  });

  vi.stubGlobal('fetch', fetch);

  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });

  const { container } = render(
    <QueryClientProvider client={client}>
      <TranslationProvider>
        <MemoryRouter initialEntries={[`/admin/templates/groups/${GROUP_UUID}`]}>
          <Routes>
            <Route path="/admin/templates/groups/:uuid" element={<AdminTemplateGroupPage />} />
          </Routes>
        </MemoryRouter>
      </TranslationProvider>
    </QueryClientProvider>,
  );

  return { fetch, container };
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('a template group', () => {
  it('shows only its own templates, with the key and the server count', async () => {
    mount(() => undefined);

    expect(await screen.findByText('Paper')).toBeTruthy();
    expect(screen.getByText('Vanilla')).toBeTruthy();
    expect(screen.queryByText("Garry's Mod")).toBeNull();

    expect(screen.getByText('paper')).toBeTruthy();
    expect(screen.getByText('4')).toBeTruthy();
  });

  it('flags the template an administrator has edited, and only that one', async () => {
    mount(() => undefined);

    // One badge, not two: the flag is what a resynchronisation skips on, and a
    // badge on every row would say nothing.
    const badges = await screen.findAllByText('edited');
    expect(badges).toHaveLength(1);
  });

  it('refuses to delete a group that still holds templates, and says how many', async () => {
    mount((input, init) =>
      input === `/api/admin/templates/groups/${GROUP_UUID}` && init?.method === 'DELETE'
        ? json(
            { message: 'This group still holds 2 template(s). Move them to another group first.' },
            409,
          )
        : undefined,
    );

    vi.spyOn(window, 'confirm').mockReturnValue(true);

    fireEvent.click(await screen.findByRole('button', { name: 'Delete' }));

    expect(await screen.findByText(/still holds 2 template/)).toBeTruthy();
  });

  describe('importing an egg', () => {
    /**
     * The feature the documentation has promised since the importer was
     * written — "From Administration → Templates, upload the egg's JSON file"
     * — and which existed only over HTTP until now.
     */
    /**
     * One click, one dialog.
     *
     * The button used to unfold a panel whose only content was a second button
     * saying "Choose a file" — two clicks and a paragraph to do the thing the
     * first button already named.
     */
    it('opens the file dialog straight from the header', async () => {
      const clicks = vi.spyOn(HTMLInputElement.prototype, 'click').mockImplementation(() => {});
      const { container } = mount(() => undefined);

      fireEvent.click(await screen.findByRole('button', { name: 'Import an egg' }));

      expect(clicks).toHaveBeenCalledTimes(1);
      expect(container.querySelector('input[type="file"]')).toBeTruthy();
      expect(screen.queryByRole('button', { name: 'Choose a file' })).toBeNull();
    });

    it('posts the parsed file into this group and shows what was dropped', async () => {
      const { fetch, container } = mount((input, init) =>
        input === '/api/admin/templates/import' && init?.method === 'POST'
          ? json(
              {
                template: { ...TEMPLATES[0], name: 'Rust' },
                warnings: ['The "file" parser is not carried across; SERVER_PORT was dropped.'],
              },
              201,
            )
          : undefined,
      );

      fireEvent.click(await screen.findByRole('button', { name: 'Import an egg' }));

      const input = container.querySelector('input[type="file"]');
      const egg = new File([JSON.stringify({ name: 'Rust', author: 'x' })], 'egg-rust.json', {
        type: 'application/json',
      });

      fireEvent.change(input as HTMLInputElement, { target: { files: [egg] } });

      await waitFor(() => {
        const posted = fetch.mock.calls.find(
          ([path, init]) => path === '/api/admin/templates/import' && init?.method === 'POST',
        );

        expect(posted).toBeTruthy();
        expect(JSON.parse(posted?.[1]?.body as string)).toEqual({
          egg: { name: 'Rust', author: 'x' },
          // By name, because that is what the API resolves and creates a group
          // from — not by uuid.
          group: 'Minecraft: Java Edition',
        });
      });

      // The warnings are the reason a successful import is worth reporting at
      // all: the egg declared something this side does not carry, and the first
      // server built from it is the other place that would have said so.
      expect(await screen.findByText(/SERVER_PORT was dropped/)).toBeTruthy();
    });

    it('says so before uploading when the file is not JSON', async () => {
      const { fetch, container } = mount(() => undefined);

      fireEvent.click(await screen.findByRole('button', { name: 'Import an egg' }));

      const input = container.querySelector('input[type="file"]');
      const notAnEgg = new File(['<!doctype html>'], 'egg.json', { type: 'text/html' });

      fireEvent.change(input as HTMLInputElement, { target: { files: [notAnEgg] } });

      expect(await screen.findByText(/is not JSON/)).toBeTruthy();

      // And nothing was sent: an egg saved from a browser tab is the ordinary
      // mistake, and the API's parser error names a byte offset rather than the
      // file the operator picked.
      expect(fetch.mock.calls.some(([path]) => path === '/api/admin/templates/import')).toBe(false);
    });

    it("relays the importer's field-by-field refusal", async () => {
      const { container } = mount((input, init) =>
        input === '/api/admin/templates/import' && init?.method === 'POST'
          ? json(
              {
                message: 'This file is not a Pterodactyl egg.',
                issues: [{ path: 'startup', message: 'Required' }],
              },
              400,
            )
          : undefined,
      );

      fireEvent.click(await screen.findByRole('button', { name: 'Import an egg' }));

      const input = container.querySelector('input[type="file"]');
      fireEvent.change(input as HTMLInputElement, {
        target: { files: [new File(['{}'], 'egg.json', { type: 'application/json' })] },
      });

      expect(await screen.findByText('This file is not a Pterodactyl egg.')).toBeTruthy();
      expect(screen.getByText('startup: Required')).toBeTruthy();
    });
  });
});

/**
 * Downloading a template as an egg.
 *
 * Two things worth a browser: that the button does not follow the row's link on
 * the way — a button that exports *and* navigates away from the list is one
 * nobody presses twice — and that the file is named the way Pterodactyl names
 * its own, so a file from either panel looks like the other's in a downloads
 * folder.
 */
describe('exporting a template', () => {
  function stubDownload(): { clicked: HTMLAnchorElement[] } {
    const clicked: HTMLAnchorElement[] = [];

    // jsdom implements neither, and `click()` on a real anchor would ask it to
    // navigate.
    vi.stubGlobal('URL', {
      ...URL,
      createObjectURL: () => 'blob:egg',
      revokeObjectURL: () => undefined,
    });

    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
      this: HTMLAnchorElement,
    ) {
      clicked.push(this);
    });

    return { clicked };
  }

  it('fetches the egg and saves it under the key', async () => {
    const { clicked } = stubDownload();

    const { fetch } = mount((input) =>
      input === `/api/admin/templates/${TEMPLATES[0]!.uuid}/export`
        ? json({ name: 'Paper', hopper: { version: 1, key: 'paper' } })
        : undefined,
    );

    const buttons = await screen.findAllByRole('button', {
      name: 'Export as a Pterodactyl egg',
    });

    fireEvent.click(buttons[0]!);

    await waitFor(() => {
      expect(clicked).toHaveLength(1);
      expect(clicked[0]?.download).toBe('egg-paper.json');
    });

    expect(
      fetch.mock.calls.some(
        ([path]) => path === `/api/admin/templates/${TEMPLATES[0]!.uuid}/export`,
      ),
    ).toBe(true);

    // Still on the group page: the click was stopped from following the row.
    expect(screen.getByText('Vanilla')).toBeTruthy();
  });
});

/**
 * The group's own fields, which used to sit open on every visit.
 *
 * Reading a group is the common case and editing one is rare, so the form is
 * behind the header's Edit. It is still there — `author` is a column that
 * exists for this form and nowhere else.
 */
describe('editing the group', () => {
  it('shows no form until it is asked for', async () => {
    mount(() => undefined);

    expect(await screen.findByText('Paper')).toBeTruthy();
    expect(screen.queryByDisplayValue('Minecraft: Java Edition')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));

    expect(screen.getByDisplayValue('Minecraft: Java Edition')).toBeTruthy();
  });

  it('saves the three fields and closes', async () => {
    const { fetch } = mount((input, init) =>
      input === `/api/admin/templates/groups/${GROUP_UUID}` && init?.method === 'PATCH'
        ? json({ ...GROUPS[0], author: 'Julien' })
        : undefined,
    );

    fireEvent.click(await screen.findByRole('button', { name: 'Edit' }));
    fireEvent.change(screen.getByDisplayValue('Minecraft: Java Edition'), {
      target: { value: 'Minecraft' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => {
      const sent = fetch.mock.calls.find(([, init]) => init?.method === 'PATCH');

      expect(sent).toBeTruthy();
      expect(JSON.parse(sent?.[1]?.body as string)).toEqual({
        name: 'Minecraft',
        description: '',
        author: '',
      });
    });

    // Closed on success: the page goes back to what it is for.
    await waitFor(() => {
      expect(screen.queryByRole('button', { name: 'Save' })).toBeNull();
    });
  });
});
