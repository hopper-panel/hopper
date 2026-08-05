import { useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { useTranslation } from '../i18n';
import { api, type Paginated, type ServerSummary } from '../lib/api';
import { formatAddress } from '../lib/format';
import { Modal } from './Modal';
import { Field, Input, Spinner } from './ui';

/**
 * Server search.
 *
 * Queries as you type, but only from two characters on and after a pause: one
 * request per keystroke would mostly return results already stale by the time
 * they arrive.
 *
 * It matches the name, the identifier **and** the port, because those are the
 * three ways a server is named in practice: its name when you know it, its UUID
 * when you read it in a log, its port when all you have is the address given to
 * players.
 */
export function SearchDialog({
  open,
  onClose,
  onSelect,
}: {
  open: boolean;
  onClose: () => void;
  onSelect: (uuid: string) => void;
}) {
  const { t } = useTranslation();
  const [term, setTerm] = useState('');
  const [debounced, setDebounced] = useState('');

  useEffect(() => {
    const timer = setTimeout(() => setDebounced(term.trim()), 250);
    return () => clearTimeout(timer);
  }, [term]);

  // The previous entry must not come back when reopening: one is almost
  // always looking for something else.
  useEffect(() => {
    if (!open) {
      setTerm('');
      setDebounced('');
    }
  }, [open]);

  const results = useQuery({
    queryKey: ['search', debounced],
    queryFn: () =>
      api.get<Paginated<ServerSummary>>(
        `/api/servers?search=${encodeURIComponent(debounced)}&perPage=8`,
      ),
    enabled: open && debounced.length >= 2,
  });

  const servers = results.data?.data ?? [];

  return (
    <Modal open={open} title={t('search.title')} onClose={onClose}>
      <Field label={t('search.field')} hint={t('search.hint')}>
        <Input
          value={term}
          onChange={(event) => setTerm(event.target.value)}
          placeholder={t('search.placeholder')}
          autoFocus
        />
      </Field>

      <div className="mt-4">
        {debounced.length < 2 ? null : results.isFetching ? (
          <Spinner label={t('search.searching')} />
        ) : servers.length === 0 ? (
          <p className="text-sm text-content-muted">{t('search.empty')}</p>
        ) : (
          <ul className="flex flex-col gap-1">
            {servers.map((server) => (
              <li key={server.uuid}>
                <button
                  type="button"
                  onClick={() => onSelect(server.uuid)}
                  className="flex w-full items-center justify-between gap-3 rounded-lg px-3 py-2 text-left transition-colors hover:bg-surface-hover"
                >
                  <span className="min-w-0">
                    <span className="block truncate text-sm text-content">{server.name}</span>
                    <span className="block truncate font-mono text-xs text-content-subtle">
                      {server.uuid}
                    </span>
                  </span>

                  <span className="shrink-0 font-mono text-xs text-content-muted">
                    {formatAddress(server.primaryAllocation, server.node.fqdn)}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </Modal>
  );
}
