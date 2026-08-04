import { useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { api, type Paginated, type ServerSummary } from '../lib/api';
import { formatAddress } from '../lib/format';
import { Modal } from './Modal';
import { Field, Input, Spinner } from './ui';

/**
 * Recherche de serveur.
 *
 * Interroge l'API à mesure de la frappe, mais seulement à partir de deux
 * caractères et après une pause : une requête par touche renverrait surtout
 * des résultats déjà périmés au moment où ils arrivent, et ferait travailler la
 * base pour rien.
 *
 * La recherche porte sur le nom, l'identifiant **et** le port, parce que ce
 * sont les trois façons dont on désigne un serveur en pratique : son nom quand
 * on le connaît, son UUID quand on l'a relevé dans un journal, son port quand
 * on ne dispose que de l'adresse donnée aux joueurs.
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
  const [term, setTerm] = useState('');
  const [debounced, setDebounced] = useState('');

  useEffect(() => {
    const timer = setTimeout(() => setDebounced(term.trim()), 250);
    return () => clearTimeout(timer);
  }, [term]);

  // La saisie précédente ne doit pas réapparaître à la réouverture : on
  // cherche presque toujours autre chose.
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
    <Modal open={open} title="Rechercher un serveur" onClose={onClose}>
      <Field
        label="Terme de recherche"
        hint="Un nom de serveur, un identifiant ou un port. Deux caractères au minimum."
      >
        <Input
          value={term}
          onChange={(event) => setTerm(event.target.value)}
          placeholder="survie, 25565, 1b32d12d-…"
          autoFocus
        />
      </Field>

      <div className="mt-4">
        {debounced.length < 2 ? null : results.isFetching ? (
          <Spinner label="Recherche…" />
        ) : servers.length === 0 ? (
          <p className="text-sm text-content-muted">Aucun serveur ne correspond.</p>
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
