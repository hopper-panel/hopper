import { z } from 'zod';

export const createDatabaseSchema = z.object({
  /**
   * Partie du nom choisie par l'utilisateur. Le nom réel est préfixé par
   * l'identifiant du serveur — deux serveurs ne peuvent pas se disputer
   * « plugins ». La validation fine revient à `identifiers.ts`, qui est la
   * barrière contre l'injection ; ce schéma n'écarte que le grossier.
   */
  name: z.string().trim().min(1).max(32),
  /** Vide, la base accepte les connexions de n'importe où. */
  remote: z.string().trim().max(60).optional(),
});

export type CreateDatabaseDto = z.infer<typeof createDatabaseSchema>;

export const createDatabaseHostSchema = z.object({
  name: z.string().trim().min(1).max(100),
  host: z.string().trim().min(1).max(255),
  port: z.coerce.number().int().min(1).max(65535).default(3306),
  username: z.string().trim().min(1).max(64),
  password: z.string().min(1).max(255),
  /** Adresse annoncée aux joueurs, si elle diffère de celle qu'emprunte le panel. */
  publicHost: z.string().trim().max(255).optional(),
  publicPort: z.coerce.number().int().min(1).max(65535).optional(),
  /** Restreint le host à un node. Absent, il est proposé à tous. */
  nodeUuid: z.uuid().optional(),
});

export type CreateDatabaseHostDto = z.infer<typeof createDatabaseHostSchema>;
