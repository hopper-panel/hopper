import { EggImportError, importPterodactylEgg, type PterodactylEggExport } from '@hopper/templates';
import {
  BadRequestException,
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
import { z } from 'zod';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe.js';
import type { RequestContext } from '../auth/auth.service.js';
import { AdminOnly } from '../auth/decorators.js';
import { CurrentUser, type AuthenticatedRequest, type RequestUser } from '../auth/request-user.js';
import {
  TemplateEditorService,
  type TemplateDetailView,
  type TemplateGroupView,
} from './template-editor.service.js';
import { TemplateSyncService, type SyncOutcome } from './template-sync.service.js';
import {
  createTemplateGroupSchema,
  createTemplateSchema,
  updateTemplateGroupSchema,
  updateTemplateSchema,
  type CreateTemplateDto,
  type CreateTemplateGroupDto,
  type UpdateTemplateDto,
  type UpdateTemplateGroupDto,
} from './templates.dto.js';
import { TemplatesService, type TemplateView } from './templates.service.js';

const importEggSchema = z.object({
  /** Contents of the egg file, as is. */
  egg: z.unknown(),
  /** Group it lands in. Created if it does not exist. */
  group: z.string().min(1).max(100),
});

type ImportEggDto = z.infer<typeof importEggSchema>;

/**
 * Administrators only: they alone create servers for now. When users can create
 * their own, this list will have to be filtered by what they are allowed —
 * hence the separate controller rather than an open route somebody would forget
 * to restrict.
 */
@Controller('api/admin/templates')
@AdminOnly()
export class TemplatesController {
  constructor(
    private readonly templates: TemplatesService,
    private readonly editor: TemplateEditorService,
    private readonly sync: TemplateSyncService,
  ) {}

  // The group routes are declared before the `:uuid` ones on purpose: `groups`
  // is a literal segment that would otherwise be a plausible template uuid, and
  // route precedence is not something to leave to the router's tie-breaking.

  @Get('groups')
  listGroups() {
    return this.templates.listGroups();
  }

  @Post('groups')
  @HttpCode(HttpStatus.CREATED)
  createGroup(
    @Body(new ZodValidationPipe(createTemplateGroupSchema)) body: CreateTemplateGroupDto,
    @CurrentUser() actor: RequestUser,
    @Req() request: AuthenticatedRequest,
  ): Promise<TemplateGroupView> {
    return this.editor.createGroup(body, actor.id, contextOf(request));
  }

  @Patch('groups/:uuid')
  updateGroup(
    @Param('uuid') uuid: string,
    @Body(new ZodValidationPipe(updateTemplateGroupSchema)) body: UpdateTemplateGroupDto,
    @CurrentUser() actor: RequestUser,
    @Req() request: AuthenticatedRequest,
  ): Promise<TemplateGroupView> {
    return this.editor.updateGroup(uuid, body, actor.id, contextOf(request));
  }

  @Delete('groups/:uuid')
  @HttpCode(HttpStatus.NO_CONTENT)
  removeGroup(
    @Param('uuid') uuid: string,
    @CurrentUser() actor: RequestUser,
    @Req() request: AuthenticatedRequest,
  ): Promise<void> {
    return this.editor.removeGroup(uuid, actor.id, contextOf(request));
  }

  @Get()
  list(): Promise<TemplateView[]> {
    return this.templates.list();
  }

  @Get(':uuid')
  find(@Param('uuid') uuid: string): Promise<TemplateView> {
    return this.templates.findByUuid(uuid);
  }

  /**
   * The same template, as its author edits it.
   *
   * A route of its own rather than a wider `GET :uuid`, because the read view
   * above feeds the create-server page: it hides the variables an operator
   * picking a template has no business changing, and every install and stop
   * column with them. Widening it would have published the install script to
   * that page to save one endpoint here.
   */
  @Get(':uuid/detail')
  findDetail(@Param('uuid') uuid: string): Promise<TemplateDetailView> {
    return this.editor.findDetailByUuid(uuid);
  }

  /**
   * The template as a Pterodactyl egg, for moving it somewhere else.
   *
   * Plain JSON rather than a `Content-Disposition` attachment, and the browser
   * makes the file. A download served by this route would have to be reached by
   * a link rather than by the panel's HTTP client, and that client is what
   * silently renews an expired access token: the operator whose token had just
   * lapsed would download a file containing a 401.
   */
  @Get(':uuid/export')
  exportEgg(@Param('uuid') uuid: string): Promise<PterodactylEggExport> {
    return this.editor.exportEgg(uuid);
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  create(
    @Body(new ZodValidationPipe(createTemplateSchema)) body: CreateTemplateDto,
    @CurrentUser() actor: RequestUser,
    @Req() request: AuthenticatedRequest,
  ): Promise<TemplateDetailView> {
    return this.editor.create(body, actor.id, contextOf(request));
  }

  @Patch(':uuid')
  update(
    @Param('uuid') uuid: string,
    @Body(new ZodValidationPipe(updateTemplateSchema)) body: UpdateTemplateDto,
    @CurrentUser() actor: RequestUser,
    @Req() request: AuthenticatedRequest,
  ): Promise<TemplateDetailView> {
    return this.editor.update(uuid, body, actor.id, contextOf(request));
  }

  @Delete(':uuid')
  @HttpCode(HttpStatus.NO_CONTENT)
  remove(
    @Param('uuid') uuid: string,
    @CurrentUser() actor: RequestUser,
    @Req() request: AuthenticatedRequest,
  ): Promise<void> {
    return this.editor.remove(uuid, actor.id, contextOf(request));
  }

  /**
   * Reinstalls the catalogue shipped with Hopper.
   *
   * Useful after a panel update. Templates edited from the interface are kept
   * as they are.
   */
  @Post('sync')
  @HttpCode(HttpStatus.OK)
  syncCatalog(): Promise<SyncOutcome> {
    return this.sync.syncCatalog();
  }

  /**
   * Imports a Pterodactyl egg.
   *
   * Opens access to the hundreds of eggs maintained by the community, for games
   * and modpacks Hopper will never ship itself. The points needing a
   * read-through are returned with the result rather than discovered on the
   * first start.
   */
  @Post('import')
  @HttpCode(HttpStatus.CREATED)
  async importEgg(
    @Body(new ZodValidationPipe(importEggSchema)) body: ImportEggDto,
  ): Promise<{ template: TemplateView; warnings: string[] }> {
    try {
      const { template, warnings } = importPterodactylEgg(body.egg, { group: body.group });

      await this.sync.upsert(template);

      return { template: await this.templates.findByKey(template.key), warnings };
    } catch (error: unknown) {
      if (error instanceof EggImportError) {
        // The detail of the format problems is returned: without it, the
        // administrator has no way of knowing what to fix.
        throw new BadRequestException({ message: error.message, issues: error.issues });
      }

      throw error;
    }
  }
}

function contextOf(request: AuthenticatedRequest): RequestContext {
  return { ip: request.ip, userAgent: request.headers['user-agent'] };
}
