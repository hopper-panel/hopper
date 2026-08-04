import { PERMISSIONS } from '@hopper/shared';
import { Controller, Get, NotFoundException, Param, Query } from '@nestjs/common';
import {
  paginate,
  paginationQuerySchema,
  skipFor,
  type Paginated,
  type PaginationQuery,
} from '../../common/pagination.js';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { RequireServerPermission } from '../auth/decorators.js';
import { describeEvent } from './describe-event.js';

export interface ActivityEntry {
  uuid: string;
  event: string;
  description: string;
  /** Null for a system action: scheduler, daemon. */
  actor: { username: string } | null;
  ip: string | null;
  createdAt: Date;
}

/**
 * A server's activity log.
 *
 * The audit log has existed from the start and was already filling on every
 * action; it simply was not readable anywhere. This tab only exposes it,
 * filtered on the server being viewed.
 *
 * The IP address is shown: that is what makes the log useful after the fact —
 * knowing *that* somebody deleted a world helps less than knowing from where.
 * The `userAgent` is recorded but not returned: it teaches the reader nothing
 * and lengthens every line.
 */
@Controller('api/servers/:serverId/activity')
export class ActivityController {
  constructor(private readonly prisma: PrismaService) {}

  @Get()
  @RequireServerPermission(PERMISSIONS.ACTIVITY_READ)
  async list(
    @Param('serverId') serverId: string,
    @Query(new ZodValidationPipe(paginationQuerySchema)) query: PaginationQuery,
  ): Promise<Paginated<ActivityEntry>> {
    const server = await this.prisma.server.findUnique({
      where: { uuid: serverId },
      select: { id: true },
    });

    if (!server) {
      throw new NotFoundException('Server not found.');
    }

    const where = { serverId: server.id };

    const [entries, total] = await Promise.all([
      this.prisma.auditLog.findMany({
        where,
        // Newest first: one reads a log to learn what just happened, not what
        // happened at creation time.
        orderBy: { createdAt: 'desc' },
        skip: skipFor(query),
        take: query.perPage,
        include: { actor: { select: { username: true } } },
      }),
      this.prisma.auditLog.count({ where }),
    ]);

    return paginate(
      entries.map((entry) => ({
        uuid: entry.uuid,
        event: entry.event,
        description: describeEvent(entry.event, (entry.metadata ?? {}) as Record<string, unknown>),
        actor: entry.actor,
        ip: entry.ip,
        createdAt: entry.createdAt,
      })),
      total,
      query,
    );
  }
}
