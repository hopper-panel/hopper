import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { Prisma, User } from '@prisma/client';
import {
  paginate,
  skipFor,
  type Paginated,
  type PaginationQuery,
} from '../../common/pagination.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { AUDIT_EVENTS, AuditService } from '../audit/audit.service.js';
import { AuthService, type RequestContext } from '../auth/auth.service.js';
import { PasswordService } from '../auth/password.service.js';
import type { CreateUserDto, UpdateUserDto } from './users.dto.js';

/** Vue publique d'un utilisateur. Ne contient jamais de champ sensible. */
export interface UserView {
  uuid: string;
  email: string;
  username: string;
  role: 'ADMIN' | 'USER';
  suspended: boolean;
  twoFactorEnabled: boolean;
  lastLoginAt: Date | null;
  createdAt: Date;
}

export function toUserView(user: User): UserView {
  return {
    uuid: user.uuid,
    email: user.email,
    username: user.username,
    role: user.role,
    suspended: user.suspended,
    twoFactorEnabled: user.totpConfirmed,
    lastLoginAt: user.lastLoginAt,
    createdAt: user.createdAt,
  };
}

@Injectable()
export class UsersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly passwords: PasswordService,
    private readonly auth: AuthService,
    private readonly audit: AuditService,
  ) {}

  async list(query: PaginationQuery): Promise<Paginated<UserView>> {
    const where: Prisma.UserWhereInput = query.search
      ? {
          OR: [
            { email: { contains: query.search, mode: 'insensitive' } },
            { username: { contains: query.search, mode: 'insensitive' } },
          ],
        }
      : {};

    const [users, total] = await this.prisma.$transaction([
      this.prisma.user.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: skipFor(query),
        take: query.perPage,
      }),
      this.prisma.user.count({ where }),
    ]);

    return paginate(users.map(toUserView), total, query);
  }

  async findByUuid(uuid: string): Promise<UserView> {
    const user = await this.prisma.user.findUnique({ where: { uuid } });

    if (!user) {
      throw new NotFoundException('Utilisateur introuvable.');
    }

    return toUserView(user);
  }

  async create(dto: CreateUserDto, actorId: number, context: RequestContext): Promise<UserView> {
    await this.assertAvailable(dto.email, dto.username);

    const user = await this.prisma.user.create({
      data: {
        email: dto.email.toLowerCase(),
        username: dto.username,
        role: dto.role,
        passwordHash: await this.passwords.hash(dto.password),
      },
    });

    await this.audit.record({
      event: AUDIT_EVENTS.USER_CREATED,
      actorId,
      ip: context.ip,
      userAgent: context.userAgent,
      metadata: { targetUuid: user.uuid, username: user.username, role: user.role },
    });

    return toUserView(user);
  }

  async update(
    uuid: string,
    dto: UpdateUserDto,
    actorId: number,
    context: RequestContext,
  ): Promise<UserView> {
    const existing = await this.prisma.user.findUnique({ where: { uuid } });

    if (!existing) {
      throw new NotFoundException('Utilisateur introuvable.');
    }

    if (dto.role === 'USER' && existing.role === 'ADMIN') {
      await this.assertNotLastAdmin(existing.id, 'rétrograder');
    }

    if (dto.suspended === true && existing.role === 'ADMIN') {
      await this.assertNotLastAdmin(existing.id, 'suspendre');
    }

    await this.assertAvailable(dto.email, dto.username, existing.id);

    const user = await this.prisma.user.update({
      where: { id: existing.id },
      data: {
        email: dto.email?.toLowerCase(),
        username: dto.username,
        role: dto.role,
        suspended: dto.suspended,
        passwordHash: dto.password ? await this.passwords.hash(dto.password) : undefined,
      },
    });

    // Un changement de mot de passe, une suspension ou une rétrogradation
    // doivent prendre effet tout de suite, pas à l'expiration des sessions en
    // cours. Les autres modifications sont sans conséquence sur les droits.
    if (dto.password || dto.suspended === true || dto.role === 'USER') {
      await this.auth.revokeAllSessions(existing.id);
    }

    await this.audit.record({
      event: AUDIT_EVENTS.USER_UPDATED,
      actorId,
      ip: context.ip,
      userAgent: context.userAgent,
      metadata: {
        targetUuid: user.uuid,
        // Les valeurs ne sont pas journalisées, seuls les champs touchés : un
        // mot de passe n'a rien à faire dans un journal d'audit.
        changed: Object.keys(dto),
      },
    });

    return toUserView(user);
  }

  async remove(uuid: string, actorId: number, context: RequestContext): Promise<void> {
    const user = await this.prisma.user.findUnique({
      where: { uuid },
      include: { _count: { select: { ownedServers: true } } },
    });

    if (!user) {
      throw new NotFoundException('Utilisateur introuvable.');
    }

    // Le schéma protège déjà la relation (`onDelete: Restrict`), mais l'erreur
    // Prisma brute serait incompréhensible pour un administrateur.
    if (user._count.ownedServers > 0) {
      throw new BadRequestException(
        `Cet utilisateur possède ${user._count.ownedServers} serveur(s). Transférez-les ou supprimez-les d'abord.`,
      );
    }

    if (user.role === 'ADMIN') {
      await this.assertNotLastAdmin(user.id, 'supprimer');
    }

    await this.prisma.user.delete({ where: { id: user.id } });

    await this.audit.record({
      event: AUDIT_EVENTS.USER_DELETED,
      actorId,
      ip: context.ip,
      userAgent: context.userAgent,
      metadata: { targetUuid: uuid, username: user.username },
    });
  }

  /**
   * Empêche de se retrouver sans aucun administrateur actif.
   *
   * Sans ce garde-fou, une instance devient irrécupérable depuis l'interface :
   * il faut alors éditer la base à la main. C'est un accident vite arrivé quand
   * on nettoie de vieux comptes.
   */
  private async assertNotLastAdmin(userId: number, action: string): Promise<void> {
    const remaining = await this.prisma.user.count({
      where: { role: 'ADMIN', suspended: false, id: { not: userId } },
    });

    if (remaining === 0) {
      throw new BadRequestException(
        `Impossible de ${action} le dernier administrateur actif : plus personne ne pourrait administrer le panel.`,
      );
    }
  }

  private async assertAvailable(
    email?: string,
    username?: string,
    excludeId?: number,
  ): Promise<void> {
    if (email) {
      const existing = await this.prisma.user.findUnique({ where: { email: email.toLowerCase() } });
      if (existing && existing.id !== excludeId) {
        throw new ConflictException('Cette adresse e-mail est déjà utilisée.');
      }
    }

    if (username) {
      // Comparaison insensible à la casse : la connexion l'est aussi, donc
      // `Julien` et `julien` seraient deux comptes qu'on ne saurait pas
      // distinguer au moment de s'authentifier.
      const existing = await this.prisma.user.findFirst({
        where: { username: { equals: username, mode: 'insensitive' } },
      });
      if (existing && existing.id !== excludeId) {
        throw new ConflictException("Ce nom d'utilisateur est déjà pris.");
      }
    }
  }
}
