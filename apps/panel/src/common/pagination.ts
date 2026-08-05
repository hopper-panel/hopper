import { z } from 'zod';

/**
 * page/perPage pagination, shared by every list route.
 *
 * `perPage` is capped at 100: without a bound, a call to `?perPage=1000000`
 * would load the whole table into memory and take the panel down — a denial of
 * service any authenticated account could trigger by accident.
 */
export const paginationQuerySchema = z.object({
  page: z.coerce.number().int().positive().default(1),
  perPage: z.coerce.number().int().positive().max(100).default(25),
  /** Free-form search. Its interpretation is up to each module. */
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

/** SQL offset matching the requested page. */
export function skipFor(query: PaginationQuery): number {
  return (query.page - 1) * query.perPage;
}
