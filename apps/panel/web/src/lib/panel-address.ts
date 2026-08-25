import { useQuery } from '@tanstack/react-query';
import { api } from './api';

/**
 * The address the panel answers to, and whether this browser is on it.
 *
 * A panel reached by an address other than its own is not obviously broken. It
 * signs in, it lists servers, it starts and stops them — and then the console
 * stays empty, because the browser sends an `Origin` the node was never told
 * about and the node closes the socket. The daemon says "Origin not allowed.",
 * which is true and useless: it names what was refused, never what would have
 * been accepted.
 *
 * The panel knows both halves. It is configured with one address, and the
 * browser is standing on another. Comparing them is the whole diagnosis, so it
 * lives here rather than being re-derived by each screen that needs it.
 */
export interface PanelIdentity {
  name: string;
  defaultLocale: string;
  /** The panel's configured public address, as an origin. */
  url?: string;
}

/**
 * Shared with the sign-in page, which asks the same endpoint for the instance
 * name: one query key, one request, whatever asks first.
 */
export function usePanelIdentity() {
  return useQuery({
    queryKey: ['panel', 'branding'],
    queryFn: () => api.get<PanelIdentity>('/api/panel'),
    // The panel's own address does not change while a tab is open, and every
    // screen that shows a diagnosis about it would otherwise refetch on focus.
    staleTime: Infinity,
  });
}

export type AddressVerdict =
  | { kind: 'expected' }
  | { kind: 'wrong-address'; expected: string }
  /** Nothing to compare against: an old panel, or the endpoint unreachable. */
  | { kind: 'unknown' };

/**
 * Compares the address the panel is configured with against the one in the
 * address bar.
 *
 * Both are reduced to an origin before comparing. The configured value already
 * is one — the environment schema sees to that — but a panel upgraded from an
 * older version, or one behind something that rewrites it, can still send
 * `https://panel.example.com/`, and refusing to recognise that as the same
 * address would turn this diagnosis into the second false alarm of the day.
 *
 * An unparseable value gives `unknown` rather than `wrong-address`: this
 * function exists to explain a failure, and a wrong explanation costs more than
 * a missing one.
 */
export function compareAddress(configured: string | undefined, current: string): AddressVerdict {
  if (configured === undefined || configured === '') {
    return { kind: 'unknown' };
  }

  let expected: string;

  try {
    expected = new URL(configured).origin;
  } catch {
    return { kind: 'unknown' };
  }

  return expected === current ? { kind: 'expected' } : { kind: 'wrong-address', expected };
}

/** The verdict for the page being displayed. */
export function useAddressVerdict(): AddressVerdict {
  const identity = usePanelIdentity();

  return compareAddress(identity.data?.url, window.location.origin);
}
