import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

/**
 * Garde anti-SSRF des notifications sortantes.
 *
 * Une notification est une **requête émise par le panel vers une adresse
 * choisie par l'utilisateur**. Sans contrôle, un sous-utilisateur pointerait
 * son webhook sur `http://169.254.169.254/latest/meta-data/iam/` et se ferait
 * livrer les identifiants de la machine, ou balaierait le réseau interne en
 * lisant les codes de réponse. C'est la faille SSRF que `SECURITY.md` place
 * explicitement dans le périmètre.
 *
 * Le contrôle porte sur les **adresses résolues**, pas sur le nom : un domaine
 * public qui résout en 127.0.0.1 est le contournement le plus courant.
 */

export class UnsafeWebhookUrlError extends Error {}

/**
 * Plages IPv4 interdites, en notation CIDR.
 *
 * `100.64.0.0/10` — le CGNAT — y figure : chez un hébergeur qui l'utilise, il
 * mène à d'autres clients. `0.0.0.0/8` aussi : sur Linux, s'y connecter vise
 * l'hôte local.
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

/** Vrai pour une adresse qui ne doit jamais être jointe depuis le panel. */
export function isBlockedAddress(address: string): boolean {
  const version = isIP(address);

  if (version === 4) {
    const value = toInteger(address);

    if (value === null) {
      return true;
    }

    return BLOCKED_IPV4.some(([network, bits]) => {
      const base = toInteger(network)!;
      // `>>> 0` : en JavaScript les opérateurs binaires travaillent sur 32 bits
      // signés, et un décalage sur une adresse au-delà de 127.x.x.x donnerait un
      // nombre négatif — donc une comparaison fausse.
      const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
      return (value & mask) >>> 0 === base;
    });
  }

  if (version === 6) {
    const normalized = address.toLowerCase();

    // Une adresse IPv4 encapsulée (`::ffff:127.0.0.1`) doit être jugée sur sa
    // partie v4 : elle atteint exactement la même machine.
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(normalized);

    if (mapped) {
      return isBlockedAddress(mapped[1]!);
    }

    if (normalized === '::' || normalized === '::1') {
      return true;
    }

    const head = normalized.split(':')[0] ?? '';

    // fc00::/7 (adresses locales uniques) et fe80::/10 (lien-local).
    return /^f[cd]/.test(head) || /^fe[89ab]/.test(head);
  }

  // Ni v4 ni v6 : ce n'est pas une adresse, l'appelant n'aurait pas dû nous la
  // passer. Refuser est le comportement sûr.
  return true;
}

export type Resolver = (host: string) => Promise<{ address: string }[]>;

const systemResolver: Resolver = (host) => lookup(host, { all: true });

/**
 * Valide l'URL d'une notification, résolution DNS comprise.
 *
 * Rend le nom d'hôte validé. Lève `UnsafeWebhookUrlError` avec un message
 * destiné à l'utilisateur.
 *
 * Reste hors de portée : le rebinding DNS, où le nom résout en adresse publique
 * ici puis en adresse privée au moment de la requête. S'en protéger imposerait
 * d'épingler l'adresse dans le client HTTP, ce que `fetch` ne permet pas. La
 * vérification est donc refaite avant chaque envoi, ce qui réduit la fenêtre
 * sans la fermer.
 */
export async function assertSafeWebhookUrl(
  raw: string,
  /** Injectable pour les tests : la résolution réelle dépend du réseau. */
  resolve: Resolver = systemResolver,
): Promise<string> {
  let url: URL;

  try {
    url = new URL(raw);
  } catch {
    throw new UnsafeWebhookUrlError('Adresse invalide.');
  }

  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new UnsafeWebhookUrlError('Seules les adresses http et https sont acceptées.');
  }

  // Des identifiants dans l'URL partiraient en clair dans les journaux du
  // destinataire comme dans les nôtres.
  if (url.username !== '' || url.password !== '') {
    throw new UnsafeWebhookUrlError('L’adresse ne doit pas contenir d’identifiants.');
  }

  // `hostname` conserve les crochets d'une adresse IPv6 littérale.
  const host = url.hostname.replace(/^\[|\]$/g, '');

  if (isIP(host) !== 0) {
    if (isBlockedAddress(host)) {
      throw new UnsafeWebhookUrlError('Cette adresse appartient à un réseau interne.');
    }

    return host;
  }

  let resolved;
  try {
    resolved = await resolve(host);
  } catch {
    throw new UnsafeWebhookUrlError('Ce nom de domaine ne résout pas.');
  }

  if (resolved.length === 0) {
    throw new UnsafeWebhookUrlError('Ce nom de domaine ne résout pas.');
  }

  // **Toutes** les adresses doivent être publiques, pas seulement la première :
  // un nom qui résout en une adresse publique et une adresse privée serait
  // sinon accepté, et le système pourrait joindre la seconde.
  if (resolved.some((entry) => isBlockedAddress(entry.address))) {
    throw new UnsafeWebhookUrlError('Ce nom de domaine mène à un réseau interne.');
  }

  return host;
}
