import { PERMISSIONS } from '@hopper/shared';
import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseIntPipe,
  Patch,
  Post,
} from '@nestjs/common';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe.js';
import { RequireServerPermission } from '../auth/decorators.js';
import { AllocationsService } from './allocations.service.js';
import { updateAllocationSchema, type UpdateAllocationDto } from './allocations.dto.js';

/**
 * Ports d'un serveur.
 *
 * Désigner le port principal relève de `allocation.update` et non de
 * `allocation.create` : c'est une modification de ce que le serveur expose
 * déjà, pas l'ouverture d'un port de plus sur la machine.
 */
@Controller('api/servers/:serverId/allocations')
export class AllocationsController {
  constructor(private readonly allocations: AllocationsService) {}

  @Get()
  @RequireServerPermission(PERMISSIONS.ALLOCATION_READ)
  list(@Param('serverId') serverId: string) {
    return this.allocations.list(serverId);
  }

  @Post()
  @RequireServerPermission(PERMISSIONS.ALLOCATION_CREATE)
  add(@Param('serverId') serverId: string) {
    return this.allocations.add(serverId);
  }

  @Patch(':allocationId')
  @RequireServerPermission(PERMISSIONS.ALLOCATION_UPDATE)
  update(
    @Param('serverId') serverId: string,
    @Param('allocationId', ParseIntPipe) allocationId: number,
    @Body(new ZodValidationPipe(updateAllocationSchema)) body: UpdateAllocationDto,
  ) {
    return this.allocations.setAlias(serverId, allocationId, body.alias);
  }

  @Post(':allocationId/primary')
  @RequireServerPermission(PERMISSIONS.ALLOCATION_UPDATE)
  setPrimary(
    @Param('serverId') serverId: string,
    @Param('allocationId', ParseIntPipe) allocationId: number,
  ) {
    return this.allocations.setPrimary(serverId, allocationId);
  }

  @Delete(':allocationId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequireServerPermission(PERMISSIONS.ALLOCATION_DELETE)
  remove(
    @Param('serverId') serverId: string,
    @Param('allocationId', ParseIntPipe) allocationId: number,
  ): Promise<void> {
    return this.allocations.remove(serverId, allocationId);
  }
}
