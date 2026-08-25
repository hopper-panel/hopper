import { useTranslation } from '../i18n';
import { useAddressVerdict } from '../lib/panel-address';

/**
 * Says so when the panel has been reached by an address that is not its own.
 *
 * Nothing else on the page will. A panel opened by its IP address while its
 * nodes hold a host name signs in, lists the servers and starts them; the
 * console stays empty because the node closes a socket whose `Origin` it was
 * never told about, and the sign-in page offers a passkey that cannot work
 * because the relying party is derived from the address the panel was
 * configured with.
 *
 * So it appears on both sides of the sign-in, and for everybody rather than for
 * administrators alone: the person who meets the empty console is whoever runs
 * the server, and the fix is a link.
 */
export function WrongAddressBanner() {
  const { t } = useTranslation();
  const address = useAddressVerdict();

  if (address.kind !== 'wrong-address') {
    return null;
  }

  return (
    <div className="border-b border-danger/40 bg-danger/10">
      <div className="mx-auto flex max-w-7xl flex-wrap items-center gap-3 px-4 py-2.5 text-sm text-content">
        <span>
          {t('address.wrong', { address: address.expected, current: window.location.origin })}
        </span>
        {/* A plain anchor: another origin is not somewhere the router can go,
            and a full page load is exactly what is wanted here. */}
        <a
          href={address.expected}
          className="ml-auto rounded-lg bg-danger px-3 py-1.5 text-sm font-medium text-surface"
        >
          {t('address.goThere')}
        </a>
      </div>
    </div>
  );
}
