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
 * Résout l'accès d'un utilisateur à un serveur.
 *
 * Isolé du garde pour être testable seul : c'est la fonction qui décide qui
 * peut toucher à quoi, et elle doit être vérifiable sans monter une requête
 * HTTP ni un module Nest.
 *
 * Trois niveaux, dans cet ordre :
 *  1. **administrateur du panel** — toutes les permissions, sur tous les serveurs ;
 *  2. **propriétaire** — toutes les permissions sur ses serveurs ;
 *  3. **sous-utilisateur** — uniquement les permissions qui lui ont été accordées.
 *
 * Un utilisateur sans lien avec le serveur reçoit `null`, et l'appelant doit
 * répondre 404 plutôt que 403 : distinguer « existe mais interdit » de
 * « n'existe pas » permettrait d'énumérer les serveurs des autres.
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

    // `sanitizePermissions` écarte les valeurs devenues inconnues : une
    // permission retirée du code dans une version ultérieure ne doit pas être
    // interprétée comme un droit quelconque.
    return {
      id: server.id,
      uuid: server.uuid,
      nodeId: server.nodeId,
      permissions: sanitizePermissions(subuser.permissions),
      isOwner: false,
    };
  }
}
