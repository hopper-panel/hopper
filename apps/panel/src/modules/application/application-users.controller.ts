import { Body, Controller, Get, NotFoundException, Param, Patch, Query, Req } from '@nestjs/common';
import { z } from 'zod';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe.js';
import { ApplicationApi } from '../auth/decorators.js';
import {
  CurrentApplication,
  type AuthenticatedRequest,
  type RequestApplication,
} from '../auth/request-user.js';
import { AUDIT_EVENTS, AuditService } from '../audit/audit.service.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { usernameSchema } from '../users/users.dto.js';
import { UsersService } from '../users/users.service.js';

/**
 * Customers, as the system that billed them sees them.
 *
 * Accounts are *created* by provisioning — a purchase makes one and sends an
 * invitation — so there is no create route here. What is missing without this
 * controller is everything afterwards: an address changed in the billing
 * portal, a name corrected, an account suspended for fraud. Each of those is a
 * fact the billing system holds and the panel does not, and leaving them to be
 * copied by hand is how the two end up disagreeing about who a customer is.
 */
const updateSchema = z.object({
  email: z.email().max(191).optional(),
  username: usernameSchema.optional(),
  /**
   * Suspends the **account**, not the servers.
   *
   * A suspended account can no longer sign in; its servers keep running,
   * because cutting players off a community server over a billing dispute is
   * disproportionate. Suspending what a customer pays for is
   * `POST /api/application/servers/:uuid/suspend`, and the two are deliberately
   * separate decisions.
   */
  suspended: z.boolean().optional(),
});

type UpdateDto = z.infer<typeof updateSchema>;

@Controller('api/application/users')
@ApplicationApi('users')
export class ApplicationUsersController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly users: UsersService,
    private readonly audit: AuditService,
  ) {}

  /** Customers, newest first. `?email=` is how a billing system finds one. */
  @Get()
  async list(@Query('email') email?: string) {
    const users = await this.prisma.user.findMany({
      where: email === undefined ? {} : { email: email.toLowerCase() },
      select: this.view(),
      orderBy: { createdAt: 'desc' },
      take: 200,
    });

    return users.map((user) => this.toPublic(user));
  }

  @Get(':uuid')
  async find(@Param('uuid') uuid: string) {
    const user = await this.prisma.user.findUnique({ where: { uuid }, select: this.view() });

    if (!user) {
      throw new NotFoundException('User not found.');
    }

    return this.toPublic(user);
  }

  @Patch(':uuid')
  async update(
    @Param('uuid') uuid: string,
    @Body(new ZodValidationPipe(updateSchema)) body: UpdateDto,
    @CurrentApplication() application: RequestApplication,
    @Req() request: AuthenticatedRequest,
  ) {
    // No `role` and no `password`, and both omissions are the point. A leaked
    // billing credential must not be able to make an account an administrator,
    // and a password set here would travel through a channel neither side
    // controls — the invitation flow exists precisely so nobody has to.
    await this.users.update(uuid, body, null, {
      ip: request.ip,
      userAgent: request.headers['user-agent'],
    });

    await this.audit.record({
      event: AUDIT_EVENTS.USER_UPDATED,
      actorId: null,
      ip: request.ip,
      userAgent: request.headers['user-agent'],
      metadata: {
        targetUuid: uuid,
        fields: Object.keys(body),
        applicationKey: application.name,
      },
    });

    return this.find(uuid);
  }

  private view() {
    return {
      uuid: true,
      email: true,
      username: true,
      suspended: true,
      createdAt: true,
      _count: { select: { ownedServers: true } },
    } as const;
  }

  private toPublic(user: {
    uuid: string;
    email: string;
    username: string;
    suspended: boolean;
    createdAt: Date;
    _count: { ownedServers: number };
  }) {
    return {
      uuid: user.uuid,
      email: user.email,
      username: user.username,
      suspended: user.suspended,
      /** How many servers they own, so a cancellation can be reconciled. */
      servers: user._count.ownedServers,
      createdAt: user.createdAt,
    };
  }
}
