import {
  configFileSchema,
  stopConfigurationSchema,
  type ConfigFile,
  type Readiness,
  type StopConfiguration,
} from '@hopper/shared';
import { TEMPLATE_CATALOG, catalogGroups, type TemplateDefinition } from '@hopper/templates';
import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service.js';
import { AUDIT_EVENTS, AuditService } from '../audit/audit.service.js';
import type { RequestContext } from '../auth/auth.service.js';
import { NodeClientService } from '../nodes/node-client.service.js';
import { NodesService } from '../nodes/nodes.service.js';
import {
  assertRconStopReachesEveryServer,
  assertStopTransportHonouredEverywhere,
  declaresRconStop,
  rconStopTarget,
} from '../servers/stop-transport.js';
import { templateColumns, templateVariableColumns } from './template-sync.service.js';
import {
  parseImageOptions,
  parseReadiness,
  type DockerImageOption,
  type TemplateVariableView,
} from './templates.service.js';
import type {
  CreateTemplateDto,
  CreateTemplateGroupDto,
  UpdateTemplateDto,
  UpdateTemplateGroupDto,
} from './templates.dto.js';

/**
 * Keys the shipped catalogue owns, and group names it owns.
 *
 * Read once: `TEMPLATE_CATALOG` is a frozen list validated when the module
 * loads, so nothing about it changes while the panel runs.
 */
const CATALOGUE_KEYS = new Set(TEMPLATE_CATALOG.map((template) => template.key));
const CATALOGUE_GROUPS = new Set(catalogGroups());

/**
 * A variable as its author edits it.
 *
 * `TemplateVariableView` minus nothing and plus `userViewable`, which the read
 * view has no field for because it uses it as a filter. An author has to see
 * the variables the filter hides: an internal build flag is still a variable
 * whose default value decides what the server runs, and until it appeared here
 * the only way to change one was through SQL.
 */
export interface TemplateVariableDetail extends TemplateVariableView {
  userViewable: boolean;
}

/**
 * Everything a template is, for the one page allowed to change it.
 *
 * Separate from `TemplateView` rather than an extension of it, because the two
 * answer different questions and the read view's answer is deliberately
 * partial: it hides non-viewable variables and omits every column an operator
 * running a server has no business seeing. Widening it would have quietly put
 * the install script and the file denylist on the create-server dropdown.
 */
export interface TemplateDetailView {
  uuid: string;
  key: string;
  group: { uuid: string; name: string };
  name: string;
  description: string;
  author: string;
  /** True once this template has been edited here; catalogue syncs then skip it. */
  modifiedByAdmin: boolean;

  dockerImages: DockerImageOption[];
  startup: string;

  stopCommand: string;
  stop: StopConfiguration | null;
  stopTimeoutSeconds: number | null;
  startupDetection: string | null;
  readiness: Readiness | null;

  configFiles: ConfigFile[];
  fileDenylist: string[];

  installContainer: string;
  installEntrypoint: string;
  installScript: string;
  installInactivityTimeoutMs: number | null;
  /**
   * A `number`, where the column is a `BigInt`.
   *
   * `JSON.stringify` refuses a bigint outright, so the value cannot cross to a
   * browser as one. `main.ts` patches `BigInt.prototype.toJSON` to convert it,
   * which keeps every response working — but it would leave this field typed
   * `bigint` while the wire carries a number, and the editor posts the value
   * straight back to a schema that accepts a number. Converted here instead, so
   * the declared type and the JSON agree and the round trip is exact: the field
   * is a disk size, and a disk size stays far below 2^53.
   */
  installRequiredDiskBytes: number | null;

  importedFromEgg: string | null;
  /** How many servers this template cannot be deleted out from under. */
  serverCount: number;
  variables: TemplateVariableDetail[];

  createdAt: Date;
  updatedAt: Date;
}

export interface TemplateGroupView {
  uuid: string;
  name: string;
  description: string;
  author: string;
  templateCount: number;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * The row shape both the detail view and the merge below work from. Spelled
 * out rather than taken from Prisma so the JSON columns arrive as `unknown`,
 * which is what they are.
 */
interface TemplateRow {
  id: number;
  uuid: string;
  key: string;
  groupId: number;
  group: { uuid: string; name: string };
  name: string;
  description: string;
  author: string;
  modifiedByAdmin: boolean;
  dockerImages: unknown;
  startup: string;
  stopCommand: string;
  stop: unknown;
  stopTimeoutSeconds: number | null;
  startupDetection: string | null;
  readiness: unknown;
  configFiles: unknown;
  fileDenylist: string[];
  installContainer: string;
  installEntrypoint: string;
  installScript: string;
  installInactivityTimeoutMs: number | null;
  installRequiredDiskBytes: bigint | null;
  importedFromEgg: string | null;
  createdAt: Date;
  updatedAt: Date;
  variables: {
    name: string;
    description: string;
    envVariable: string;
    defaultValue: string;
    userViewable: boolean;
    userEditable: boolean;
    rules: string;
  }[];
  _count: { servers: number };
}

/**
 * Writing server templates.
 *
 * A service of its own beside `TemplatesService`, which says of itself that it
 * is deliberately read-only and is injected into the paths that create servers.
 * Keeping the two apart keeps that true: nothing on a server-creation path can
 * reach a method that writes a template, and the detail view an author edits
 * cannot be handed out by accident where the read view was meant.
 *
 * Every write here sets `modifiedByAdmin`. That is not bookkeeping — it is the
 * flag `TemplateSyncService.upsert` skips a template on, and a write that
 * forgot it would have the next "Resynchronise" overwrite the administrator's
 * work, variables included, since the sync deletes and recreates every variable
 * row.
 */
@Injectable()
export class TemplateEditorService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly nodes: NodesService,
    private readonly client: NodeClientService,
  ) {}

  async findDetailByUuid(uuid: string): Promise<TemplateDetailView> {
    return toDetailView(await this.requireTemplate(uuid));
  }

  async create(
    dto: CreateTemplateDto,
    actorId: number,
    context: RequestContext,
  ): Promise<TemplateDetailView> {
    // Every refusal before `resolveGroup`, which creates a group: a request
    // that is going to be refused must not leave an empty one behind it. The
    // two that need no query go first, for the same reason in miniature.
    assertVariableNamesAreDistinct(dto.variables);
    this.assertKeyMayBeTaken(dto.key);
    await this.assertKeyFree(dto.key);
    await this.assertNameFreeInGroup(dto.group, dto.name);

    const group = await this.resolveGroup(dto.group);

    const created = await this.prisma.template.create({
      data: {
        ...templateColumns({ ...dto, importedFromEgg: undefined }, group.id),
        key: dto.key,
        modifiedByAdmin: true,
        variables: {
          create: dto.variables.map((variable, index) => templateVariableColumns(variable, index)),
        },
      },
      select: { id: true, uuid: true },
    });

    await this.audit.record({
      event: AUDIT_EVENTS.TEMPLATE_CREATED,
      actorId,
      ip: context.ip,
      userAgent: context.userAgent,
      metadata: { templateUuid: created.uuid, key: dto.key, name: dto.name, group: group.name },
    });

    return this.findDetailByUuid(created.uuid);
  }

  /**
   * Rewrites a template, and with it half of every server already built from
   * it.
   *
   * Which half is the thing to know before touching this method, and it is
   * written nowhere else: a server carries **copies** of some template columns
   * and reads the rest **live**, on every configuration build.
   *
   *  - `startup` and `dockerImages` are frozen at creation. `Server` holds its
   *    own `startupCommand` and `dockerImage`, copied by `ServersService` when
   *    the server was made, and nothing here touches them. Editing either
   *    changes what the *next* server runs and nothing whatsoever about the
   *    ones running now — which is deliberate: the alternative is swapping the
   *    binary under a live server because somebody fixed a typo on a template
   *    page. The route to an existing server is its own Startup tab, one server
   *    at a time.
   *  - `stop`, `stopCommand`, `stopTimeoutSeconds`, `startupDetection`,
   *    `readiness`, `configFiles`, `fileDenylist` and the whole install block
   *    are read live: `ServerConfigurationService.build` takes them off
   *    `server.template` every time it runs, so this write reaches every
   *    existing server the moment its daemon next fetches. Both stop gates
   *    below exist because of that line, and so does the strictness about
   *    `configFiles` — a single entry the contract cannot read fails the whole
   *    configuration, and `buildForNode` then drops that server from its node's
   *    page altogether.
   *  - variables are neither one nor the other until this method decides, which
   *    is what the backfill in the transaction below is about.
   *
   * The live consequence that lands nowhere near the field that caused it:
   * adding a `{{server.allocations.<role>.port}}` token to `configFiles` — or
   * naming a `role` on `stop` or `readiness` — makes every existing server on
   * this template **untransferable**. `declaredPortRoles` collects those names
   * and `TransferService` refuses the move outright, because a transfer hands
   * the server one unnamed port on the target and cannot carry a name across.
   * Not refused here, and not warned about: the token is usually exactly what
   * the author meant, and the servers go on working precisely as they are.
   */
  async update(
    uuid: string,
    dto: UpdateTemplateDto,
    actorId: number,
    context: RequestContext,
  ): Promise<TemplateDetailView> {
    const existing = await this.requireTemplate(uuid);

    assertVariableNamesAreDistinct(dto.variables);

    const key = dto.key ?? existing.key;

    if (key !== existing.key) {
      this.assertKeyMayBeReleased(existing.key);
      this.assertKeyMayBeTaken(key);
      await this.assertKeyFree(key);
    }

    const groupName = dto.group ?? existing.group.name;
    const name = dto.name ?? existing.name;

    if (groupName !== existing.group.name || name !== existing.name) {
      await this.assertNameFreeInGroup(groupName, name, existing.id);
    }

    const merged = mergedDefinition(existing, dto, key, groupName);

    // The servers first and the nodes second, because this order is the order
    // of the cost: the servers are one query, and every node is a token
    // decryption and a round trip.
    await this.assertStopReachesEveryServer(existing, dto, merged.stop);
    await this.assertStopReachesEveryNode(existing, merged.stop);

    // Last of all the reads, and after every refusal above, because it creates
    // a group when the name names none: a refused edit that had already made
    // one would leave an empty group nobody asked for.
    const groupId =
      groupName === existing.group.name
        ? existing.groupId
        : (await this.resolveGroup(groupName)).id;

    await this.prisma.$transaction(async (tx) => {
      await tx.template.update({
        where: { id: existing.id },
        data: { ...templateColumns(merged, groupId), key, modifiedByAdmin: true },
      });

      const variables = dto.variables;

      if (variables === undefined) {
        return;
      }

      // Replaced as one ordered list rather than row by row. A
      // `TemplateVariable` has no uuid and its ids are recreated by every
      // catalogue sync, so there is no identifier an editor could address a
      // single variable by that would still mean the same variable an hour
      // later. `sort` comes from the position in the array sent.
      await tx.templateVariable.deleteMany({ where: { templateId: existing.id } });
      await tx.templateVariable.createMany({
        data: variables.map((variable, index) => ({
          ...templateVariableColumns(variable, index),
          templateId: existing.id,
        })),
      });

      // A variable added to a template reaches no existing server on its own.
      // `ServerConfigurationService` builds the container's environment from
      // `ServerVariable` rows and nothing else, and a server created before the
      // variable existed has no row — nor can it get one afterwards, because
      // `StartupService.applyVariables` refuses a write to any variable that is
      // not both `userEditable` and `userViewable`, which is every secret this
      // codebase declares. Meanwhile the Startup tab renders
      // `byEnv.get(env) ?? variable.defaultValue`, so the panel shows a value
      // the container has never heard of. Adding `RCON_PASSWORD` and pointing a
      // stop at it — the obvious companion to the gate above — had no route to
      // a working server at all.
      //
      // So the rows are written here, and `skipDuplicates` is what makes it a
      // backfill rather than a reset: a server that already holds a value keeps
      // it, only the missing rows are created, and they are created with the
      // template's own default — the figure the panel was already displaying.
      // One statement, and the display becomes true.
      //
      // **A removed variable is not treated as the mirror of this, and its rows
      // are deliberately left behind.** The environment is those rows, so a
      // removed variable goes on reaching the container for ever, which is the
      // wrong answer in the one case that matters: removing a leaked secret
      // from the template does not remove it from a single server. Deleting
      // them is still worse. This list is replaced whole by every PATCH that
      // carries `variables`, so one mis-sent list would erase every server's
      // individually set licence key, seed and password at once, with no undo
      // anywhere in the product — and those values are per-server data the
      // template never owned. Rotating the exposed secret is the repair; the
      // audit entry below names what was dropped so that there is a record
      // saying which servers are still carrying it.
      const servers = await tx.server.findMany({
        where: { templateId: existing.id },
        select: { id: true },
      });

      if (servers.length === 0 || variables.length === 0) {
        return;
      }

      await tx.serverVariable.createMany({
        data: servers.flatMap((server) =>
          variables.map((variable) => ({
            serverId: server.id,
            envVariable: variable.envVariable,
            value: variable.defaultValue,
          })),
        ),
        skipDuplicates: true,
      });
    });

    const dropped = droppedVariables(existing, dto);

    await this.audit.record({
      event: AUDIT_EVENTS.TEMPLATE_UPDATED,
      actorId,
      ip: context.ip,
      userAgent: context.userAgent,
      metadata: {
        templateUuid: uuid,
        key,
        changed: Object.keys(dto),
        // Only when there is something to say, so that the ordinary edit's
        // entry stays the shape it has always been. This one is worth an entry
        // of its own: the `ServerVariable` rows outlive the template variable,
        // and this is the only place that will ever say which names they are.
        ...(dropped.length > 0 ? { variablesDropped: dropped } : {}),
      },
    });

    return this.findDetailByUuid(uuid);
  }

  async remove(uuid: string, actorId: number, context: RequestContext): Promise<void> {
    const template = await this.prisma.template.findUnique({
      where: { uuid },
      select: { id: true, key: true, name: true, _count: { select: { servers: true } } },
    });

    if (!template) {
      throw new NotFoundException('Template not found.');
    }

    // Counted rather than attempted. `Server.templateId` is `onDelete:
    // Restrict`, so the delete would raise a P2003 the operator reads as
    // "Internal server error" — and the thing they need to be told is how many
    // servers are in the way, which the constraint does not say.
    if (template._count.servers > 0) {
      throw new ConflictException(
        `${template._count.servers} server(s) were built from this template. Delete or move them first: they read their startup command, their stop and their install script from it.`,
      );
    }

    await this.prisma.template.delete({ where: { id: template.id } });

    await this.audit.record({
      event: AUDIT_EVENTS.TEMPLATE_DELETED,
      actorId,
      ip: context.ip,
      userAgent: context.userAgent,
      metadata: { templateUuid: uuid, key: template.key, name: template.name },
    });
  }

  // -------------------------------------------------------------------------
  // Groups
  // -------------------------------------------------------------------------

  async createGroup(
    dto: CreateTemplateGroupDto,
    actorId: number,
    context: RequestContext,
  ): Promise<TemplateGroupView> {
    await this.assertGroupNameFree(dto.name);

    const group = await this.prisma.templateGroup.create({
      data: { name: dto.name, description: dto.description, author: dto.author },
      include: { _count: { select: { templates: true } } },
    });

    await this.audit.record({
      event: AUDIT_EVENTS.TEMPLATE_GROUP_CREATED,
      actorId,
      ip: context.ip,
      userAgent: context.userAgent,
      metadata: { groupUuid: group.uuid, name: group.name },
    });

    return toGroupView(group);
  }

  async updateGroup(
    uuid: string,
    dto: UpdateTemplateGroupDto,
    actorId: number,
    context: RequestContext,
  ): Promise<TemplateGroupView> {
    const existing = await this.prisma.templateGroup.findUnique({ where: { uuid } });

    if (!existing) {
      throw new NotFoundException('Template group not found.');
    }

    if (dto.name !== undefined && dto.name !== existing.name) {
      // A group's name is its upsert key for the shipped catalogue, exactly as
      // a template's `key` is. Renaming one the catalogue owns does not rename
      // anything on the next resynchronisation: it recreates the group under
      // the old name and pulls every unedited template back into it, leaving
      // the renamed group holding whichever templates happen to have been
      // edited. The operator ends up with two groups where they asked for one,
      // and no message anywhere saying why.
      if (CATALOGUE_GROUPS.has(existing.name)) {
        throw new ConflictException(
          `"${existing.name}" is a group the bundled catalogue installs into, so renaming it would only split it: the next resynchronisation recreates it under this name and moves the untouched templates back. Create the group you want and move the templates into it instead.`,
        );
      }

      await this.assertGroupNameFree(dto.name);
    }

    const group = await this.prisma.templateGroup.update({
      where: { id: existing.id },
      data: { name: dto.name, description: dto.description, author: dto.author },
      include: { _count: { select: { templates: true } } },
    });

    await this.audit.record({
      event: AUDIT_EVENTS.TEMPLATE_GROUP_UPDATED,
      actorId,
      ip: context.ip,
      userAgent: context.userAgent,
      metadata: { groupUuid: uuid, changed: Object.keys(dto) },
    });

    return toGroupView(group);
  }

  async removeGroup(uuid: string, actorId: number, context: RequestContext): Promise<void> {
    const group = await this.prisma.templateGroup.findUnique({
      where: { uuid },
      include: { _count: { select: { templates: true } } },
    });

    if (!group) {
      throw new NotFoundException('Template group not found.');
    }

    // `Template.groupId` is `onDelete: Restrict` too, and the same reasoning as
    // for a template's servers applies: a P2003 says nothing an operator can
    // act on, and what they need is the number of templates to move first.
    if (group._count.templates > 0) {
      throw new ConflictException(
        `This group still holds ${group._count.templates} template(s). Move them to another group first.`,
      );
    }

    await this.prisma.templateGroup.delete({ where: { id: group.id } });

    await this.audit.record({
      event: AUDIT_EVENTS.TEMPLATE_GROUP_DELETED,
      actorId,
      ip: context.ip,
      userAgent: context.userAgent,
      metadata: { groupUuid: uuid, name: group.name },
    });
  }

  // -------------------------------------------------------------------------

  private async requireTemplate(uuid: string): Promise<TemplateRow> {
    const template = await this.prisma.template.findUnique({
      where: { uuid },
      include: {
        group: { select: { uuid: true, name: true } },
        // Ties fall back to `id`, which is what orders the variables of every
        // template written before `sort` existed: they all sit at 0, and their
        // insertion order is the order their author wrote them in.
        variables: { orderBy: [{ sort: 'asc' }, { id: 'asc' }] },
        _count: { select: { servers: true } },
      },
    });

    if (!template) {
      throw new NotFoundException('Template not found.');
    }

    return template;
  }

  /**
   * Refuses an edit whose RCON stop the existing servers could not answer.
   *
   * The node question below is one of the three grounds the daemon refuses an
   * RCON stop on; these are the other two, and unlike that one they are asked
   * of each server rather than of its node — see
   * `assertRconStopReachesEveryServer`, which holds the reasoning and the
   * mirror of `resolveRconTarget`.
   *
   * Skipped when the role and the secret variable are already the ones in
   * force, and only then. That is a narrower escape than the node check's,
   * because the two preconditions are about *these* values and not about the
   * arm of the union: an edit from `role: 'rcon'` to `role: 'rcon2'` is a new
   * question even though both are RCON stops. What the narrower form still
   * buys is the same way out — a template whose servers are already refusing
   * their stop can have its command corrected without this standing in front of
   * the fix.
   */
  private async assertStopReachesEveryServer(
    existing: TemplateRow,
    dto: UpdateTemplateDto,
    stop: StopConfiguration | undefined,
  ): Promise<void> {
    const target = rconStopTarget(stop);

    if (!target) {
      return;
    }

    const current = rconStopTarget(existing.stop);

    if (
      current &&
      current.role === target.role &&
      current.secretVariable === target.secretVariable
    ) {
      return;
    }

    const servers = await this.prisma.server.findMany({
      where: { templateId: existing.id },
      select: {
        name: true,
        primaryAllocationId: true,
        allocations: { select: { id: true, ip: true, port: true, role: true } },
        // The one row the password question is about. Fetching every variable
        // of every server to look at one of them would be the same query with
        // a page of rows behind it.
        variables: {
          where: { envVariable: target.secretVariable },
          select: { envVariable: true, value: true },
        },
      },
      orderBy: { id: 'asc' },
    });

    // The variable this same request adds counts as present, because the
    // backfill in `update` will have written a row for it on every one of these
    // servers by the time the write commits. Refusing here would refuse the one
    // edit that actually works — adding the password variable and pointing the
    // stop at it, in a single save — and would refuse it with a message saying
    // the variable is not set, having just been handed its value.
    const added = dto.variables?.find((variable) => variable.envVariable === target.secretVariable);

    assertRconStopReachesEveryServer(
      stop,
      servers.map((server) => ({
        ...server,
        variables:
          server.variables.length > 0 || added === undefined
            ? server.variables
            : [{ envVariable: added.envVariable, value: added.defaultValue }],
      })),
    );
  }

  /**
   * Refuses an edit that would put an RCON stop on a node too old to read one.
   *
   * Only when the stop was not already RCON. What the node has to understand is
   * the arm of the union, not the command or the port name inside it, so an
   * edit from one RCON stop to another asks nothing new of any node — and
   * asking anyway would refuse an operator the ability to correct the command
   * on a template whose servers happen to sit on a node that is already in
   * trouble. Moving *away* from RCON is never refused, which is what leaves a
   * way out.
   */
  private async assertStopReachesEveryNode(
    existing: TemplateRow,
    stop: StopConfiguration | undefined,
  ): Promise<void> {
    if (!declaresRconStop(stop) || declaresRconStop(existing.stop)) {
      return;
    }

    const nodes = await this.prisma.node.findMany({
      where: { servers: { some: { templateId: existing.id } } },
      select: { uuid: true, name: true },
    });

    await assertStopTransportHonouredEverywhere(
      stop,
      nodes.map((node) => ({
        name: node.name,
        connection: () => this.nodes.getConnection(node.uuid),
      })),
      this.client,
    );
  }

  /**
   * The group a template is being written into, created if it does not exist.
   *
   * Created rather than refused, because that is what importing an egg already
   * does — a template arrives naming a group, and requiring the group to be
   * made first would be a rule the importer does not follow.
   */
  private async resolveGroup(name: string): Promise<{ id: number; name: string }> {
    const group = await this.prisma.templateGroup.upsert({
      where: { name },
      update: {},
      create: { name },
      select: { id: true, name: true },
    });

    return group;
  }

  /**
   * The key being **left**, on a rename.
   *
   * One of a pair with `assertKeyMayBeTaken`, and the pairing is the point: a
   * catalogue key is a name two other systems resolve, so both letting go of
   * one and picking one up break something, in opposite directions.
   */
  private assertKeyMayBeReleased(key: string): void {
    if (!CATALOGUE_KEYS.has(key)) {
      return;
    }

    // The key is the catalogue's upsert key and the Modrinth loader lookup at
    // once (`plugins.controller.ts`), and every loader it knows is a catalogue
    // key. Renaming one therefore does two things at the same time: the next
    // resynchronisation finds no template under the old key and installs a
    // second one beside this, and the plugin tab of every existing server built
    // from it stops offering anything to install.
    throw new ConflictException(
      `"${key}" is the key the bundled catalogue updates this template by, and the key the plugin catalogue looks its loader up by. Renaming it would have the next resynchronisation install a second copy of this template, and would empty the plugin tab of every server already built from it. Every other field can be changed freely.`,
    );
  }

  /**
   * The key being **taken**, on a rename or a creation.
   *
   * `assertKeyFree` already refuses a key some template answers to, which
   * covers a catalogue key while the catalogue template holding it is
   * installed. The gap is the free one — a template the operator deleted, or a
   * catalogue entry shipped by a Hopper newer than the last resynchronisation.
   * Taking it is not a name collision that shows up later; it is the same harm
   * as releasing one, arrived at from the other side. Every write here sets
   * `modifiedByAdmin`, and `TemplateSyncService.upsert` skips a template
   * carrying that flag, so the real catalogue template becomes permanently
   * uninstallable: Resynchronise finds this row under the key it upserts by,
   * declines to touch it, and reports the template as kept.
   *
   * The supported way to have a customised Paper is to let the catalogue
   * install Paper and then edit it — which sets the same flag and means the
   * same thing, minus a catalogue entry that can never arrive again.
   */
  private assertKeyMayBeTaken(key: string): void {
    if (!CATALOGUE_KEYS.has(key)) {
      return;
    }

    throw new ConflictException(
      `"${key}" is a key the bundled catalogue installs under, so a template of yours holding it would take that entry's place for good: every "Resynchronise" from now on would find your template under that key and leave it untouched, and the shipped one could never be installed. Pick another key. To customise the shipped template, resynchronise the catalogue and edit the template it installs — edits to it are kept by every later resynchronisation.`,
    );
  }

  private async assertKeyFree(key: string): Promise<void> {
    const clash = await this.prisma.template.findUnique({ where: { key }, select: { name: true } });

    if (clash) {
      throw new ConflictException(
        `The key "${key}" is already used by the template "${clash.name}".`,
      );
    }
  }

  /**
   * By group name and not by group id, so the check can run before the group
   * exists: `@@unique([groupId, name])` is what it is standing in for, and the
   * point of asking early is that nothing has been created yet when it refuses.
   */
  private async assertNameFreeInGroup(
    groupName: string,
    name: string,
    exceptId?: number,
  ): Promise<void> {
    const clash = await this.prisma.template.findFirst({
      where: {
        group: { name: groupName },
        name,
        id: exceptId === undefined ? undefined : { not: exceptId },
      },
      select: { key: true },
    });

    if (clash) {
      throw new ConflictException(
        `This group already holds a template named "${name}" (key "${clash.key}").`,
      );
    }
  }

  private async assertGroupNameFree(name: string): Promise<void> {
    const clash = await this.prisma.templateGroup.findUnique({
      where: { name },
      select: { uuid: true },
    });

    if (clash) {
      throw new ConflictException(`A template group named "${name}" already exists.`);
    }
  }
}

/**
 * The row as the editor sees it, with the columns whose type is `Json` read
 * through the contract.
 *
 * A value the contract cannot read shows as absent, the same as the read view
 * does with `readiness`, and here that has a consequence worth stating: saving
 * afterwards clears it. That is the repair rather than a loss — an unreadable
 * `stop` makes `parseStop` refuse to build the server's configuration at all,
 * so the column was already stopping the server from starting, and the field it
 * falls back to is the `stopCommand` sitting next to it.
 */
export function toDetailView(template: TemplateRow): TemplateDetailView {
  return {
    uuid: template.uuid,
    key: template.key,
    group: template.group,
    name: template.name,
    description: template.description,
    author: template.author,
    modifiedByAdmin: template.modifiedByAdmin,

    dockerImages: parseImageOptions(template.dockerImages),
    startup: template.startup,

    stopCommand: template.stopCommand,
    stop: parseStop(template.stop),
    stopTimeoutSeconds: template.stopTimeoutSeconds,
    startupDetection: template.startupDetection,
    readiness: parseReadiness(template.readiness),

    configFiles: parseConfigFiles(template.configFiles),
    fileDenylist: template.fileDenylist,

    installContainer: template.installContainer,
    installEntrypoint: template.installEntrypoint,
    installScript: template.installScript,
    installInactivityTimeoutMs: template.installInactivityTimeoutMs,
    installRequiredDiskBytes:
      template.installRequiredDiskBytes === null ? null : Number(template.installRequiredDiskBytes),

    importedFromEgg: template.importedFromEgg,
    serverCount: template._count.servers,
    // Every one of them, viewable or not: see `TemplateVariableDetail`.
    variables: template.variables.map((variable) => ({
      name: variable.name,
      description: variable.description,
      envVariable: variable.envVariable,
      defaultValue: variable.defaultValue,
      userViewable: variable.userViewable,
      userEditable: variable.userEditable,
      rules: variable.rules,
    })),

    createdAt: template.createdAt,
    updatedAt: template.updatedAt,
  };
}

/**
 * Refuses a variable list naming the same environment variable twice.
 *
 * `templateDefinitionSchema.variables` is a plain array with no refinement, so
 * nothing upstream of here objects — and `TemplateVariable` carries
 * `@@unique([templateId, envVariable])`, so the `createMany` inside the write
 * raises P2002. Prisma's constraint errors are not translated by anything on
 * this path, which means the operator gets "Internal server error" for a form
 * they filled in wrong. `allocations.service.ts` states the rule this follows:
 * pre-check what a unique index is going to refuse, because a database error is
 * not a message anybody can act on.
 *
 * A no-op when the list is absent, which on the update path means "leave the
 * variables alone" rather than "there are none".
 */
function assertVariableNamesAreDistinct(
  variables: readonly { envVariable: string }[] | undefined,
): void {
  if (!variables) {
    return;
  }

  const seen = new Set<string>();
  const duplicates = new Set<string>();

  for (const variable of variables) {
    if (seen.has(variable.envVariable)) {
      duplicates.add(variable.envVariable);
    }

    seen.add(variable.envVariable);
  }

  if (duplicates.size > 0) {
    throw new ConflictException(
      `This template names the same variable twice: ${[...duplicates].join(', ')}. Each environment variable can appear once.`,
    );
  }
}

/**
 * The variables an edit takes away, by name.
 *
 * Worth computing only because of what does *not* happen to them. A
 * `ServerVariable` row has no foreign key to the template variable it came from
 * — only to its server — so removing a variable here removes it from the form
 * and from nothing else: the row keeps reaching the container's environment for
 * as long as the server exists, and no route can delete it, because
 * `startup.service.ts` refuses to write an envVariable the template no longer
 * declares. Nothing surfaces it either, since the Startup page iterates the
 * template's variables rather than the server's.
 *
 * That is tolerable for a renamed knob and is not tolerable for a credential,
 * and the difference is not one this code can tell. So the audit entry carries
 * the names: it is the only record that will ever say which values are still
 * sitting in an environment nobody can see.
 *
 * Deliberately not a refusal. An egg author correcting a typo in a variable
 * name would otherwise be blocked by every server anybody had ever created.
 */
function droppedVariables(
  existing: { variables: readonly { envVariable: string }[] },
  dto: { variables?: readonly { envVariable: string }[] },
): string[] {
  if (!dto.variables) {
    return [];
  }

  const kept = new Set(dto.variables.map((variable) => variable.envVariable));

  return existing.variables
    .map((variable) => variable.envVariable)
    .filter((envVariable) => !kept.has(envVariable));
}

function toGroupView(
  group: {
    uuid: string;
    name: string;
    description: string;
    author: string;
    createdAt: Date;
    updatedAt: Date;
  } & { _count: { templates: number } },
): TemplateGroupView {
  return {
    uuid: group.uuid,
    name: group.name,
    description: group.description,
    author: group.author,
    templateCount: group._count.templates,
    createdAt: group.createdAt,
    updatedAt: group.updatedAt,
  };
}

function parseStop(raw: unknown): StopConfiguration | null {
  if (raw === null || raw === undefined) {
    return null;
  }

  const result = stopConfigurationSchema.safeParse(raw);

  return result.success ? result.data : null;
}

function parseConfigFiles(raw: unknown): ConfigFile[] {
  if (!Array.isArray(raw)) {
    return [];
  }

  // Entry by entry, so that one malformed file out of four does not hide the
  // other three from the author who has to fix it.
  //
  // This used to claim it matched what the configuration builder does with the
  // same column, and that is false. The builder's own `parseConfigFiles` is
  // lenient in the same way, but it is followed by
  // `serverConfigurationSchema.parse` over the whole payload, which is not:
  // measured, a single entry with `parser: 'toml'` among three good ones fails
  // the parse at `configFiles.1.parser`, `buildForNode` catches it, and the
  // **entire server** drops out of the page its node is given. That server's
  // console then answers "server unknown to this node" for every action.
  //
  // So dropping the entry here is the repair rather than a loss — a value the
  // contract cannot read was already stopping the server being described at
  // all. What is worth knowing is when the repair happens: the whole row goes
  // back through these parsers on any save, so a PATCH that touches nothing but
  // the description permanently deletes a malformed entry it never mentioned.
  return raw
    .map((entry) => configFileSchema.safeParse(entry))
    .filter((result) => result.success)
    .map((result) => result.data);
}

/**
 * The template a PATCH leaves behind.
 *
 * The whole definition is rebuilt and every column written, rather than handing
 * Prisma only the fields the request named. Two reasons, and the second is the
 * one that matters: `templateColumns` is where "this template declares nothing"
 * is turned into `Prisma.DbNull` — an undefined field means "leave the column
 * alone" to Prisma, so a partial write is exactly the shape in which a cleared
 * `stop` silently keeps stopping servers over a transport the author removed.
 * Feeding that function a complete definition keeps those decisions in the one
 * place that already documents them.
 *
 * Not re-validated on the way through: the request half has been through the
 * pipe, and the row half is already in the database — where `installScript` is
 * allowed to be empty and `templateDefinitionSchema` is not, so parsing an
 * existing row through it would refuse edits to templates that work today.
 */
function mergedDefinition(
  existing: TemplateRow,
  dto: UpdateTemplateDto,
  key: string,
  group: string,
): TemplateDefinition {
  return {
    key,
    group,
    name: dto.name ?? existing.name,
    description: dto.description ?? existing.description,
    author: dto.author ?? existing.author,

    dockerImages: dto.dockerImages ?? parseImageOptions(existing.dockerImages),
    startup: dto.startup ?? existing.startup,

    stopCommand: dto.stopCommand ?? existing.stopCommand,
    stop: patched(dto.stop, parseStop(existing.stop) ?? undefined),
    stopTimeoutSeconds: patched(dto.stopTimeoutSeconds, existing.stopTimeoutSeconds ?? undefined),
    startupDetection: patched(dto.startupDetection, existing.startupDetection ?? undefined),
    readiness: patched(dto.readiness, parseReadiness(existing.readiness) ?? undefined),

    configFiles: dto.configFiles ?? parseConfigFiles(existing.configFiles),
    fileDenylist: dto.fileDenylist ?? existing.fileDenylist,

    installContainer: dto.installContainer ?? existing.installContainer,
    installEntrypoint: dto.installEntrypoint ?? existing.installEntrypoint,
    installScript: dto.installScript ?? existing.installScript,
    installInactivityTimeoutMs: patched(
      dto.installInactivityTimeoutMs,
      existing.installInactivityTimeoutMs ?? undefined,
    ),
    installRequiredDiskBytes: patched(
      dto.installRequiredDiskBytes,
      existing.installRequiredDiskBytes === null
        ? undefined
        : Number(existing.installRequiredDiskBytes),
    ),

    // Never taken from the request: provenance is observed, not declared. An
    // imported egg stays imported through every edit.
    importedFromEgg: existing.importedFromEgg ?? undefined,

    // Written by the transaction rather than by the column mapper — the
    // variables are rows of their own, and only when the request sent a list.
    variables: [],
  };
}

/** `undefined` in a PATCH means "leave alone"; an explicit `null` means "clear". */
function patched<T>(incoming: T | null | undefined, current: T | undefined): T | undefined {
  return incoming === undefined ? current : (incoming ?? undefined);
}
