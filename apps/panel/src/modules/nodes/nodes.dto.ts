import { z } from 'zod';

/**
 * The FQDN has to resolve **from the users' browsers**, not only from the
 * panel: the console opens a WebSocket straight to the daemon. A private
 * address such as `192.168.x.x` therefore works on a local network but breaks
 * any console opened from outside — that is flagged to the administrator rather
 * than refused, self-hosting on a LAN being a legitimate use.
 */
const fqdnSchema = z
  .string()
  .min(1)
  .max(255)
  .regex(/^[a-zA-Z0-9.-]+$/, 'The FQDN may only contain letters, digits, dots and hyphens.');

/**
 * What a node is made of, with no default attached to any of it.
 *
 * Split out from the two schemas below because **`.partial()` does not remove a
 * `.default()`** — it wraps it, and an absent key still comes out holding the
 * default. `updateNodeSchema` used to be `createNodeSchema.partial()`, which
 * meant a PATCH carrying nothing but a corrected address arrived at the service
 * as a full object: capacity back to 0, port back to 8443, scheme back to
 * https, description emptied, maintenance cleared.
 *
 * Nothing had noticed because nothing called that route — the administration
 * had no way to edit a node, which is the gap this change closes. Adding the
 * form without this would have shipped a screen whose every save destroyed the
 * fields it did not show.
 *
 * `NodesService.update` was already written for the correct behaviour: it hands
 * Prisma `dto.x` and relies on `undefined` meaning "leave this column alone"
 * (see the `BigInt` guards). It only ever received values.
 */
const nodeShape = {
  name: z.string().min(1).max(100),
  description: z.string().max(1000),

  fqdn: fqdnSchema,
  scheme: z.enum(['http', 'https']),
  port: z.number().int().min(1).max(65535),
  sftpPort: z.number().int().min(1).max(65535),

  memoryBytes: z.number().int().nonnegative(),
  diskBytes: z.number().int().nonnegative(),
  /** -1 = no limit, 0 = overallocation forbidden. */
  memoryOverallocation: z.number().int().min(-1).max(1000),
  diskOverallocation: z.number().int().min(-1).max(1000),

  maintenance: z.boolean(),
};

export const createNodeSchema = z.object({
  ...nodeShape,
  description: nodeShape.description.default(''),
  scheme: nodeShape.scheme.default('https'),
  port: nodeShape.port.default(8443),
  sftpPort: nodeShape.sftpPort.default(2022),
  memoryBytes: nodeShape.memoryBytes.default(0),
  diskBytes: nodeShape.diskBytes.default(0),
  memoryOverallocation: nodeShape.memoryOverallocation.default(0),
  diskOverallocation: nodeShape.diskOverallocation.default(0),
  maintenance: nodeShape.maintenance.default(false),
});

export const updateNodeSchema = z.object(nodeShape).partial();

/**
 * Creating allocations by range: `25565-25585` creates 21 ports at once.
 * Typing a hundred ports one by one in the interface would be unbearable.
 */
export const createAllocationsSchema = z.object({
  ip: z
    .string()
    .min(1)
    .max(45)
    .regex(/^[0-9a-fA-F.:]+$/, 'Invalid IP.'),
  /** A single port (`25565`) or a range (`25565-25585`). */
  ports: z
    .array(z.string().regex(/^\d{1,5}(-\d{1,5})?$/, 'Expected format: 25565 or 25565-25585.'))
    .min(1)
    .max(50),
  alias: z.string().max(255).optional(),
});

export type CreateNodeDto = z.infer<typeof createNodeSchema>;
export type UpdateNodeDto = z.infer<typeof updateNodeSchema>;
export type CreateAllocationsDto = z.infer<typeof createAllocationsSchema>;

/**
 * Largest number of ports created in one request.
 *
 * A `1-65535` range would insert 65,000 rows and block the database for several
 * seconds. The bound is deliberately low: allocating more than a thousand ports
 * to a node is far more often a typo than a real need.
 */
export const MAX_ALLOCATIONS_PER_REQUEST = 1000;

/** Turns `["25565", "25570-25572"]` into `[25565, 25570, 25571, 25572]`. */
export function expandPortRanges(ports: string[]): number[] {
  const expanded = new Set<number>();

  for (const entry of ports) {
    const [startRaw, endRaw] = entry.split('-');
    const start = Number(startRaw);
    const end = endRaw === undefined ? start : Number(endRaw);

    if (!Number.isInteger(start) || start < 1 || start > 65535) {
      throw new Error(`Port out of range: ${entry}`);
    }

    if (!Number.isInteger(end) || end < 1 || end > 65535) {
      throw new Error(`Port out of range: ${entry}`);
    }

    if (end < start) {
      throw new Error(`Reversed range: ${entry}`);
    }

    if (end - start + 1 > MAX_ALLOCATIONS_PER_REQUEST) {
      throw new Error(`Range ${entry} exceeds ${MAX_ALLOCATIONS_PER_REQUEST} ports. Split it up.`);
    }

    for (let port = start; port <= end; port += 1) {
      expanded.add(port);
    }
  }

  if (expanded.size > MAX_ALLOCATIONS_PER_REQUEST) {
    throw new Error(
      `${expanded.size} ports requested, at most ${MAX_ALLOCATIONS_PER_REQUEST} per request.`,
    );
  }

  return [...expanded].sort((a, b) => a - b);
}
