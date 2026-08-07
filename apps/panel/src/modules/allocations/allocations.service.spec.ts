import { NODE_CAPABILITIES } from '@hopper/shared';
import { ConflictException, ServiceUnavailableException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import type { PrismaService } from '../../prisma/prisma.service.js';
import type { NodeClientService } from '../nodes/node-client.service.js';
import type { NodesService } from '../nodes/nodes.service.js';
import type { ServerConfigurationService } from '../servers/server-configuration.service.js';
import { AllocationsService } from './allocations.service.js';

/**
 * Naming a port.
 *
 * A name is not a label: the daemon matches a readiness `role` against it and
 * knocks on whatever carries it. Everything here is about refusing to store a
 * name that would not mean what it says — because the component that reads it
 * has no way to complain, it just quietly uses the game port instead and stops
 * a healthy server when the deadline runs out.
 */

const SERVER_UUID = '1b32d12d-7b10-443e-a259-6a31d67e28e6';

interface Fixture {
  /** Allocations already assigned to the server. */
  allocations?: {
    id: number;
    ip: string;
    port: number;
    alias: string | null;
    role: string | null;
  }[];
  primaryAllocationId?: number;
  /** What the node's daemon announces it honours. */
  capabilities?: string[];
  /** An unreachable node answers nothing at all. */
  unreachable?: boolean;
}

function serviceFor(fixture: Fixture = {}) {
  const allocations = fixture.allocations ?? [
    { id: 1, ip: '0.0.0.0', port: 25565, alias: null, role: null },
    { id: 2, ip: '0.0.0.0', port: 25575, alias: null, role: null },
  ];

  const updated = vi.fn((args: { where: { id: number }; data: Record<string, unknown> }) => {
    const row = allocations.find((allocation) => allocation.id === args.where.id);
    return Promise.resolve({ ...row, ...args.data });
  });

  const prisma = {
    server: {
      findUnique: () =>
        Promise.resolve({
          id: 7,
          uuid: SERVER_UUID,
          nodeId: 3,
          primaryAllocationId: fixture.primaryAllocationId ?? 1,
          allocationLimit: 4,
        }),
      update: () => Promise.resolve({}),
    },
    node: { findUniqueOrThrow: () => Promise.resolve({ uuid: 'node-uuid' }) },
    allocation: {
      findFirst: (args: { where: Record<string, unknown> }) =>
        Promise.resolve(
          allocations.find((allocation) => {
            const where = args.where as {
              id?: number | { not: number };
              role?: string;
              serverId?: number;
            };

            if (typeof where.id === 'number' && allocation.id !== where.id) {
              return false;
            }

            if (typeof where.id === 'object' && allocation.id === where.id.not) {
              return false;
            }

            return where.role === undefined || allocation.role === where.role;
          }) ?? null,
        ),
      update: updated,
    },
  } as unknown as PrismaService;

  const client = {
    fetchSystemInformation: vi.fn(() =>
      Promise.resolve(
        fixture.unreachable
          ? { reachable: false as const, reason: 'Could not connect to the daemon.', latencyMs: 1 }
          : {
              reachable: true as const,
              latencyMs: 1,
              system: {
                capabilities: fixture.capabilities ?? [NODE_CAPABILITIES.allocationRoles],
              },
            },
      ),
    ),
  } as unknown as NodeClientService;

  const service = new AllocationsService(
    prisma,
    // The daemon is never reached in these tests beyond the capability probe:
    // a sync that fails is already swallowed on purpose, since a momentarily
    // unreachable node must not lose the change.
    {
      build: () => Promise.reject(new Error('not synced here')),
    } as unknown as ServerConfigurationService,
    { getConnection: () => Promise.resolve({}) } as unknown as NodesService,
    client,
  );

  return { service, updated, client };
}

describe('AllocationsService.setRole', () => {
  it('stores a name the node announces it honours', async () => {
    const { service, updated } = serviceFor();

    const result = await service.setRole(SERVER_UUID, 2, 'rcon');

    expect(updated).toHaveBeenCalledWith({ where: { id: 2 }, data: { role: 'rcon' } });
    expect(result.role).toBe('rcon');
  });

  it('refuses a name on a node whose daemon would throw it away', async () => {
    // The silent half of the version skew: `role` travels inside the server
    // configuration and Zod strips what a schema does not know, so an older
    // daemon receives an allocation with no name, resolves the strategy
    // against the primary port and says nothing. The panel would show a named
    // port and the operator would believe a check was running.
    const { service, updated } = serviceFor({ capabilities: [] });

    await expect(service.setRole(SERVER_UUID, 2, 'rcon')).rejects.toBeInstanceOf(ConflictException);
    expect(updated).not.toHaveBeenCalled();
  });

  it('refuses a name while the node cannot be asked', async () => {
    // "It will probably be fine" is the guess this whole path exists to avoid,
    // and naming a port is not urgent: it takes effect on the next start.
    const { service, updated } = serviceFor({ unreachable: true });

    await expect(service.setRole(SERVER_UUID, 2, 'rcon')).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
    expect(updated).not.toHaveBeenCalled();
  });

  it('clears a name without asking the node anything', async () => {
    // Taking a name away can only make a strategy fall back to refusing out
    // loud. An operator undoing a mistake must not be blocked by the machine
    // the mistake is on.
    const { service, updated, client } = serviceFor({ unreachable: true });

    await service.setRole(SERVER_UUID, 2, null);

    expect(updated).toHaveBeenCalledWith({ where: { id: 2 }, data: { role: null } });
    expect(client.fetchSystemInformation).not.toHaveBeenCalled();
  });

  it('refuses to name the primary port', async () => {
    // It is already reached by being the primary, and the configuration gives
    // it no field to carry a second name in. Two names for one port is one
    // name too many.
    const { service, updated } = serviceFor();

    await expect(service.setRole(SERVER_UUID, 1, 'game')).rejects.toBeInstanceOf(ConflictException);
    expect(updated).not.toHaveBeenCalled();
  });

  it('refuses a name another port on the same server already holds', async () => {
    // The unique index refuses it too, as a P2002 the operator reads as
    // "Internal server error". This refusal says which port has the name.
    const { service, updated } = serviceFor({
      allocations: [
        { id: 1, ip: '0.0.0.0', port: 25565, alias: null, role: null },
        { id: 2, ip: '0.0.0.0', port: 25575, alias: null, role: 'rcon' },
        { id: 3, ip: '0.0.0.0', port: 25585, alias: null, role: null },
      ],
    });

    await expect(service.setRole(SERVER_UUID, 3, 'rcon')).rejects.toThrow('25575');
    expect(updated).not.toHaveBeenCalled();
  });
});

describe('AllocationsService.setPrimary', () => {
  it('refuses to promote a named port', async () => {
    // The promotion would drop the name in silence — the primary allocation
    // carries none — and every strategy naming it would start refusing, on a
    // server nobody had touched apart from this one click.
    const { service } = serviceFor({
      allocations: [
        { id: 1, ip: '0.0.0.0', port: 25565, alias: null, role: null },
        { id: 2, ip: '0.0.0.0', port: 25575, alias: null, role: 'rcon' },
      ],
    });

    await expect(service.setPrimary(SERVER_UUID, 2)).rejects.toThrow('rcon');
  });
});

/**
 * A name belongs to a port *for one server*: a template resolves `rcon` against
 * the server holding it. So a port that goes back to the node's free pool must
 * arrive at its next owner unnamed.
 *
 * Clearing it on the way *in* is what makes that hold. Clearing it on the way
 * out cannot: deleting a server never runs through `remove` — the foreign key
 * is `ON DELETE SET NULL`, which nulls `serverId` and leaves the name behind —
 * so a port released that way keeps a name nobody can see and nobody chose.
 */
describe('AllocationsService.add', () => {
  function serviceForAdd(freeRole: string | null) {
    const free = { id: 9, nodeId: 3, ip: '0.0.0.0', port: 25580, alias: null, role: freeRole };
    // Typed argument rather than a bare `vi.fn()`: without it the mock's call
    // tuple is empty and reading `calls[0][0]` does not compile.
    const updateMany = vi.fn((_args: { where: unknown; data: Record<string, unknown> }) =>
      Promise.resolve({ count: 1 }),
    );

    const prisma = {
      server: {
        findUnique: () =>
          Promise.resolve({
            id: 7,
            uuid: SERVER_UUID,
            nodeId: 3,
            primaryAllocationId: 1,
            allocationLimit: 4,
          }),
        update: () => Promise.resolve({}),
      },
      node: { findUniqueOrThrow: () => Promise.resolve({ uuid: 'node-uuid' }) },
      allocation: {
        count: () => Promise.resolve(1),
        findFirst: () => Promise.resolve(free),
        updateMany,
      },
    } as unknown as PrismaService;

    const service = new AllocationsService(
      prisma,
      {
        build: () => Promise.reject(new Error('not synced here')),
      } as unknown as ServerConfigurationService,
      { getConnection: () => Promise.resolve({}) } as unknown as NodesService,
      { fetchSystemInformation: vi.fn() } as unknown as NodeClientService,
    );

    return { service, updateMany };
  }

  it('clears the name a released port was still carrying', async () => {
    const { service, updateMany } = serviceForAdd('rcon');

    await service.add(SERVER_UUID);

    expect(updateMany).toHaveBeenCalledWith({
      where: { id: 9, serverId: null },
      data: { serverId: 7, role: null },
    });
  });

  it('claims an unnamed port the same way', async () => {
    const { service, updateMany } = serviceForAdd(null);

    await service.add(SERVER_UUID);

    expect(updateMany.mock.calls[0]![0]).toMatchObject({ data: { role: null } });
  });
});
