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

  it('lets a public IPv6 address through', () => {
    expect(isBlockedAddress('2001:4860:4860::8888')).toBe(false);
  });

  it('refuses what is not an address', () => {
    expect(isBlockedAddress('pas-une-adresse')).toBe(true);
    expect(isBlockedAddress('')).toBe(true);
  });

  it('does not get it wrong beyond 127.0.0.0/8', () => {
    // The trap: a mask computed without `>>> 0` goes negative beyond
    // 127.x.x.x, and every high address would pass for private.
    expect(isBlockedAddress('128.0.0.1')).toBe(false);
    expect(isBlockedAddress('200.1.2.3')).toBe(false);
  });
});

describe('assertSafeWebhookUrl', () => {
  /**
   * Simulated resolver: real resolution depends on the test machine's network,
   * and a non-existent domain takes several seconds to fail there.
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

  it('accepts a literal public address', async () => {
    await expect(assertSafeWebhookUrl('https://1.1.1.1/hook')).resolves.toBe('1.1.1.1');
  });

  it('refuses the loopback', async () => {
    await rejects('http://127.0.0.1:8080/internal', /internal network/);
  });

  it('refuses the cloud metadata service', async () => {
    await rejects('http://169.254.169.254/latest/meta-data/', /internal network/);
  });

  it('refuses a bracketed local IPv6 address', async () => {
    await rejects('http://[::1]:9000/', /internal network/);
  });

  it('refuses a non-HTTP scheme', async () => {
    await rejects('file:///etc/passwd', /http and https/);
    await rejects('gopher://example.com/', /http and https/);
  });

  it('refuses credentials in the address', async () => {
    await rejects('https://julien:secret@example.com/hook', /credentials/);
  });

  it('refuses an unreadable address', async () => {
    await rejects('not a url', /Invalid address/);
  });

  it('refuses a name that does not resolve', async () => {
    await rejects('https://unknown.example/', /does not resolve/);
  });

  it('accepts a name resolving to a public address', async () => {
    await expect(
      assertSafeWebhookUrl(
        'https://discord.com/api/webhooks/1/x',
        resolver({ 'discord.com': ['162.159.128.233'] }),
      ),
    ).resolves.toBe('discord.com');
  });

  it('refuses a public name resolving to a private address', async () => {
    // The classic bypass: the name is perfectly ordinary, it is the DNS answer
    // that points inside.
    await expect(
      assertSafeWebhookUrl(
        'https://interne.exemple/',
        resolver({ 'interne.exemple': ['10.0.0.5'] }),
      ),
    ).rejects.toThrow(/internal network/);
  });

  it('refuses as soon as a single address is private', async () => {
    // A DNS answer mixing a public and a private address would get through if
    // only the first were looked at.
    await expect(
      assertSafeWebhookUrl(
        'https://mixte.exemple/',
        resolver({ 'mixte.exemple': ['93.184.216.34', '127.0.0.1'] }),
      ),
    ).rejects.toThrow(/internal network/);
  });
});
