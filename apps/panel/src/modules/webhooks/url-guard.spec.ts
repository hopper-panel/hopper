import { describe, expect, it } from 'vitest';
import { assertSafeWebhookUrl, isBlockedAddress, UnsafeWebhookUrlError } from './url-guard.js';

describe('isBlockedAddress', () => {
  it.each([
    '127.0.0.1',
    '127.10.20.30',
    '10.0.0.1',
    '10.255.255.254',
    '172.16.0.1',
    '172.31.255.254',
    '192.168.1.1',
    '169.254.169.254', // métadonnées AWS, GCP, Azure
    '100.64.0.1', // CGNAT : mène à d'autres clients de l'hébergeur
    '0.0.0.0',
    '224.0.0.1',
    '255.255.255.255',
  ])('bloque %s', (address) => {
    expect(isBlockedAddress(address)).toBe(true);
  });

  it.each(['1.1.1.1', '8.8.8.8', '51.38.34.244', '172.32.0.1', '192.169.0.1', '99.255.255.255'])(
    'laisse passer %s',
    (address) => {
      expect(isBlockedAddress(address)).toBe(false);
    },
  );

  it.each(['::1', '::', 'fc00::1', 'fd12:3456::1', 'fe80::1', '::ffff:127.0.0.1'])(
    'bloque %s',
    (address) => {
      expect(isBlockedAddress(address)).toBe(true);
    },
  );

  it('laisse passer une adresse IPv6 publique', () => {
    expect(isBlockedAddress('2001:4860:4860::8888')).toBe(false);
  });

  it('refuse ce qui n’est pas une adresse', () => {
    expect(isBlockedAddress('pas-une-adresse')).toBe(true);
    expect(isBlockedAddress('')).toBe(true);
  });

  it('ne se trompe pas au-delà de 127.0.0.0/8', () => {
    // Le piège : un masque calculé sans `>>> 0` devient négatif au-delà de
    // 127.x.x.x, et toutes les adresses hautes passeraient pour privées.
    expect(isBlockedAddress('128.0.0.1')).toBe(false);
    expect(isBlockedAddress('200.1.2.3')).toBe(false);
  });
});

describe('assertSafeWebhookUrl', () => {
  /**
   * Résolveur simulé : la vraie résolution dépend du réseau de la machine de
   * test, et un domaine inexistant y met plusieurs secondes à échouer.
   */
  const resolver =
    (map: Record<string, string[]>) =>
    (host: string): Promise<{ address: string }[]> => {
      const addresses = map[host];

      return addresses === undefined
        ? Promise.reject(new Error('NXDOMAIN'))
        : Promise.resolve(addresses.map((address) => ({ address })));
    };

  const rejects = async (url: string, extract: RegExp): Promise<void> => {
    await expect(assertSafeWebhookUrl(url, resolver({}))).rejects.toThrow(UnsafeWebhookUrlError);
    await expect(assertSafeWebhookUrl(url, resolver({}))).rejects.toThrow(extract);
  };

  it('accepte une adresse publique littérale', async () => {
    await expect(assertSafeWebhookUrl('https://1.1.1.1/hook')).resolves.toBe('1.1.1.1');
  });

  it('refuse la boucle locale', async () => {
    await rejects('http://127.0.0.1:8080/interne', /réseau interne/);
  });

  it('refuse le service de métadonnées du cloud', async () => {
    await rejects('http://169.254.169.254/latest/meta-data/', /réseau interne/);
  });

  it('refuse une adresse IPv6 locale entre crochets', async () => {
    await rejects('http://[::1]:9000/', /réseau interne/);
  });

  it('refuse un protocole non HTTP', async () => {
    await rejects('file:///etc/passwd', /http et https/);
    await rejects('gopher://exemple.fr/', /http et https/);
  });

  it('refuse des identifiants dans l’adresse', async () => {
    await rejects('https://julien:secret@exemple.fr/hook', /identifiants/);
  });

  it('refuse une adresse illisible', async () => {
    await rejects('pas une url', /invalide/);
  });

  it('refuse un nom qui ne résout pas', async () => {
    await rejects('https://inconnu.exemple/', /ne résout pas/);
  });

  it('accepte un nom qui résout en adresse publique', async () => {
    await expect(
      assertSafeWebhookUrl(
        'https://discord.com/api/webhooks/1/x',
        resolver({ 'discord.com': ['162.159.128.233'] }),
      ),
    ).resolves.toBe('discord.com');
  });

  it('refuse un nom public qui résout en adresse privée', async () => {
    // Le contournement classique : le nom est parfaitement banal, c'est la
    // réponse DNS qui pointe à l'intérieur.
    await expect(
      assertSafeWebhookUrl('https://interne.exemple/', resolver({ 'interne.exemple': ['10.0.0.5'] })),
    ).rejects.toThrow(/réseau interne/);
  });

  it('refuse dès qu’une seule des adresses est privée', async () => {
    // Une réponse DNS mêlant une adresse publique et une privée passerait si
    // l'on ne regardait que la première.
    await expect(
      assertSafeWebhookUrl(
        'https://mixte.exemple/',
        resolver({ 'mixte.exemple': ['93.184.216.34', '127.0.0.1'] }),
      ),
    ).rejects.toThrow(/réseau interne/);
  });
});
