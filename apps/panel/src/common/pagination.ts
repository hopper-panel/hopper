import { z } from 'zod';

/**
 * Pagination par page/perPage, partagée par toutes les routes de liste.
 *
 * `perPage` est plafonné à 100 : sans borne, un appel `?perPage=1000000`
 * chargerait toute la table en mémoire et ferait tomber le panel — une
 * dénégation de service que n'importe quel compte authentifié pourrait
 * déclencher par accident.
 */
export const paginationQuerySchema = z.object({
  page: z.coerce.number().int().positive().default(1),
  perPage: z.coerce.number().int().positive().max(100).default(25),
  /** Recherche libre. L'interprétation dépend de chaque module. */
  search: z.string().max(191).optional(),
});

export type PaginationQuery = z.infer<typeof paginationQuerySchema>;

export interface Paginated<T> {
  data: T[];
  meta: {
    currentPage: number;
    perPage: number;
    lastPage: number;
    total: number;
  };
}

export function paginate<T>(data: T[], total: number, query: PaginationQuery): Paginated<T> {
  return {
    data,
    meta: {
      currentPage: query.page,
      perPage: query.perPage,
      lastPage: Math.max(1, Math.ceil(total / query.perPage)),
      total,
    },
  };
}

/** Décalage SQL correspondant à la page demandée. */
export function skipFor(query: PaginationQuery): number {
  return (query.page - 1) * query.perPage;
}
