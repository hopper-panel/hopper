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
  ])('reconnaît %s', (url) => {
    expect(isDiscordUrl(url)).toBe(true);
  });

  it.each([
    'https://exemple.fr/hook',
    // Le chemin compte : la page d'accueil de Discord n'est pas un webhook.
    'https://discord.com/channels/123',
    // Et le domaine aussi : un attaquant ne doit pas obtenir le format Discord
    // en choisissant un sous-domaine qui y ressemble.
    'https://discord.com.exemple.fr/api/webhooks/1/x',
    'pas une url',
  ])('rejette %s', (url) => {
    expect(isDiscordUrl(url)).toBe(false);
  });
});

describe('buildGenericPayload', () => {
  it('décrit l’événement et le serveur', () => {
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

  it('ne double pas la barre oblique de l’URL du panel', () => {
    const body = JSON.parse(
      buildGenericPayload(WEBHOOK_EVENTS.SERVER_STARTED, { ...context, panelUrl: 'https://p.fr' }),
    ) as { server: { url: string } };

    expect(body.server.url).toBe('https://p.fr/server/1b32d12d-7b10-443e-a259-6a31d67e28e6');
  });

  it('reprend les détails de l’événement', () => {
    const body = JSON.parse(
      buildGenericPayload(WEBHOOK_EVENTS.BACKUP_COMPLETED, {
        ...context,
        details: { name: 'nocturne', taille: '1,2 Gio' },
      }),
    ) as { details: Record<string, string> };

    expect(body.details).toEqual({ name: 'nocturne', taille: '1,2 Gio' });
  });
});

describe('buildDiscordPayload', () => {
  it('produit un embed', () => {
    const body = JSON.parse(buildDiscordPayload(WEBHOOK_EVENTS.SERVER_CRASHED, context)) as {
      embeds: { title: string; color: number; fields: { name: string }[] }[];
    };

    expect(body.embeds[0]!.title).toBe('Test Linux — Serveur arrêté seul');
    expect(body.embeds[0]!.color).toBe(0xf85149);
    expect(body.embeds[0]!.fields[0]!.name).toBe('Adresse');
  });

  it('ne dépasse pas les 25 champs acceptés par Discord', () => {
    const details = Object.fromEntries(
      Array.from({ length: 40 }, (_, index) => [`champ${index}`, index]),
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
  it('signe de façon stable', () => {
    expect(signPayload('secret', '{"a":1}')).toBe(signPayload('secret', '{"a":1}'));
    expect(signPayload('secret', '{"a":1}')).toMatch(/^sha256=[a-f0-9]{64}$/);
  });

  it('change avec le secret comme avec le corps', () => {
    expect(signPayload('a', '{}')).not.toBe(signPayload('b', '{}'));
    expect(signPayload('a', '{}')).not.toBe(signPayload('a', '{"x":1}'));
  });

  it('se vérifie', () => {
    const body = '{"event":"server.started"}';

    expect(verifySignature('secret', body, signPayload('secret', body))).toBe(true);
    expect(verifySignature('autre', body, signPayload('secret', body))).toBe(false);
    // Une signature tronquée ne doit pas passer par une comparaison partielle.
    expect(verifySignature('secret', body, 'sha256=00')).toBe(false);
  });
});
