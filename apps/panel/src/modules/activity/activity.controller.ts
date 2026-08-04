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
  /** Null pour une action du système : planificateur, daemon. */
  actor: { username: string } | null;
  ip: string | null;
  createdAt: Date;
}

/**
 * Journal d'activité d'un serveur.
 *
 * Le journal d'audit existe depuis la phase 1 et se remplissait déjà à chaque
 * action ; il n'était simplement lisible nulle part. Cet onglet ne fait que
 * l'exposer, filtré sur le serveur consulté.
 *
 * L'adresse IP y figure : c'est ce qui rend le journal utile après coup — savoir
 * *que* quelqu'un a supprimé un monde sert moins que de savoir d'où. Le
 * `userAgent`, lui, est enregistré mais non rendu : il n'apprend rien à qui
 * lit, et allonge chaque ligne.
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
      throw new NotFoundException('Serveur introuvable.');
    }

    const where = { serverId: server.id };

    const [entries, total] = await Promise.all([
      this.prisma.auditLog.findMany({
        where,
        // Le plus récent d'abord : on consulte un journal pour savoir ce qui
        // vient de se passer, pas ce qui s'est passé à la création.
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
