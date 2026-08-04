import {
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import {
  paginationQuerySchema,
  type Paginated,
  type PaginationQuery,
} from '../../common/pagination.js';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe.js';
import type { RequestContext } from '../auth/auth.service.js';
import { AdminOnly } from '../auth/decorators.js';
import { CurrentUser, type AuthenticatedRequest, type RequestUser } from '../auth/request-user.js';
import {
  createUserSchema,
  updateUserSchema,
  type CreateUserDto,
  type UpdateUserDto,
} from './users.dto.js';
import { UsersService, type UserView } from './users.service.js';

@Controller('api/admin/users')
@AdminOnly()
export class UsersController {
  constructor(private readonly users: UsersService) {}

  @Get()
  list(
    @Query(new ZodValidationPipe(paginationQuerySchema)) query: PaginationQuery,
  ): Promise<Paginated<UserView>> {
    return this.users.list(query);
  }

  @Get(':uuid')
  find(@Param('uuid') uuid: string): Promise<UserView> {
    return this.users.findByUuid(uuid);
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  create(
    @Body(new ZodValidationPipe(createUserSchema)) body: CreateUserDto,
    @CurrentUser() actor: RequestUser,
    @Req() request: AuthenticatedRequest,
  ): Promise<UserView> {
    return this.users.create(body, actor.id, contextOf(request));
  }

  @Patch(':uuid')
  update(
    @Param('uuid') uuid: string,
    @Body(new ZodValidationPipe(updateUserSchema)) body: UpdateUserDto,
    @CurrentUser() actor: RequestUser,
    @Req() request: AuthenticatedRequest,
  ): Promise<UserView> {
    // Un administrateur qui se retire lui-même son propre rôle perdrait l'accès
    // au milieu de son action. La rétrogradation passe par un autre compte.
    if (uuid === actor.uuid && (body.role === 'USER' || body.suspended === true)) {
      throw new ForbiddenException(
        'Vous ne pouvez pas retirer vos propres droits ni vous suspendre vous-même.',
      );
    }

    return this.users.update(uuid, body, actor.id, contextOf(request));
  }

  @Delete(':uuid')
  @HttpCode(HttpStatus.NO_CONTENT)
  remove(
    @Param('uuid') uuid: string,
    @CurrentUser() actor: RequestUser,
    @Req() request: AuthenticatedRequest,
  ): Promise<void> {
    if (uuid === actor.uuid) {
      throw new ForbiddenException('Vous ne pouvez pas supprimer votre propre compte.');
    }

    return this.users.remove(uuid, actor.id, contextOf(request));
  }
}

function contextOf(request: AuthenticatedRequest): RequestContext {
  return { ip: request.ip, userAgent: request.headers['user-agent'] };
}
