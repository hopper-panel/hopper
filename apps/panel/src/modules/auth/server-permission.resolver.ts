import { ALL_PERMISSIONS, sanitizePermissions, type Permission } from '@hopper/shared';
import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service.js';

export interface ResolvedServerAccess {
  id: number;
  uuid: string;
  nodeId: number;
  permissions: Permission[];
  isOwner: boolean;
}

/**
 * Resolves a user's access to a server.
 *
 * Kept apart from the guard so it can be tested on its own: this is the
 * function that decides who may touch what, and it has to be checkable without
 * standing up an HTTP request or a Nest module.
 *
 * Three levels, in this order:
 *  1. **panel administrator** — every permission, on every server;
 *  2. **owner** — every permission on their own servers;
 *  3. **subuser** — only the permissions granted to them.
 *
 * A user with no link to the server gets `null`, and the caller has to answer
 * 404 rather than 403: telling "exists but forbidden" from "does not exist"
 * would allow enumerating other people's servers.
 */
@Injectable()
export class ServerPermissionResolver {
  constructor(private readonly prisma: PrismaService) {}

  async resolve(
    serverUuid: string,
    user: { id: number; role: 'ADMIN' | 'USER' },
  ): Promise<ResolvedServerAccess | null> {
    const server = await this.prisma.server.findUnique({
      where: { uuid: serverUuid },
      select: {
        id: true,
        uuid: true,
        nodeId: true,
        ownerId: true,
        subusers: {
          where: { userId: user.id },
          select: { permissions: true },
        },
      },
    });

    if (!server) {
      return null;
    }

    const isOwner = server.ownerId === user.id;

    if (user.role === 'ADMIN' || isOwner) {
      return {
        id: server.id,
        uuid: server.uuid,
        nodeId: server.nodeId,
        permissions: [...ALL_PERMISSIONS],
        isOwner,
      };
    }

    const subuser = server.subusers[0];
    if (!subuser) {
      return null;
    }

    // `sanitizePermissions` drops values that have become unknown: a
    // permission removed from the code in a later version must not be read as
    // some right or other.
    return {
      id: server.id,
      uuid: server.uuid,
      nodeId: server.nodeId,
      permissions: sanitizePermissions(subuser.permissions),
      isOwner: false,
    };
  }
}
