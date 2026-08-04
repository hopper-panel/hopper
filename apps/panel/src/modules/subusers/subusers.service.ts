import {
  DANGEROUS_PERMISSIONS,
  IMPLICIT_PERMISSIONS,
  sanitizePermissions,
  type Permission,
} from '@hopper/shared';
import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service.js';

/**
 * Sous-utilisateurs d'un serveur.
 *
 * Un sous-utilisateur est un **compte existant** du panel à qui l'on accorde
 * des permissions sur un serveur précis. Il n'y a pas d'invitation par courriel
 * ici : le panel est auto-hébergé, l'administrateur crée les comptes, et un
 * système d'invitation ajouterait une file d'attente de jetons à gérer pour un
 * gain nul dans ce contexte.
 *
 * Deux règles gouvernent l'attribution :
 *
 *  - **le propriétaire n'est pas un sous-utilisateur de son propre serveur** —
 *    lui en créer un lui donnerait moins de droits qu'il n'en a déjà, et
 *    laisserait croire qu'on peut les lui retirer ;
 *  - **on ne peut pas accorder ce qu'on n'a pas** : un sous-utilisateur qui
 *    gère les autres ne peut leur donner que ses propres permissions, sinon la
 *    délégation deviendrait une élévation de privilèges.
 */
@Injectable()
export class SubusersService {
  constructor(private readonly prisma: PrismaService) {}

  async list(serverUuid: string) {
    const server = await this.requireServer(serverUuid);

    const subusers = await this.prisma.subuser.findMany({
      where: { serverId: server.id },
      orderBy: { createdAt: 'asc' },
      include: { user: { select: { uuid: true, username: true, email: true } } },
    });

    return { data: subusers.map(toPublicSubuser) };
  }

  async create(
    serverUuid: string,
    input: { email: string; permissions: Permission[] },
    granter: { permissions: Permission[]; isOwner: boolean },
  ) {
    const server = await this.requireServer(serverUuid);
    const user = await this.prisma.user.findFirst({
      where: { email: input.email.trim().toLowerCase() },
      select: { id: true, uuid: true, username: true, email: true },
    });

    if (!user) {
      throw new NotFoundException(
        "Aucun compte n'existe avec cette adresse. Créez-le d'abord dans l'administration.",
      );
    }

    if (user.id === server.ownerId) {
      throw new BadRequestException(
        'Le propriétaire du serveur possède déjà toutes les permissions.',
      );
    }

    const existing = await this.prisma.subuser.findFirst({
      where: { serverId: server.id, userId: user.id },
    });

    if (existing) {
      throw new ConflictException('Ce compte a déjà accès à ce serveur.');
    }

    const permissions = this.grantable(input.permissions, granter);

    const subuser = await this.prisma.subuser.create({
      data: { serverId: server.id, userId: user.id, permissions },
      include: { user: { select: { uuid: true, username: true, email: true } } },
    });

    return toPublicSubuser(subuser);
  }

  async update(
    serverUuid: string,
    subuserUuid: string,
    permissions: Permission[],
    granter: { permissions: Permission[]; isOwner: boolean },
  ) {
    const existing = await this.requireSubuser(serverUuid, subuserUuid);

    const updated = await this.prisma.subuser.update({
      where: { id: existing.id },
      data: { permissions: this.grantable(permissions, granter) },
      include: { user: { select: { uuid: true, username: true, email: true } } },
    });

    return toPublicSubuser(updated);
  }

  async remove(serverUuid: string, subuserUuid: string): Promise<void> {
    const existing = await this.requireSubuser(serverUuid, subuserUuid);

    await this.prisma.subuser.delete({ where: { id: existing.id } });
  }

  /**
   * Restreint une demande de permissions à ce que l'attribuant peut donner.
   *
   * Les valeurs inconnues sont écartées par `sanitizePermissions` — une
   * permission supprimée d'une version à l'autre ne doit pas rester en base et
   * ressusciter au prochain rapprochement.
   */
  private grantable(
    requested: Permission[],
    granter: { permissions: Permission[]; isOwner: boolean },
  ): Permission[] {
    const sanitized = sanitizePermissions([...requested, ...IMPLICIT_PERMISSIONS]);

    if (granter.isOwner) {
      return sanitized;
    }

    const refused = sanitized.filter((permission) => !granter.permissions.includes(permission));

    if (refused.length > 0) {
      throw new BadRequestException(
        `Vous ne pouvez pas accorder une permission que vous n'avez pas : ${refused.join(', ')}.`,
      );
    }

    return sanitized;
  }

  private async requireServer(uuid: string) {
    const server = await this.prisma.server.findUnique({ where: { uuid } });

    if (!server) {
      throw new NotFoundException('Serveur introuvable.');
    }

    return server;
  }

  private async requireSubuser(serverUuid: string, subuserUuid: string) {
    const server = await this.requireServer(serverUuid);

    const subuser = await this.prisma.subuser.findFirst({
      where: { uuid: subuserUuid, serverId: server.id },
    });

    if (!subuser) {
      throw new NotFoundException('Sous-utilisateur introuvable.');
    }

    return subuser;
  }
}

interface SubuserRow {
  uuid: string;
  permissions: string[];
  createdAt: Date;
  user: { uuid: string; username: string; email: string };
}

function toPublicSubuser(subuser: SubuserRow) {
  return {
    uuid: subuser.uuid,
    user: subuser.user,
    permissions: subuser.permissions,
    /** Signalées à l'interface pour qu'elle puisse prévenir avant d'accorder. */
    dangerous: subuser.permissions.filter((permission) =>
      (DANGEROUS_PERMISSIONS as readonly string[]).includes(permission),
    ),
    createdAt: subuser.createdAt,
  };
}
