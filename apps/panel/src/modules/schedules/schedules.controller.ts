import { PERMISSIONS } from '@hopper/shared';
import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Req,
} from '@nestjs/common';
import type { Prisma } from '../../prisma/client.js';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe.js';
import { AUDIT_EVENTS, AuditService } from '../audit/audit.service.js';
import { RequireServerPermission } from '../auth/decorators.js';
import {
  CurrentServer,
  CurrentUser,
  type AuthenticatedRequest,
  type RequestServer,
  type RequestUser,
} from '../auth/request-user.js';
import {
  createScheduleSchema,
  updateScheduleSchema,
  type CreateScheduleDto,
  type UpdateScheduleDto,
} from './schedules.dto.js';
import { SchedulesService } from './schedules.service.js';

/**
 * A server's scheduled tasks.
 *
 * Triggering one by hand requires the **update** permission and not the read
 * one: launching a sequence that restarts the server is not a look at it, even
 * if the schedule was left untouched.
 */
@Controller('api/servers/:serverId/schedules')
export class SchedulesController {
  constructor(
    private readonly schedules: SchedulesService,
    private readonly audit: AuditService,
  ) {}

  @Get()
  @RequireServerPermission(PERMISSIONS.SCHEDULE_READ)
  list(@Param('serverId') serverId: string) {
    return this.schedules.list(serverId);
  }

  @Get(':scheduleId')
  @RequireServerPermission(PERMISSIONS.SCHEDULE_READ)
  find(@Param('serverId') serverId: string, @Param('scheduleId') scheduleId: string) {
    return this.schedules.findByUuid(serverId, scheduleId);
  }

  @Post()
  @RequireServerPermission(PERMISSIONS.SCHEDULE_CREATE)
  async create(
    @Param('serverId') serverId: string,
    @Body(new ZodValidationPipe(createScheduleSchema)) body: CreateScheduleDto,
    @CurrentServer() server: RequestServer,
    @CurrentUser() user: RequestUser,
    @Req() request: AuthenticatedRequest,
  ) {
    const schedule = await this.schedules.create(serverId, body);

    await this.record(server, user, request, AUDIT_EVENTS.SCHEDULE_CREATED, {
      schedule: schedule.uuid,
      name: schedule.name,
      expression: schedule.expression,
    });

    return schedule;
  }

  @Patch(':scheduleId')
  @RequireServerPermission(PERMISSIONS.SCHEDULE_UPDATE)
  async update(
    @Param('serverId') serverId: string,
    @Param('scheduleId') scheduleId: string,
    @Body(new ZodValidationPipe(updateScheduleSchema)) body: UpdateScheduleDto,
    @CurrentServer() server: RequestServer,
    @CurrentUser() user: RequestUser,
    @Req() request: AuthenticatedRequest,
  ) {
    const schedule = await this.schedules.update(serverId, scheduleId, body);

    await this.record(server, user, request, AUDIT_EVENTS.SCHEDULE_UPDATED, {
      schedule: scheduleId,
      expression: schedule.expression,
      active: schedule.active,
    });

    return schedule;
  }

  @Post(':scheduleId/run')
  @HttpCode(HttpStatus.ACCEPTED)
  @RequireServerPermission(PERMISSIONS.SCHEDULE_UPDATE)
  async run(
    @Param('serverId') serverId: string,
    @Param('scheduleId') scheduleId: string,
    @CurrentServer() server: RequestServer,
    @CurrentUser() user: RequestUser,
    @Req() request: AuthenticatedRequest,
  ): Promise<void> {
    // Brings the due time forward: the scheduler will pick the task up on its
    // next pass. Running it here would hold the request open for the whole
    // sequence, offsets included — several minutes.
    await this.schedules.triggerNow(serverId, scheduleId);

    await this.record(server, user, request, AUDIT_EVENTS.SCHEDULE_UPDATED, {
      schedule: scheduleId,
      manualRun: true,
    });
  }

  @Delete(':scheduleId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequireServerPermission(PERMISSIONS.SCHEDULE_DELETE)
  async remove(
    @Param('serverId') serverId: string,
    @Param('scheduleId') scheduleId: string,
    @CurrentServer() server: RequestServer,
    @CurrentUser() user: RequestUser,
    @Req() request: AuthenticatedRequest,
  ): Promise<void> {
    await this.schedules.remove(serverId, scheduleId);

    await this.record(server, user, request, AUDIT_EVENTS.SCHEDULE_DELETED, {
      schedule: scheduleId,
    });
  }

  private async record(
    server: RequestServer,
    user: RequestUser,
    request: AuthenticatedRequest,
    event: (typeof AUDIT_EVENTS)[keyof typeof AUDIT_EVENTS],
    metadata: Prisma.InputJsonObject,
  ): Promise<void> {
    await this.audit.record({
      event,
      actorId: user.id,
      serverId: server.id,
      ip: request.ip,
      userAgent: request.headers['user-agent'],
      metadata,
    });
  }
}
