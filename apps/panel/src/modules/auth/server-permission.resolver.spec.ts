import { ALL_PERMISSIONS, PERMISSIONS } from '@hopper/shared';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PrismaService } from '../../prisma/prisma.service.js';
import { ServerPermissionResolver } from './server-permission.resolver.js';

const SERVER_UUID = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';

const OWNER = { id: 1, role: 'USER' as const };
const SUBUSER = { id: 2, role: 'USER' as const };
const STRANGER = { id: 3, role: 'USER' as const };
const ADMIN = { id: 4, role: 'ADMIN' as const };

interface ServerRow {
  id: number;
  uuid: string;
  nodeId: number;
  ownerId: number;
  subusers: { permissions: string[] }[];
}

function makeResolver(row: ServerRow | null): {
  resolver: ServerPermissionResolver;
  findUnique: ReturnType<typeof vi.fn>;
} {
  const findUnique = vi.fn().mockResolvedValue(row);
  const prisma = { server: { findUnique } } as unknown as PrismaService;
  return { resolver: new ServerPermissionResolver(prisma), findUnique };
}

describe('ServerPermissionResolver', () => {
  let row: ServerRow;

  beforeEach(() => {
    row = { id: 10, uuid: SERVER_UUID, nodeId: 2, ownerId: OWNER.id, subusers: [] };
  });

  it('grants every permission to the owner', async () => {
    const { resolver } = makeResolver(row);
    const access = await resolver.resolve(SERVER_UUID, OWNER);

    expect(access?.isOwner).toBe(true);
    expect(access?.permissions).toEqual([...ALL_PERMISSIONS]);
  });

  it('grants every permission to a panel administrator', async () => {
    const { resolver } = makeResolver(row);
    const access = await resolver.resolve(SERVER_UUID, ADMIN);

    expect(access?.permissions).toEqual([...ALL_PERMISSIONS]);
    // An administrator is not an owner: the interface has to be able to show
    // they are acting in an administrative capacity.
    expect(access?.isOwner).toBe(false);
  });

  it('grants a subuser only their own permissions', async () => {
    row.subusers = [{ permissions: [PERMISSIONS.CONTROL_CONSOLE, PERMISSIONS.FILE_READ] }];
    const { resolver } = makeResolver(row);

    const access = await resolver.resolve(SERVER_UUID, SUBUSER);

    expect(access?.permissions).toEqual([PERMISSIONS.CONTROL_CONSOLE, PERMISSIONS.FILE_READ]);
    expect(access?.permissions).not.toContain(PERMISSIONS.SETTINGS_REINSTALL);
    expect(access?.isOwner).toBe(false);
  });

  // The guard turns this null into a 404: a 403 on an existing server
  // would allow enumerating other people's servers by trial and error.
  it('returns null for a user with no link to the server', async () => {
    const { resolver } = makeResolver(row);
    expect(await resolver.resolve(SERVER_UUID, STRANGER)).toBeNull();
  });

  it('returns null for a server that does not exist', async () => {
    const { resolver } = makeResolver(null);
    expect(await resolver.resolve(SERVER_UUID, ADMIN)).toBeNull();
  });

  // A permission removed from the code in a later version stays in the
  // database. Reading it as some right or other would be a silent escalation.
  it('drops an unknown permission stored in the database', async () => {
    row.subusers = [{ permissions: [PERMISSIONS.FILE_READ, 'file.chmod', 'server.root'] }];
    const { resolver } = makeResolver(row);

    const access = await resolver.resolve(SERVER_UUID, SUBUSER);

    expect(access?.permissions).toEqual([PERMISSIONS.FILE_READ]);
  });

  it('loads only the subuser concerned', async () => {
    const { resolver, findUnique } = makeResolver(row);
    await resolver.resolve(SERVER_UUID, SUBUSER);

    const args = findUnique.mock.calls[0]?.[0] as {
      select: { subusers: { where: { userId: number } } };
    };
    expect(args.select.subusers.where.userId).toBe(SUBUSER.id);
  });

  it('gives empty access to a subuser with no permission at all', async () => {
    row.subusers = [{ permissions: [] }];
    const { resolver } = makeResolver(row);

    const access = await resolver.resolve(SERVER_UUID, SUBUSER);

    // The access exists — the server shows in their list — but no action is
    // allowed.
    expect(access).not.toBeNull();
    expect(access?.permissions).toEqual([]);
  });
});
