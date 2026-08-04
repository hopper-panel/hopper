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
import { ConfigService } from '@nestjs/config';
import { randomBytes } from 'node:crypto';
import type { Environment } from '../../config/environment.js';
import { MailService } from '../instance-settings/mail.service.js';
import { TokenService } from '../auth/token.service.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { AUDIT_EVENTS, AuditService } from '../audit/audit.service.js';
import { AuthService, type RequestContext } from '../auth/auth.service.js';
import { PasswordService } from '../auth/password.service.js';
import type { CreateUserDto, UpdateUserDto } from './users.dto.js';

/** Public view of a user. Never holds a sensitive field. */
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

/** How long an invitation link stays valid, in hours. */
const INVITATION_TTL_HOURS = 24;

@Injectable()
export class UsersService {
  private readonly appUrl: string;

  constructor(
    private readonly prisma: PrismaService,
    private readonly passwords: PasswordService,
    private readonly auth: AuthService,
    private readonly audit: AuditService,
    private readonly tokens: TokenService,
    private readonly mail: MailService,
    config: ConfigService<Environment, true>,
  ) {
    this.appUrl = config.get('APP_URL', { infer: true }).replace(/\/$/, '');
  }

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
      throw new NotFoundException('User not found.');
    }

    return toUserView(user);
  }

  async create(
    dto: CreateUserDto,
    /** Null when the creation comes from the command line, with no session. */
    actorId: number | null,
    context: RequestContext,
  ): Promise<UserView & { invitationSent: boolean }> {
    await this.assertAvailable(dto.email, dto.username);

    // With no password supplied, a random one nobody will ever know is set:
    // the account exists but stays unusable until its holder chooses one
    // through the link they received. Leaving the field empty in the database
    // would be worse — an empty hash always ends up meeting a comparison that
    // accepts it.
    const password = dto.password ?? randomBytes(48).toString('base64url');

    const user = await this.prisma.user.create({
      data: {
        email: dto.email.toLowerCase(),
        username: dto.username,
        role: dto.role,
        passwordHash: await this.passwords.hash(password),
      },
    });

    await this.audit.record({
      event: AUDIT_EVENTS.USER_CREATED,
      actorId,
      ip: context.ip,
      userAgent: context.userAgent,
      metadata: { targetUuid: user.uuid, username: user.username, role: user.role },
    });

    const invitationSent = await this.sendInvitation(user);

    return { ...toUserView(user), invitationSent };
  }

  /**
   * Sends the password-choice link.
   *
   * Returns true if the email left. A failure interrupts nothing: the account
   * is created, and an administrator can resend the invitation.
   */
  async sendInvitation(user: {
    uuid: string;
    email: string;
    username: string;
    passwordHash: string;
  }): Promise<boolean> {
    if (!(await this.mail.isConfigured())) {
      return false;
    }

    const token = await this.tokens.signPasswordSetup({
      userUuid: user.uuid,
      passwordHash: user.passwordHash,
      ttlSeconds: INVITATION_TTL_HOURS * 3600,
    });

    await this.mail.sendWelcome({
      to: user.email,
      username: user.username,
      setupUrl: `${this.appUrl}/set-password?token=${encodeURIComponent(token)}`,
      expiresInHours: INVITATION_TTL_HOURS,
    });

    return true;
  }

  /** Resends an invitation to an existing account. */
  async resendInvitation(uuid: string): Promise<{ sent: boolean }> {
    const user = await this.prisma.user.findUnique({
      where: { uuid },
      select: { uuid: true, email: true, username: true, passwordHash: true },
    });

    if (!user) {
      throw new NotFoundException('User not found.');
    }

    return { sent: await this.sendInvitation(user) };
  }

  async update(
    uuid: string,
    dto: UpdateUserDto,
    actorId: number | null,
    context: RequestContext,
  ): Promise<UserView> {
    const existing = await this.prisma.user.findUnique({ where: { uuid } });

    if (!existing) {
      throw new NotFoundException('User not found.');
    }

    if (dto.role === 'USER' && existing.role === 'ADMIN') {
      await this.assertNotLastAdmin(existing.id, 'demote');
    }

    if (dto.suspended === true && existing.role === 'ADMIN') {
      await this.assertNotLastAdmin(existing.id, 'suspend');
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

    // A password change, a suspension or a demotion has to take effect at
    // once, not when the current sessions expire. The other changes have no
    // consequence on rights.
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
        // The values are not logged, only the fields touched: a password has
        // no business in an audit log.
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
      throw new NotFoundException('User not found.');
    }

    // The schema already protects the relation (`onDelete: Restrict`), but the
    // raw Prisma error would be incomprehensible to an administrator.
    if (user._count.ownedServers > 0) {
      throw new BadRequestException(
        `This user owns ${user._count.ownedServers} server(s). Transfer or delete them first.`,
      );
    }

    if (user.role === 'ADMIN') {
      await this.assertNotLastAdmin(user.id, 'delete');
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
   * Stops the instance from ending up with no active administrator.
   *
   * Without this guard, an instance becomes unrecoverable from the interface:
   * the database then has to be edited by hand. It is an accident easily had
   * while cleaning up old accounts.
   */
  private async assertNotLastAdmin(userId: number, action: string): Promise<void> {
    const remaining = await this.prisma.user.count({
      where: { role: 'ADMIN', suspended: false, id: { not: userId } },
    });

    if (remaining === 0) {
      throw new BadRequestException(
        `Cannot ${action} the last active administrator: nobody would be left to administer the panel.`,
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
        throw new ConflictException('This email address is already in use.');
      }
    }

    if (username) {
      // A case-insensitive comparison: signing in is too, so `Julien` and
      // `julien` would be two accounts nobody could tell apart at
      // authentication time.
      const existing = await this.prisma.user.findFirst({
        where: { username: { equals: username, mode: 'insensitive' } },
      });
      if (existing && existing.id !== excludeId) {
        throw new ConflictException('This username is already taken.');
      }
    }
  }
}
