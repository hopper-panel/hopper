import { z } from 'zod';

/**
 * Le FQDN doit résoudre **depuis le navigateur des utilisateurs**, pas
 * seulement depuis le panel : la console ouvre un WebSocket directement vers le
 * daemon. Une adresse privée type `192.168.x.x` fonctionne donc en réseau
 * local, mais casse toute console ouverte depuis l'extérieur — c'est signalé à
 * l'administrateur au lieu d'être refusé, l'auto-hébergement en LAN étant un
 * cas d'usage légitime.
 */
const fqdnSchema = z
  .string()
  .min(1)
  .max(255)
  .regex(
    /^[a-zA-Z0-9.-]+$/,
    'Le FQDN ne peut contenir que des lettres, chiffres, points et tirets.',
  );

export const createNodeSchema = z.object({
  name: z.string().min(1).max(100),
  description: z.string().max(1000).default(''),

  fqdn: fqdnSchema,
  scheme: z.enum(['http', 'https']).default('https'),
  port: z.number().int().min(1).max(65535).default(8443),
  sftpPort: z.number().int().min(1).max(65535).default(2022),

  memoryBytes: z.number().int().nonnegative().default(0),
  diskBytes: z.number().int().nonnegative().default(0),
  /** -1 = pas de limite, 0 = surallocation interdite. */
  memoryOverallocation: z.number().int().min(-1).max(1000).default(0),
  diskOverallocation: z.number().int().min(-1).max(1000).default(0),

  maintenance: z.boolean().default(false),
});

export const updateNodeSchema = createNodeSchema.partial();

/**
 * Création d'allocations par plage : `25565-25585` crée 21 ports d'un coup.
 * Saisir cent ports un par un dans l'interface serait intenable.
 */
export const createAllocationsSchema = z.object({
  ip: z
    .string()
    .min(1)
    .max(45)
    .regex(/^[0-9a-fA-F.:]+$/, 'IP invalide.'),
  /** Un port isolé (`25565`) ou une plage (`25565-25585`). */
  ports: z
    .array(z.string().regex(/^\d{1,5}(-\d{1,5})?$/, 'Format attendu : 25565 ou 25565-25585.'))
    .min(1)
    .max(50),
  alias: z.string().max(255).optional(),
});

export type CreateNodeDto = z.infer<typeof createNodeSchema>;
export type UpdateNodeDto = z.infer<typeof updateNodeSchema>;
export type CreateAllocationsDto = z.infer<typeof createAllocationsSchema>;

/**
 * Nombre maximal de ports créés en une requête.
 *
 * Une plage `1-65535` insérerait 65 000 lignes et bloquerait la base plusieurs
 * secondes. La borne est volontairement basse : allouer plus de mille ports à
 * un node relève de l'erreur de saisie bien plus souvent que du besoin réel.
 */
export const MAX_ALLOCATIONS_PER_REQUEST = 1000;

/** Convertit `["25565", "25570-25572"]` en `[25565, 25570, 25571, 25572]`. */
export function expandPortRanges(ports: string[]): number[] {
  const expanded = new Set<number>();

  for (const entry of ports) {
    const [startRaw, endRaw] = entry.split('-');
    const start = Number(startRaw);
    const end = endRaw === undefined ? start : Number(endRaw);

    if (!Number.isInteger(start) || start < 1 || start > 65535) {
      throw new Error(`Port hors plage : ${entry}`);
    }

    if (!Number.isInteger(end) || end < 1 || end > 65535) {
      throw new Error(`Port hors plage : ${entry}`);
    }

    if (end < start) {
      throw new Error(`Plage inversée : ${entry}`);
    }

    if (end - start + 1 > MAX_ALLOCATIONS_PER_REQUEST) {
      throw new Error(
        `La plage ${entry} dépasse ${MAX_ALLOCATIONS_PER_REQUEST} ports. Découpez-la.`,
      );
    }

    for (let port = start; port <= end; port += 1) {
      expanded.add(port);
    }
  }

  if (expanded.size > MAX_ALLOCATIONS_PER_REQUEST) {
    throw new Error(
      `${expanded.size} ports demandés, maximum ${MAX_ALLOCATIONS_PER_REQUEST} par requête.`,
    );
  }

  return [...expanded].sort((a, b) => a - b);
}
