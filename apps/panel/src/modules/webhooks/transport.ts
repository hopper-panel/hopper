import { PANEL_VERSION } from '../../version.js';
import { signPayload } from './payload.js';
import { UnsafeWebhookUrlError, assertSafeWebhookUrl } from './url-guard.js';

/**
 * Sending one signed request, and saying plainly what happened.
 *
 * Extracted from `WebhooksService` when a second kind of notification appeared
 * — the instance-wide ones a hosting provider subscribes to. What the two share
 * is not the payload, which is entirely different, but the three properties
 * that make an outbound request from a panel safe to have at all: the address
 * is revalidated at send time, the body is signed, and the call cannot hang.
 *
 * Having that in one place is the point. Two copies would be two chances for
 * one of them to lose the SSRF check during a refactor, and the copy that lost
 * it would still work perfectly.
 */

/**
 * A recipient that does not answer must not hold the panel back. The request
 * that triggered the event is already finished; without this the process would
 * keep the connection open.
 */
const DELIVERY_TIMEOUT_MS = 5000;

export interface DeliveryOutcome {
  ok: boolean;
  status: number | null;
  error: string | null;
}

export async function postSigned(options: {
  url: string;
  /** Signing key, in clear. Callers decrypt it; this never touches the store. */
  secret: string;
  /** Goes out as `X-Hopper-Event`, and is what the recipient routes on. */
  event: string;
  body: string;
}): Promise<DeliveryOutcome> {
  try {
    // Revalidated on every send: between creation and now, the name may have
    // started pointing at the internal network.
    await assertSafeWebhookUrl(options.url);

    const response = await fetch(options.url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'user-agent': `Hopper/${PANEL_VERSION}`,
        'x-hopper-event': options.event,
        'x-hopper-signature': signPayload(options.secret, options.body),
      },
      body: options.body,
      signal: AbortSignal.timeout(DELIVERY_TIMEOUT_MS),
    });

    return {
      ok: response.ok,
      status: response.status,
      error: response.ok ? null : `The recipient answered ${response.status}.`,
    };
  } catch (error: unknown) {
    return {
      ok: false,
      status: null,
      error:
        error instanceof UnsafeWebhookUrlError
          ? error.message
          : error instanceof Error
            ? error.message
            : 'Could not send.',
    };
  }
}
