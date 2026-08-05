import { z } from 'zod';

export const createDatabaseSchema = z.object({
  /**
   * The part of the name chosen by the user. The real name is prefixed with
   * the server identifier — two servers cannot fight over "plugins". The fine
   * validation belongs to `identifiers.ts`, which is the barrier against
   * injection; this schema only rules out the crude.
   */
  name: z.string().trim().min(1).max(32),
  /** Empty, the database accepts connections from anywhere. */
  remote: z.string().trim().max(60).optional(),
});

export type CreateDatabaseDto = z.infer<typeof createDatabaseSchema>;

export const createDatabaseHostSchema = z.object({
  name: z.string().trim().min(1).max(100),
  host: z.string().trim().min(1).max(255),
  port: z.coerce.number().int().min(1).max(65535).default(3306),
  username: z.string().trim().min(1).max(64),
  password: z.string().min(1).max(255),
  /** Address given to players, if it differs from the one the panel uses. */
  publicHost: z.string().trim().max(255).optional(),
  publicPort: z.coerce.number().int().min(1).max(65535).optional(),
  /** Restricts the host to one node. When absent, it is offered to all. */
  nodeUuid: z.uuid().optional(),
});

export type CreateDatabaseHostDto = z.infer<typeof createDatabaseHostSchema>;
