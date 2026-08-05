import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

/**
 * Anti-SSRF guard for outgoing notifications.
 *
 * A notification is a **request the panel makes to an address chosen by the
 * user**. Without a check, a subuser would point their webhook at
 * `http://169.254.169.254/latest/meta-data/iam/` and have the machine's
 * credentials delivered to them, or sweep the internal network by reading
 * response codes. This is the SSRF flaw `SECURITY.md` puts explicitly in scope.
 *
 * The check applies to the **resolved addresses**, not the name: a public
 * domain resolving to 127.0.0.1 is the most common bypass.
 */

export class UnsafeWebhookUrlError extends Error {}

/**
 * Forbidden IPv4 ranges, in CIDR notation.
 *
 * `100.64.0.0/10` — CGNAT — is there: at a host that uses it, it leads to other
 * customers. `0.0.0.0/8` too: on Linux, connecting there targets the local
 * host.
 */
const BLOCKED_IPV4: [string, number][] = [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
];

function toInteger(address: string): number | null {
  const parts = address.split('.');

  if (parts.length !== 4) {
    return null;
  }

  let value = 0;

  for (const part of parts) {
    const octet = Number(part);

    if (!Number.isInteger(octet) || octet < 0 || octet > 255) {
      return null;
    }

    value = value * 256 + octet;
  }

  return value;
}

/** True for an address the panel must never reach. */
export function isBlockedAddress(address: string): boolean {
  const version = isIP(address);

  if (version === 4) {
    const value = toInteger(address);

    if (value === null) {
      return true;
    }

    return BLOCKED_IPV4.some(([network, bits]) => {
      const base = toInteger(network)!;
      // `>>> 0`: in JavaScript the bitwise operators work on signed 32-bit
      // integers, and a shift on an address beyond 127.x.x.x would give a
      // negative number — hence a wrong comparison.
      const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
      return (value & mask) >>> 0 === base;
    });
  }

  if (version === 6) {
    const normalized = address.toLowerCase();

    // A mapped IPv4 address (`::ffff:127.0.0.1`) has to be judged on its v4
    // part: it reaches exactly the same machine.
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(normalized);

    if (mapped) {
      return isBlockedAddress(mapped[1]!);
    }

    if (normalized === '::' || normalized === '::1') {
      return true;
    }

    const head = normalized.split(':')[0] ?? '';

    // fc00::/7 (unique local addresses) and fe80::/10 (link-local).
    return /^f[cd]/.test(head) || /^fe[89ab]/.test(head);
  }

  // Neither v4 nor v6: this is not an address, the caller should not have
  // passed it. Refusing is the safe behaviour.
  return true;
}

export type Resolver = (host: string) => Promise<{ address: string }[]>;

const systemResolver: Resolver = (host) => lookup(host, { all: true });

/**
 * Validates a notification's URL, DNS resolution included.
 *
 * Returns the validated host name. Throws `UnsafeWebhookUrlError` with a
 * message meant for the user.
 *
 * Out of reach: DNS rebinding, where the name resolves to a public address here
 * then to a private one at request time. Protecting against it would mean
 * pinning the address in the HTTP client, which `fetch` does not allow. The
 * check is therefore redone before every send, which narrows the window without
 * closing it.
 */
export async function assertSafeWebhookUrl(
  raw: string,
  /** Injectable for the tests: real resolution depends on the network. */
  resolve: Resolver = systemResolver,
): Promise<string> {
  let url: URL;

  try {
    url = new URL(raw);
  } catch {
    throw new UnsafeWebhookUrlError('Invalid address.');
  }

  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new UnsafeWebhookUrlError('Only http and https addresses are accepted.');
  }

  // Credentials in the URL would travel in the clear into the recipient's logs
  // as well as our own.
  if (url.username !== '' || url.password !== '') {
    throw new UnsafeWebhookUrlError('The address must not contain credentials.');
  }

  // `hostname` keeps the brackets of a literal IPv6 address.
  const host = url.hostname.replace(/^\[|\]$/g, '');

  if (isIP(host) !== 0) {
    if (isBlockedAddress(host)) {
      throw new UnsafeWebhookUrlError('This address belongs to an internal network.');
    }

    return host;
  }

  let resolved;
  try {
    resolved = await resolve(host);
  } catch {
    throw new UnsafeWebhookUrlError('This domain name does not resolve.');
  }

  if (resolved.length === 0) {
    throw new UnsafeWebhookUrlError('This domain name does not resolve.');
  }

  // **Every** address has to be public, not only the first: a name resolving
  // to one public and one private address would otherwise be accepted, and the
  // system could reach the second.
  if (resolved.some((entry) => isBlockedAddress(entry.address))) {
    throw new UnsafeWebhookUrlError('This domain name leads to an internal network.');
  }

  return host;
}
