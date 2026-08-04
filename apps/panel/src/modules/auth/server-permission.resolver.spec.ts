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

  it('accorde toutes les permissions au propriétaire', async () => {
    const { resolver } = makeResolver(row);
    const access = await resolver.resolve(SERVER_UUID, OWNER);

    expect(access?.isOwner).toBe(true);
    expect(access?.permissions).toEqual([...ALL_PERMISSIONS]);
  });

  it('accorde toutes les permissions à un administrateur du panel', async () => {
    const { resolver } = makeResolver(row);
    const access = await resolver.resolve(SERVER_UUID, ADMIN);

    expect(access?.permissions).toEqual([...ALL_PERMISSIONS]);
    // Un administrateur n'est pas propriétaire : l'interface doit pouvoir
    // afficher qu'il agit à titre administratif.
    expect(access?.isOwner).toBe(false);
  });

  it("n'accorde à un sous-utilisateur que ses permissions", async () => {
    row.subusers = [{ permissions: [PERMISSIONS.CONTROL_CONSOLE, PERMISSIONS.FILE_READ] }];
    const { resolver } = makeResolver(row);

    const access = await resolver.resolve(SERVER_UUID, SUBUSER);

    expect(access?.permissions).toEqual([PERMISSIONS.CONTROL_CONSOLE, PERMISSIONS.FILE_READ]);
    expect(access?.permissions).not.toContain(PERMISSIONS.SETTINGS_REINSTALL);
    expect(access?.isOwner).toBe(false);
  });

  // Le garde traduit ce null en 404 : un 403 sur un serveur existant
  // permettrait d'énumérer les serveurs des autres par essais successifs.
  it('renvoie null pour un utilisateur sans lien avec le serveur', async () => {
    const { resolver } = makeResolver(row);
    expect(await resolver.resolve(SERVER_UUID, STRANGER)).toBeNull();
  });

  it('renvoie null pour un serveur inexistant', async () => {
    const { resolver } = makeResolver(null);
    expect(await resolver.resolve(SERVER_UUID, ADMIN)).toBeNull();
  });

  // Une permission supprimée du code dans une version ultérieure reste en base.
  // L'interpréter comme un droit quelconque serait une élévation silencieuse.
  it('écarte une permission inconnue stockée en base', async () => {
    row.subusers = [{ permissions: [PERMISSIONS.FILE_READ, 'file.chmod', 'server.root'] }];
    const { resolver } = makeResolver(row);

    const access = await resolver.resolve(SERVER_UUID, SUBUSER);

    expect(access?.permissions).toEqual([PERMISSIONS.FILE_READ]);
  });

  it('ne charge que le sous-utilisateur concerné', async () => {
    const { resolver, findUnique } = makeResolver(row);
    await resolver.resolve(SERVER_UUID, SUBUSER);

    const args = findUnique.mock.calls[0]?.[0] as {
      select: { subusers: { where: { userId: number } } };
    };
    expect(args.select.subusers.where.userId).toBe(SUBUSER.id);
  });

  it('donne un accès vide à un sous-utilisateur sans aucune permission', async () => {
    row.subusers = [{ permissions: [] }];
    const { resolver } = makeResolver(row);

    const access = await resolver.resolve(SERVER_UUID, SUBUSER);

    // L'accès existe — le serveur est visible dans sa liste — mais aucune
    // action n'est autorisée.
    expect(access).not.toBeNull();
    expect(access?.permissions).toEqual([]);
  });
});
