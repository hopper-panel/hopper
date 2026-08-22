import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Query,
  Req,
  Res,
} from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe.js';
import { ApplicationApi } from '../auth/decorators.js';
import {
  CurrentApplication,
  type AuthenticatedRequest,
  type RequestApplication,
} from '../auth/request-user.js';
import { IdempotencyService } from './idempotency.service.js';
import {
  changePlanSchema,
  provisionServerSchema,
  type ChangePlanDto,
  type ProvisionServerDto,
} from './provisioning.dto.js';
import { ProvisioningService } from './provisioning.service.js';

/** Longest `Idempotency-Key` accepted. A uuid is 36; this leaves room for prefixes. */
const MAX_IDEMPOTENCY_KEY = 128;

/**
 * Provisioning, as a billing system drives it.
 *
 * Five routes, and between them everything selling a Minecraft server requires:
 * deliver one, look at it, suspend it when an invoice goes unpaid, reinstate
 * it when it is settled, move it to another offer, delete it on cancellation.
 */
@Controller('api/application/servers')
@ApplicationApi('servers')
export class ApplicationServersController {
  constructor(
    private readonly provisioning: ProvisioningService,
    private readonly idempotency: IdempotencyService,
  ) {}

  @Get()
  list(@Query('owner') owner?: string, @Query('plan') plan?: string) {
    return this.provisioning.list({ ownerEmail: owner, plan });
  }

  @Get(':uuid')
  find(@Param('uuid') uuid: string) {
    return this.provisioning.find(uuid);
  }

  /**
   * Delivers a server.
   *
   * `Idempotency-Key` is **required**, which is unusual and deliberate. This is
   * the only route here that is not naturally repeatable — suspending twice is
   * a no-op, creating twice is two servers and two invoices — and the call most
   * likely to be repeated is the one that timed out, where the caller cannot
   * tell "it never arrived" from "it worked and the answer was lost". Making
   * the header optional would mean the safe default is the unsafe one, and the
   * integrations that skip it are exactly the ones that will retry.
   *
   * The answer to the first attempt is replayed for every repeat of it, with
   * `Idempotency-Replayed: true` so a caller can tell one from the other in a
   * log without diffing bodies.
   */
  @Post()
  @HttpCode(HttpStatus.CREATED)
  async provision(
    @Body(new ZodValidationPipe(provisionServerSchema)) body: ProvisionServerDto,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @CurrentApplication() application: RequestApplication,
    @Req() request: AuthenticatedRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    const key = (idempotencyKey ?? '').trim();

    if (key === '') {
      throw new BadRequestException(
        'An Idempotency-Key header is required to create a server. Use the order or subscription identifier that made this purchase.',
      );
    }

    if (key.length > MAX_IDEMPOTENCY_KEY) {
      throw new BadRequestException(
        `Idempotency-Key is limited to ${MAX_IDEMPOTENCY_KEY} characters.`,
      );
    }

    const claim = await this.idempotency.claim(application.id, key, body);

    if (claim.replayed) {
      reply.header('idempotency-replayed', 'true');
      reply.status(claim.status);
      return claim.body;
    }

    try {
      const { server, ownerCreated } = await this.provisioning.provision(
        body,
        { id: application.id, name: application.name },
        { ip: request.ip, userAgent: request.headers['user-agent'] },
      );

      /**
       * `ownerCreated` is here so an integration can tell a first purchase
       * from a returning customer without asking a second question — and know
       * that an invitation email is on its way, which is what its own welcome
       * message should avoid duplicating.
       */
      const answer = { ...server, ownerCreated };

      await this.idempotency.settle(application.id, key, HttpStatus.CREATED, answer);

      return answer;
    } catch (error: unknown) {
      // The key is released, not recorded with the failure. A provisioning
      // call that failed is the one most in need of being made again — the
      // node was in maintenance, the daemon was restarting — and a key
      // answering `500` for a day would turn a transient failure into an
      // unsellable order.
      await this.idempotency.release(application.id, key);
      throw error;
    }
  }

  @Post(':uuid/suspend')
  @HttpCode(HttpStatus.OK)
  suspend(
    @Param('uuid') uuid: string,
    @CurrentApplication() application: RequestApplication,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.provisioning.setSuspended(uuid, true, application, contextOf(request));
  }

  @Post(':uuid/unsuspend')
  @HttpCode(HttpStatus.OK)
  unsuspend(
    @Param('uuid') uuid: string,
    @CurrentApplication() application: RequestApplication,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.provisioning.setSuspended(uuid, false, application, contextOf(request));
  }

  @Patch(':uuid/plan')
  changePlan(
    @Param('uuid') uuid: string,
    @Body(new ZodValidationPipe(changePlanSchema)) body: ChangePlanDto,
    @CurrentApplication() application: RequestApplication,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.provisioning.changePlan(uuid, body, application, contextOf(request));
  }

  @Delete(':uuid')
  @HttpCode(HttpStatus.NO_CONTENT)
  remove(
    @Param('uuid') uuid: string,
    @CurrentApplication() application: RequestApplication,
    @Req() request: AuthenticatedRequest,
  ): Promise<void> {
    return this.provisioning.remove(uuid, application, contextOf(request));
  }
}

function contextOf(request: AuthenticatedRequest): { ip: string; userAgent?: string } {
  return { ip: request.ip, userAgent: request.headers['user-agent'] };
}
