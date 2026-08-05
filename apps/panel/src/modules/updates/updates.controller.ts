import {
  ConflictException,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Post,
  Query,
} from '@nestjs/common';
import { AUDIT_EVENTS, AuditService } from '../audit/audit.service.js';
import { AdminOnly } from '../auth/decorators.js';
import { CurrentUser, type RequestUser } from '../auth/request-user.js';
import { UpdatesService, type UpdateCheck, type UpdateStatus } from './updates.service.js';

/**
 * Panel updates, for the administration.
 *
 * Applying one is deliberately a request rather than an action: the panel hands
 * it to a root-owned unit and reports what that unit says. See `UpdatesService`
 * for why it cannot do the work itself.
 */
@Controller('api/admin/updates')
@AdminOnly()
export class UpdatesController {
  constructor(
    private readonly updates: UpdatesService,
    private readonly audit: AuditService,
  ) {}

  @Get()
  check(@Query('refresh') refresh?: string): Promise<UpdateCheck> {
    return this.updates.check(refresh === 'true');
  }

  @Get('status')
  status(): Promise<UpdateStatus> {
    return this.updates.status();
  }

  @Post('apply')
  @HttpCode(HttpStatus.ACCEPTED)
  async apply(@CurrentUser() user: RequestUser): Promise<{ accepted: true }> {
    const status = await this.updates.status();

    if (!status.supported) {
      // Said plainly, with the command to run: an installation made before the
      // updater existed is the common case, and "not supported" alone would
      // leave an operator with nowhere to go.
      throw new ConflictException(
        `This installation has no system updater. Run it by hand: ${this.updates.manualCommand()}`,
      );
    }

    if (status.state === 'requested' || status.state === 'running') {
      throw new ConflictException('An update is already under way.');
    }

    // Recorded before it starts: the panel restarts in the middle, and an entry
    // written afterwards would never be written at all.
    await this.audit.record({
      actorId: user.id,
      event: AUDIT_EVENTS.PANEL_UPDATE_REQUESTED,
      metadata: { version: (await this.updates.check()).version },
    });

    await this.updates.requestUpdate();

    return { accepted: true };
  }
}
