import { describe, expect, it } from 'vitest';
import { WEBHOOK_EVENTS } from './events.js';
import {
  buildDiscordPayload,
  buildGenericPayload,
  buildPayload,
  isDiscordUrl,
  signPayload,
  verifySignature,
} from './payload.js';

const context = {
  serverUuid: '1b32d12d-7b10-443e-a259-6a31d67e28e6',
  serverName: 'Test Linux',
  address: 'jeu.exemple.fr:25565',
  panelUrl: 'https://panel.exemple.fr/',
  occurredAt: new Date('2026-08-04T12:00:00.000Z'),
};

describe('isDiscordUrl', () => {
  it.each([
    'https://discord.com/api/webhooks/123/abc',
    'https://discordapp.com/api/webhooks/123/abc',
    'https://ptb.discord.com/api/webhooks/123/abc',
  ])('recognises %s', (url) => {
    expect(isDiscordUrl(url)).toBe(true);
  });

  it.each([
    'https://exemple.fr/hook',
    // The path matters: Discord's home page is not a webhook.
    'https://discord.com/channels/123',
    // And so does the domain: an attacker must not obtain the Discord format
    // by picking a subdomain that looks like it.
    'https://discord.com.exemple.fr/api/webhooks/1/x',
    'not a url',
  ])('rejects %s', (url) => {
    expect(isDiscordUrl(url)).toBe(false);
  });
});

describe('buildGenericPayload', () => {
  it('describes the event and the server', () => {
    const body = JSON.parse(buildGenericPayload(WEBHOOK_EVENTS.SERVER_STARTED, context)) as Record<
      string,
      unknown
    >;

    expect(body).toMatchObject({
      event: 'server.started',
      occurredAt: '2026-08-04T12:00:00.000Z',
      server: {
        uuid: context.serverUuid,
        name: 'Test Linux',
        address: 'jeu.exemple.fr:25565',
        url: 'https://panel.exemple.fr/server/1b32d12d-7b10-443e-a259-6a31d67e28e6',
      },
    });
  });

  it('does not double the slash of the panel URL', () => {
    const body = JSON.parse(
      buildGenericPayload(WEBHOOK_EVENTS.SERVER_STARTED, { ...context, panelUrl: 'https://p.fr' }),
    ) as { server: { url: string } };

    expect(body.server.url).toBe('https://p.fr/server/1b32d12d-7b10-443e-a259-6a31d67e28e6');
  });

  it('carries the event details over', () => {
    const body = JSON.parse(
      buildGenericPayload(WEBHOOK_EVENTS.BACKUP_COMPLETED, {
        ...context,
        details: { name: 'nightly', size: '1.2 GiB' },
      }),
    ) as { details: Record<string, string> };

    expect(body.details).toEqual({ name: 'nightly', size: '1.2 GiB' });
  });
});

describe('buildDiscordPayload', () => {
  it('produces an embed', () => {
    const body = JSON.parse(buildDiscordPayload(WEBHOOK_EVENTS.SERVER_CRASHED, context)) as {
      embeds: { title: string; color: number; fields: { name: string }[] }[];
    };

    expect(body.embeds[0]!.title).toBe('Test Linux — Server stopped on its own');
    expect(body.embeds[0]!.color).toBe(0xf85149);
    expect(body.embeds[0]!.fields[0]!.name).toBe('Address');
  });

  it('does not exceed the 25 fields Discord accepts', () => {
    const details = Object.fromEntries(
      Array.from({ length: 40 }, (_, index) => [`field${index}`, index]),
    );

    const body = JSON.parse(
      buildDiscordPayload(WEBHOOK_EVENTS.BACKUP_COMPLETED, { ...context, details }),
    ) as { embeds: { fields: unknown[] }[] };

    expect(body.embeds[0]!.fields).toHaveLength(25);
  });
});

describe('buildPayload', () => {
  it('choisit le format selon la destination', () => {
    expect(
      buildPayload('https://discord.com/api/webhooks/1/x', 'server.started', context).discord,
    ).toBe(true);
    expect(buildPayload('https://exemple.fr/hook', 'server.started', context).discord).toBe(false);
  });
});

describe('signPayload', () => {
  it('signs stably', () => {
    expect(signPayload('secret', '{"a":1}')).toBe(signPayload('secret', '{"a":1}'));
    expect(signPayload('secret', '{"a":1}')).toMatch(/^sha256=[a-f0-9]{64}$/);
  });

  it('changes with the secret as with the body', () => {
    expect(signPayload('a', '{}')).not.toBe(signPayload('b', '{}'));
    expect(signPayload('a', '{}')).not.toBe(signPayload('a', '{"x":1}'));
  });

  it('verifies itself', () => {
    const body = '{"event":"server.started"}';

    expect(verifySignature('secret', body, signPayload('secret', body))).toBe(true);
    expect(verifySignature('autre', body, signPayload('secret', body))).toBe(false);
    // A truncated signature must not slip through a partial comparison.
    expect(verifySignature('secret', body, 'sha256=00')).toBe(false);
  });
});
