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
 * A server's subusers.
 *
 * A subuser is an **existing** panel account granted permissions on one
 * particular server. There is no email invitation here: the panel is
 * self-hosted, the administrator creates the accounts, and an invitation system
 * would add a queue of tokens to manage for no gain in this context.
 *
 * Two rules govern the grant:
 *
 *  - **the owner is not a subuser of their own server** — creating one for them
 *    would give them fewer rights than they already hold, and would suggest
 *    those rights could be taken away;
 *  - **one cannot grant what one does not have**: a subuser who manages the
 *    others can only give them their own permissions, otherwise delegation
 *    would become a privilege escalation.
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
        'No account exists with this address. Create it in the administration first.',
      );
    }

    if (user.id === server.ownerId) {
      throw new BadRequestException(
        'The server owner already holds every permission.',
      );
    }

    const existing = await this.prisma.subuser.findFirst({
      where: { serverId: server.id, userId: user.id },
    });

    if (existing) {
      throw new ConflictException('This account already has access to this server.');
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
   * Narrows a permission request to what the grantor can give.
   *
   * Unknown values are dropped by `sanitizePermissions` — a permission removed
   * from one version to the next must not stay in the database and come back to
   * life at the next reconciliation.
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
        `You cannot grant a permission you do not hold: ${refused.join(', ')}.`,
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
    /** Reported to the interface so it can warn before granting. */
    dangerous: subuser.permissions.filter((permission) =>
      (DANGEROUS_PERMISSIONS as readonly string[]).includes(permission),
    ),
    createdAt: subuser.createdAt,
  };
}
