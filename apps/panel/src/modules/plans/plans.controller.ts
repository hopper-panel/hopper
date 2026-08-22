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
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe.js';
import { AUDIT_EVENTS, AuditService } from '../audit/audit.service.js';
import { AdminOnly } from '../auth/decorators.js';
import { CurrentUser, type AuthenticatedRequest, type RequestUser } from '../auth/request-user.js';
import {
  createPlanSchema,
  updatePlanSchema,
  type CreatePlanDto,
  type UpdatePlanDto,
} from './plans.dto.js';
import { PlansService } from './plans.service.js';

/**
 * Offers, from the administration.
 *
 * Written here and read by the application API. That asymmetry is the design:
 * the person who decides what is sold edits it in one place, and the billing
 * system quotes a name. A billing system able to *create* offers would put the
 * catalogue back in two products at once, which is the problem plans exist to
 * remove.
 */
@Controller('api/admin/plans')
@AdminOnly()
export class PlansController {
  constructor(
    private readonly plans: PlansService,
    private readonly audit: AuditService,
  ) {}

  @Get()
  list() {
    return this.plans.list({ includeInactive: true });
  }

  /**
   * Where a server on this plan would go right now, and what stopped each node
   * that was passed over.
   *
   * Under the administration as well as the application API because the two
   * readers are different: an integrator asks before selling, an operator asks
   * while wondering why a sale failed at three in the morning.
   */
  @Get(':slug/placement')
  placement(@Param('slug') slug: string) {
    return this.plans.placementFor(slug);
  }

  @Post()
  async create(
    @Body(new ZodValidationPipe(createPlanSchema)) body: CreatePlanDto,
    @CurrentUser() user: RequestUser,
    @Req() request: AuthenticatedRequest,
  ) {
    const plan = await this.plans.create(body);

    await this.audit.record({
      event: AUDIT_EVENTS.PLAN_CREATED,
      actorId: user.id,
      ip: request.ip,
      userAgent: request.headers['user-agent'],
      metadata: { uuid: plan.uuid, slug: plan.slug, name: plan.name },
    });

    return plan;
  }

  @Patch(':uuid')
  async update(
    @Param('uuid') uuid: string,
    @Body(new ZodValidationPipe(updatePlanSchema)) body: UpdatePlanDto,
    @CurrentUser() user: RequestUser,
    @Req() request: AuthenticatedRequest,
  ) {
    const plan = await this.plans.update(uuid, body);

    await this.audit.record({
      event: AUDIT_EVENTS.PLAN_UPDATED,
      actorId: user.id,
      ip: request.ip,
      userAgent: request.headers['user-agent'],
      // Which fields moved, not their values: an offer has a dozen numbers and
      // an entry naming all of them is one nobody reads.
      metadata: { uuid: plan.uuid, slug: plan.slug, fields: Object.keys(body) },
    });

    return plan;
  }

  @Delete(':uuid')
  @HttpCode(HttpStatus.NO_CONTENT)
  async remove(
    @Param('uuid') uuid: string,
    @CurrentUser() user: RequestUser,
    @Req() request: AuthenticatedRequest,
  ): Promise<void> {
    await this.plans.remove(uuid);

    await this.audit.record({
      event: AUDIT_EVENTS.PLAN_DELETED,
      actorId: user.id,
      ip: request.ip,
      userAgent: request.headers['user-agent'],
      metadata: { uuid },
    });
  }
}
