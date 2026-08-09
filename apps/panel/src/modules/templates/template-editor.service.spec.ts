import { NODE_CAPABILITIES } from '@hopper/shared';
import { importPterodactylEgg } from '@hopper/templates';
import { ConflictException, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';
import type { PrismaService } from '../../prisma/prisma.service.js';
import type { AuditService } from '../audit/audit.service.js';
import type { NodeClientService } from '../nodes/node-client.service.js';
import type { NodesService } from '../nodes/nodes.service.js';
import { TemplateEditorService } from './template-editor.service.js';
import { createTemplateSchema, updateTemplateSchema } from './templates.dto.js';

/**
 * Editing a template, and the ways a careless editor breaks something a long
 * way from the page it is on.
 *
 * One: a write that forgets `modifiedByAdmin` has the next "Resynchronise"
 * overwrite the administrator's template, variables included. Two: a PATCH that
 * writes fields the request never mentioned blanks whatever it did not carry.
 * Three: a delete the database refuses surfaces as a 500 rather than as the
 * count of servers in the way. Four: an edit that puts an RCON stop on a
 * template whose servers sit on an old daemon takes those nodes out entirely —
 * see `stop-transport.ts`.
 *
 * **The double below honours the queries it is given.** It used to return a
 * field per method — one row for every `findUnique`, one clash for every
 * `findFirst`, `where` and `orderBy` dropped on the floor — which made every
 * decision the service expresses *as a query* invisible here: searching for a
 * key collision under the wrong key, searching for a name collision in the
 * wrong group, forgetting to exclude the row being edited, ordering the
 * variables by the wrong column. All four passed. So this is a small store with
 * a `where` matcher over it, and the assertions below are about what comes back
 * out of it rather than about what the service was handed.
 */

const TEMPLATE_UUID = '6f1c2f4a-8f43-4d31-9d1b-9e2b7c2f0f11';
const CREATED_UUID = '11111111-2222-4333-8444-555555555555';
const GROUP_UUID = 'c4b6a5c8-2a1e-4c8f-9a52-2c2b0d5f7e10';

const RCON_STOP = {
  type: 'rcon' as const,
  command: 'quit',
  role: 'rcon',
  secretVariable: 'RCON_PASSWORD',
};

/**
 * A variable row, with the two columns that decide the order it is read back
 * in: `sort`, and `id` breaking its ties.
 */
function variableRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 1,
    name: 'Version',
    description: '',
    envVariable: 'VERSION',
    defaultValue: 'latest',
    userViewable: true,
    userEditable: true,
    rules: 'required|string',
    sort: 0,
    ...overrides,
  };
}

/**
 * A template imported from an egg: not a catalogue key, so its key can move.
 *
 * No `group` and no `_count` — the store derives both, from the group carrying
 * this row's `groupId` and from the servers pointing at its `id`. A row that
 * carried its own copy of either would let a test assert a server count no
 * query could have produced.
 */
function templateRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 7,
    uuid: TEMPLATE_UUID,
    key: 'my-egg',
    groupId: 1,
    name: 'My egg',
    description: 'Imported from somewhere.',
    author: 'Someone',
    modifiedByAdmin: false,
    dockerImages: [{ name: 'Java 21', image: 'eclipse-temurin:21-jre-noble' }],
    startup: './start.sh',
    stopCommand: 'command:stop',
    stop: null as unknown,
    stopTimeoutSeconds: null as number | null,
    startupDetection: null as string | null,
    readiness: null as unknown,
    configFiles: [{ file: 'server.properties', parser: 'properties', replacements: [] }] as unknown,
    fileDenylist: ['secrets/**'],
    installContainer: 'debian:bookworm-slim',
    installEntrypoint: '/bin/bash',
    installScript: 'set -e\ncurl -sSL https://example.invalid -o server.jar',
    installInactivityTimeoutMs: null as number | null,
    installRequiredDiskBytes: null as bigint | null,
    importedFromEgg: 'e0e0e0e0-0000-4000-8000-000000000000',
    createdAt: new Date('2026-01-01T00:00:00Z'),
    updatedAt: new Date('2026-01-02T00:00:00Z'),
    variables: [
      variableRow({ id: 11, sort: 0 }),
      variableRow({
        id: 12,
        sort: 1,
        name: 'Build path',
        description: 'Where the jar lands.',
        envVariable: 'BUILD_PATH',
        defaultValue: '/opt',
        userViewable: false,
        userEditable: false,
        rules: 'nullable|string',
      }),
    ],
    ...overrides,
  };
}

function groupRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 1,
    uuid: GROUP_UUID,
    name: 'Tests',
    description: '',
    author: '',
    createdAt: new Date('2026-01-01T00:00:00Z'),
    updatedAt: new Date('2026-01-02T00:00:00Z'),
    ...overrides,
  };
}

/** A server built from template 7, with one unnamed primary port and no variables. */
function serverRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 1,
    templateId: 7,
    name: 'survival',
    primaryAllocationId: 10,
    allocations: [{ id: 10, ip: '10.0.0.1', port: 25565, role: null as string | null }],
    variables: [] as { envVariable: string; value: string }[],
    ...overrides,
  };
}

type Row = Record<string, unknown>;

const isFilter = (value: unknown): value is Row =>
  typeof value === 'object' && value !== null && !Array.isArray(value) && !(value instanceof Date);

/**
 * Does one stored row satisfy the `where` the service wrote?
 *
 * Only the operators the editor actually uses: equality, `not`, and a nested
 * object standing for a relation (`group: { name }`). Anything else would be a
 * matcher pretending to be Prisma, which is a second thing to be wrong.
 * `undefined` matches everything, exactly as Prisma treats it — which is the
 * whole point of the `exceptId` branch this has to be able to tell apart.
 */
function matchesWhere(row: Row | undefined, where: Row | undefined): boolean {
  if (where === undefined) {
    return true;
  }

  if (row === undefined) {
    return false;
  }

  return Object.entries(where).every(([field, condition]) => {
    if (condition === undefined) {
      return true;
    }

    const value = row[field];

    if (isFilter(condition)) {
      return 'not' in condition ? value !== condition.not : matchesWhere(value as Row, condition);
    }

    return value === condition;
  });
}

/** `orderBy: [{ sort: 'asc' }, { id: 'asc' }]`, applied. */
function ordered<T extends Row>(rows: T[], orderBy: Row[] | Row | undefined): T[] {
  if (orderBy === undefined) {
    return rows;
  }

  const clauses = (Array.isArray(orderBy) ? orderBy : [orderBy]).flatMap((clause) =>
    Object.entries(clause),
  );

  return [...rows].sort((left, right) => {
    for (const [field, direction] of clauses) {
      const a = left[field] as number | string;
      const b = right[field] as number | string;

      if (a !== b) {
        return (a < b ? -1 : 1) * (direction === 'desc' ? -1 : 1);
      }
    }

    return 0;
  });
}

/** A query as the service phrased it, kept so a test can read the question back. */
interface RecordedCall {
  model: string;
  method: string;
  args: Row;
}

/**
 * The slice of Prisma the editor touches, as a store that answers queries.
 *
 * `$transaction` is handed the fake itself as the transactional client, which
 * is what lets `auditCallsInsideTransaction` be meaningful: the audit entry has
 * to be written after it returns, never within it.
 */
class FakePrisma {
  templates = [templateRow()];
  groups = [groupRow()];
  servers: ReturnType<typeof serverRow>[] = [];
  nodes: { uuid: string; name: string }[] = [];

  readonly calls: RecordedCall[] = [];
  readonly writes: Row[] = [];
  readonly groupWrites: Row[] = [];
  readonly variableWrites: Row[][] = [];
  readonly serverVariableWrites: Row[][] = [];
  variablesDeleted = 0;
  templatesDeleted = 0;
  groupsDeleted = 0;
  auditCallsInsideTransaction: number | null = null;
  countAuditCalls: () => number = () => 0;

  private nextId = 100;

  /** The one template most tests need; assigning it replaces the store. */
  get row() {
    return this.templates[0] as ReturnType<typeof templateRow>;
  }

  set row(row: ReturnType<typeof templateRow>) {
    this.templates = [row];
  }

  /** The arguments of a recorded query, for the questions with no observable answer. */
  argsOf(model: string, method: string): Row | undefined {
    return this.calls.find((call) => call.model === model && call.method === method)?.args;
  }

  private record(model: string, method: string, args: Row): void {
    this.calls.push({ model, method, args });
  }

  /**
   * A stored row as a query returns it: the joined group, the variables in the
   * order asked for, and the server count counted rather than declared.
   */
  private hydrate(row: ReturnType<typeof templateRow>, include?: Row) {
    const group = this.groups.find((candidate) => candidate.id === row.groupId);
    const variables = include?.variables as Row | undefined;

    return {
      ...row,
      group: { uuid: group?.uuid ?? '', name: group?.name ?? '' },
      variables: ordered(row.variables, variables?.orderBy as Row[] | undefined),
      _count: { servers: this.servers.filter((server) => server.templateId === row.id).length },
    };
  }

  private hydrateGroup(group: ReturnType<typeof groupRow>) {
    return {
      ...group,
      _count: {
        templates: this.templates.filter((template) => template.groupId === group.id).length,
      },
    };
  }

  readonly template = {
    findUnique: ({ where, include }: { where: Row; include?: Row }) => {
      this.record('template', 'findUnique', { where, include });

      const row = this.templates.find((candidate) => matchesWhere(candidate, where));

      return Promise.resolve(row ? this.hydrate(row, include) : null);
    },
    findFirst: ({ where }: { where: Row }) => {
      this.record('template', 'findFirst', { where });

      const row = this.templates.find((candidate) => matchesWhere(this.hydrate(candidate), where));

      return Promise.resolve(row ? this.hydrate(row) : null);
    },
    create: ({ data }: { data: Row }) => {
      this.record('template', 'create', { data });
      this.writes.push(data);

      const { variables, ...columns } = data as Row & {
        variables?: { create: Row[] };
      };
      const id = (this.nextId += 1);
      const row = {
        ...templateRow(),
        ...columns,
        id,
        uuid: CREATED_UUID,
        variables: (variables?.create ?? []).map((variable, index) =>
          variableRow({ ...variable, id: index + 1 }),
        ),
      };

      this.templates.push(row);

      return Promise.resolve({ id, uuid: row.uuid });
    },
    update: ({ where, data }: { where: Row; data: Row }) => {
      this.record('template', 'update', { where, data });
      this.writes.push(data);

      const row = this.templates.find((candidate) => matchesWhere(candidate, where));

      if (row) {
        Object.assign(row, data);
      }

      return Promise.resolve(row ?? null);
    },
    delete: ({ where }: { where: Row }) => {
      this.record('template', 'delete', { where });
      this.templatesDeleted += 1;
      this.templates = this.templates.filter((candidate) => !matchesWhere(candidate, where));

      return Promise.resolve({});
    },
  };

  readonly templateVariable = {
    deleteMany: ({ where }: { where: Row }) => {
      this.record('templateVariable', 'deleteMany', { where });
      this.variablesDeleted += 1;

      for (const template of this.templates) {
        if (matchesWhere({ templateId: template.id }, where)) {
          template.variables = [];
        }
      }

      return Promise.resolve({ count: 0 });
    },
    createMany: ({ data }: { data: Row[] }) => {
      this.record('templateVariable', 'createMany', { data });
      this.variableWrites.push(data);

      for (const written of data) {
        const template = this.templates.find((candidate) => candidate.id === written.templateId);

        template?.variables.push(variableRow({ ...written, id: (this.nextId += 1) }));
      }

      return Promise.resolve({ count: data.length });
    },
  };

  readonly templateGroup = {
    upsert: ({ where, create }: { where: { name: string }; create: Row }) => {
      this.record('templateGroup', 'upsert', { where, create });

      const existing = this.groups.find((group) => group.name === where.name);

      if (existing) {
        return Promise.resolve(existing);
      }

      const id = (this.nextId += 1);
      const group = groupRow({ ...create, id, uuid: `group-${id}` });

      this.groups.push(group);

      return Promise.resolve(group);
    },
    findUnique: ({ where }: { where: Row }) => {
      this.record('templateGroup', 'findUnique', { where });

      const group = this.groups.find((candidate) => matchesWhere(candidate, where));

      return Promise.resolve(group ? this.hydrateGroup(group) : null);
    },
    create: ({ data }: { data: Row }) => {
      this.record('templateGroup', 'create', { data });
      this.groupWrites.push(data);

      const id = (this.nextId += 1);
      const group = groupRow({ ...data, id, uuid: `group-${id}` });

      this.groups.push(group);

      return Promise.resolve(this.hydrateGroup(group));
    },
    update: ({ where, data }: { where: Row; data: Row }) => {
      this.record('templateGroup', 'update', { where, data });
      this.groupWrites.push(data);

      const group = this.groups.find((candidate) => matchesWhere(candidate, where));

      if (group) {
        // Prisma leaves a column alone for an undefined field; a fake that
        // copied it would blank the two columns a PATCH stayed silent about.
        for (const [field, value] of Object.entries(data)) {
          if (value !== undefined) {
            (group as Row)[field] = value;
          }
        }
      }

      return Promise.resolve(this.hydrateGroup(group ?? groupRow()));
    },
    delete: ({ where }: { where: Row }) => {
      this.record('templateGroup', 'delete', { where });
      this.groupsDeleted += 1;
      this.groups = this.groups.filter((candidate) => !matchesWhere(candidate, where));

      return Promise.resolve({});
    },
  };

  readonly node = {
    findMany: ({ where }: { where?: Row } = {}) => {
      this.record('node', 'findMany', { where });

      return Promise.resolve(this.nodes);
    },
  };

  /**
   * The servers standing behind a template, which both the RCON gate and the
   * backfill have to reach.
   *
   * Empty by default, so a test that says nothing about servers exercises the
   * ordinary case — an edit to a template nobody has built from yet.
   */
  readonly server = {
    findMany: ({ where, select, orderBy }: { where?: Row; select?: Row; orderBy?: Row }) => {
      this.record('server', 'findMany', { where, select, orderBy });

      // The gate asks for one variable per server by name rather than for all
      // of them; honoured here, because "the row is absent" is exactly the
      // condition it refuses on.
      const wanted = (select?.variables as Row | undefined)?.where as Row | undefined;

      return Promise.resolve(
        ordered(
          this.servers.filter((server) => matchesWhere(server, where)),
          orderBy,
        ).map((server) => ({
          ...server,
          variables: server.variables.filter((variable) => matchesWhere(variable, wanted)),
        })),
      );
    },
  };

  readonly serverVariable = {
    createMany: ({ data, skipDuplicates }: { data: Row[]; skipDuplicates?: boolean }) => {
      this.record('serverVariable', 'createMany', { data, skipDuplicates });
      this.serverVariableWrites.push(data);

      let written = 0;

      for (const candidate of data) {
        const server = this.servers.find((row) => row.id === candidate.serverId);
        const already = server?.variables.some(
          (variable) => variable.envVariable === candidate.envVariable,
        );

        if (!server || (already && skipDuplicates)) {
          continue;
        }

        server.variables.push({
          envVariable: candidate.envVariable as string,
          value: candidate.value as string,
        });
        written += 1;
      }

      return Promise.resolve({ count: written });
    },
  };

  $transaction = async (run: (tx: FakePrisma) => Promise<unknown>) => {
    const result = await run(this);
    this.auditCallsInsideTransaction = this.countAuditCalls();
    return result;
  };

  asService(): PrismaService {
    return this as unknown as PrismaService;
  }
}

/** `null` stands for a node that does not answer at all, which is a 503 and not a 409. */
const clientAnnouncing = (capabilities: string[] | null) =>
  ({
    honoursCapability: vi.fn((_node: unknown, capability: string) =>
      Promise.resolve(
        capabilities === null
          ? { honoured: false as const, reachable: false as const, reason: 'No answer.' }
          : capabilities.includes(capability)
            ? { honoured: true as const }
            : { honoured: false as const, reachable: true as const },
      ),
    ),
  }) as unknown as NodeClientService;

function editing(
  options: {
    capabilities?: string[] | null;
    templates?: ReturnType<typeof templateRow>[];
    groups?: ReturnType<typeof groupRow>[];
    servers?: ReturnType<typeof serverRow>[];
  } = {},
) {
  const prisma = new FakePrisma();
  const audit = { record: vi.fn(() => Promise.resolve()) };
  const nodes = { getConnection: vi.fn(() => Promise.resolve({})) };
  const client = clientAnnouncing(
    options.capabilities === undefined ? [NODE_CAPABILITIES.rconStop] : options.capabilities,
  );

  if (options.templates) {
    prisma.templates = options.templates;
  }

  if (options.groups) {
    prisma.groups = options.groups;
  }

  if (options.servers) {
    prisma.servers = options.servers;
  }

  prisma.countAuditCalls = () => audit.record.mock.calls.length;

  const service = new TemplateEditorService(
    prisma.asService(),
    audit as unknown as AuditService,
    nodes as unknown as NodesService,
    client,
  );

  return { service, prisma, audit, nodes, client };
}

/** A store with nothing in it yet, which is what a creation writes into. */
const creating = (options: Parameters<typeof editing>[0] = {}) =>
  editing({ templates: [], ...options });

const context = { ip: '203.0.113.7', userAgent: 'vitest' };

const creation = (fields: Record<string, unknown> = {}) =>
  createTemplateSchema.parse({
    key: 'my-egg',
    group: 'Tests',
    name: 'My egg',
    dockerImages: [{ name: 'Java 21', image: 'eclipse-temurin:21-jre-noble' }],
    startup: './start.sh',
    installScript: 'set -e',
    ...fields,
  });

const patch = (fields: Record<string, unknown>) => updateTemplateSchema.parse(fields);

describe('TemplateEditorService detail view', () => {
  it('shows the variables the read view hides', async () => {
    // The read view filters to `userViewable` because a non-viewable variable
    // is an implementation detail of the template. It is not an implementation
    // detail to whoever owns the template: its default value decides what the
    // install script and the startup line do, and until it appeared here the
    // only way to change one was SQL.
    const { service } = editing();

    const view = await service.findDetailByUuid(TEMPLATE_UUID);

    expect(view.variables.map((variable) => variable.envVariable)).toEqual([
      'VERSION',
      'BUILD_PATH',
    ]);
    expect(view.variables[1]).toMatchObject({ userViewable: false });
  });

  it('reads the variables back in the order their author put them in', async () => {
    // The write side numbers them by position; this is the other half, and
    // without it the column is written and never read. The rows are stored in
    // an order no clause produces, so a read that ordered by anything else —
    // insertion, id, id descending — comes back visibly different.
    const { service, prisma } = editing();
    prisma.row = templateRow({
      variables: [
        variableRow({ id: 30, sort: 2, envVariable: 'FLAGS' }),
        variableRow({ id: 31, sort: 0, envVariable: 'VERSION' }),
        variableRow({ id: 32, sort: 1, envVariable: 'BUILD_PATH' }),
      ],
    });

    const view = await service.findDetailByUuid(TEMPLATE_UUID);

    expect(view.variables.map((variable) => variable.envVariable)).toEqual([
      'VERSION',
      'BUILD_PATH',
      'FLAGS',
    ]);
  });

  it('falls back to the insertion order for rows that predate the column', async () => {
    // Every variable written before `sort` existed sits at 0, and the migration
    // deliberately left them there: the tie-break on `id` is what keeps those
    // templates reading in the order their author wrote them rather than
    // acquiring a new arbitrary one. Stored here in the reverse of that order,
    // so only the tie-break can produce the right answer.
    const { service, prisma } = editing();
    prisma.row = templateRow({
      variables: [
        variableRow({ id: 42, sort: 0, envVariable: 'THIRD' }),
        variableRow({ id: 8, sort: 0, envVariable: 'FIRST' }),
        variableRow({ id: 19, sort: 0, envVariable: 'SECOND' }),
      ],
    });

    expect(
      (await service.findDetailByUuid(TEMPLATE_UUID)).variables.map(
        (variable) => variable.envVariable,
      ),
    ).toEqual(['FIRST', 'SECOND', 'THIRD']);
  });

  it('says whether an administrator has already edited this template', async () => {
    // The flag decides whether the next "Resynchronise" overwrites the row, so
    // the editor showing `false` on a template that carries `true` tells an
    // operator their customisation is at risk when it is not — and, worse, the
    // reverse on the template that really is about to be overwritten.
    const { service, prisma } = editing();

    expect((await service.findDetailByUuid(TEMPLATE_UUID)).modifiedByAdmin).toBe(false);

    prisma.row = templateRow({ modifiedByAdmin: true });

    expect((await service.findDetailByUuid(TEMPLATE_UUID)).modifiedByAdmin).toBe(true);
  });

  it('drops only the config-file entry the contract cannot read', async () => {
    // Entry by entry, so one malformed file out of three does not hide the
    // other two from the author who has to fix it. Handing the column back as
    // it stands would put `parser: 'toml'` on the editor's page as though it
    // were a working entry — and it is the value that makes
    // `serverConfigurationSchema.parse` fail over the whole payload, which
    // drops the server out of its node's page altogether.
    const { service, prisma } = editing();
    prisma.row = templateRow({
      configFiles: [
        { file: 'server.properties', parser: 'properties', replacements: [] },
        { file: 'config.toml', parser: 'toml', replacements: [] },
        { file: 'ops.json', parser: 'json', replacements: [] },
      ],
    });

    expect((await service.findDetailByUuid(TEMPLATE_UUID)).configFiles).toEqual([
      { file: 'server.properties', parser: 'properties', replacements: [] },
      { file: 'ops.json', parser: 'json', replacements: [] },
    ]);
  });

  it('shows no structured stop for a column the contract cannot read', async () => {
    // Absent rather than raw, and saving afterwards clears it — which is the
    // repair rather than a loss: an unreadable `stop` already refuses to build
    // the server's configuration at all, and the field it falls back to is the
    // `stopCommand` sitting beside it.
    const { service, prisma } = editing();
    prisma.row = templateRow({ stop: { type: 'rcon', command: 'quit' } });

    expect((await service.findDetailByUuid(TEMPLATE_UUID)).stop).toBeNull();
  });

  it('carries the disk requirement as a number', async () => {
    // The column is a `BigInt`, which `JSON.stringify` refuses outright. The
    // editor posts this value straight back, so what the type says and what
    // crosses the wire have to be the same thing.
    const { service, prisma } = editing();
    prisma.row = templateRow({ installRequiredDiskBytes: 42_949_672_960n });

    const view = await service.findDetailByUuid(TEMPLATE_UUID);

    expect(view.installRequiredDiskBytes).toBe(42_949_672_960);
  });

  it('counts the servers standing between this template and a delete', async () => {
    const { service } = editing({
      servers: [serverRow({ id: 1 }), serverRow({ id: 2 }), serverRow({ id: 3 })],
    });

    expect((await service.findDetailByUuid(TEMPLATE_UUID)).serverCount).toBe(3);
  });

  it('reports a template nobody has by its uuid', async () => {
    const { service } = editing();

    await expect(service.findDetailByUuid('unknown')).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe('TemplateEditorService.create', () => {
  it('marks the template as edited by an administrator', async () => {
    // The flag `TemplateSyncService.upsert` skips on. Without it the next
    // catalogue resynchronisation overwrites this template — variables
    // included, since the sync deletes and recreates every row.
    const { service, prisma } = creating();

    await service.create(creation(), 1, context);

    expect(prisma.writes[0]).toMatchObject({ modifiedByAdmin: true });
  });

  it('numbers the variables by their place in the list', async () => {
    const { service, prisma } = creating();

    await service.create(
      creation({
        variables: [
          { name: 'Version', envVariable: 'VERSION' },
          { name: 'Flags', envVariable: 'FLAGS' },
        ],
      }),
      1,
      context,
    );

    expect(prisma.writes[0]?.variables).toEqual({
      create: [
        expect.objectContaining({ envVariable: 'VERSION', sort: 0 }),
        expect.objectContaining({ envVariable: 'FLAGS', sort: 1 }),
      ],
    });
  });

  it('writes the template into the group named, creating it if there is none', async () => {
    // Created rather than refused, because that is what importing an egg
    // already does: a template arrives naming a group, and requiring the group
    // to exist first would be a rule the importer does not follow.
    const { service, prisma } = creating();

    await service.create(creation({ group: 'Elsewhere' }), 1, context);

    const created = prisma.groups.find((group) => group.name === 'Elsewhere');

    expect(created, 'the group named by the creation was not created').toBeDefined();
    expect(prisma.writes[0]).toMatchObject({ groupId: created?.id });
  });

  it('refuses a key another template already answers to', async () => {
    // The key is the catalogue's upsert key: two templates sharing one is a
    // state the sync cannot resolve, and the unique index refuses it anyway —
    // as a P2002 the operator reads as "Internal server error". Searched for by
    // the key being written, which is the part a fake used to hide: a lookup
    // under any other string finds nothing and lets the collision through.
    const { service, prisma } = editing();

    await expect(service.create(creation(), 1, context)).rejects.toThrow(
      /key "my-egg" is already used by the template "My egg"/,
    );
    expect(prisma.writes).toEqual([]);
  });

  it('lets a key no template holds through', async () => {
    const { service, prisma } = editing();

    await service.create(creation({ key: 'other-egg', name: 'Other egg' }), 1, context);

    expect(prisma.writes[0]).toMatchObject({ key: 'other-egg' });
  });

  it('refuses a name the target group already holds', async () => {
    const { service } = editing();

    await expect(service.create(creation({ key: 'other-egg' }), 1, context)).rejects.toThrow(
      /already holds a template named "My egg" \(key "my-egg"\)/,
    );
  });

  it('allows the same name in another group, which is where the index stops', async () => {
    // `@@unique([groupId, name])`, not `@@unique([name])`. A collision search
    // that ignored the group would refuse "Survival" in "Modpacks" because
    // "Minecraft" already holds one, and there is no message that could explain
    // that to the operator.
    const { service, prisma } = editing({
      groups: [groupRow(), groupRow({ id: 2, uuid: 'group-2', name: 'Elsewhere' })],
    });

    await service.create(creation({ key: 'other-egg', group: 'Elsewhere' }), 1, context);

    expect(prisma.writes[0]).toMatchObject({ name: 'My egg', groupId: 2 });
  });

  it('refuses a variable list naming the same environment variable twice', async () => {
    // `TemplateVariable` carries `@@unique([templateId, envVariable])`, so the
    // `createMany` raises a P2002 the operator reads as "Internal server
    // error". Refused before the write, and before `resolveGroup`, so a request
    // that is going to be refused leaves no empty group behind it.
    const { service, prisma } = creating();

    await expect(
      service.create(
        creation({
          variables: [
            { name: 'Version', envVariable: 'VERSION' },
            { name: 'Version again', envVariable: 'VERSION' },
          ],
        }),
        1,
        context,
      ),
    ).rejects.toThrow(/names the same variable twice: VERSION/);
    expect(prisma.writes).toEqual([]);
  });

  it('creates no group for a request it is about to refuse', async () => {
    const { service, prisma } = editing();

    await expect(
      service.create(creation({ group: 'Elsewhere', key: 'paper' }), 1, context),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(prisma.groups.map((group) => group.name)).toEqual(['Tests']);
  });

  it('records who created it, after the write', async () => {
    const { service, audit } = creating();

    await service.create(creation(), 42, context);

    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'template.created',
        actorId: 42,
        ip: '203.0.113.7',
        // The uuid and the key rather than a `templateId` column: `AuditLog`
        // has none, and the key is what a template deleted later can still be
        // recognised by.
        metadata: { templateUuid: CREATED_UUID, key: 'my-egg', name: 'My egg', group: 'Tests' },
      }),
    );
  });
});

describe('TemplateEditorService.update', () => {
  it('marks the template as edited by an administrator', async () => {
    const { service, prisma } = editing();

    await service.update(TEMPLATE_UUID, patch({ description: 'Now documented.' }), 1, context);

    expect(prisma.writes[0]).toMatchObject({ modifiedByAdmin: true });
  });

  it('leaves every field the request did not name exactly as it was', async () => {
    // The failure this guards against is total rather than partial: a PATCH
    // built from the request alone writes a default over every column the
    // caller stayed silent about, and the template comes back with no config
    // files, no denylist and a blanked author.
    const { service, prisma } = editing();

    await service.update(TEMPLATE_UUID, patch({ name: 'Renamed' }), 1, context);

    expect(prisma.writes[0]).toMatchObject({
      name: 'Renamed',
      description: 'Imported from somewhere.',
      author: 'Someone',
      installScript: 'set -e\ncurl -sSL https://example.invalid -o server.jar',
      fileDenylist: ['secrets/**'],
      configFiles: [{ file: 'server.properties', parser: 'properties', replacements: [] }],
      // Provenance is observed, never declared: an imported egg stays imported
      // through every edit, and the DTO has no field to say otherwise with.
      importedFromEgg: 'e0e0e0e0-0000-4000-8000-000000000000',
    });
  });

  it('leaves the template in its group when the request names no other', async () => {
    const { service, prisma } = editing();

    await service.update(TEMPLATE_UUID, patch({ name: 'Renamed' }), 1, context);

    expect(prisma.writes[0]).toMatchObject({ groupId: 1 });
    expect(prisma.argsOf('templateGroup', 'upsert')).toBeUndefined();
  });

  it('moves the template into the group the request names', async () => {
    // The group is written as an id, and the id has to come from resolving the
    // name: keeping the one the row already carries writes the template back
    // into the group it was in, with no error anywhere and an audit entry
    // claiming the move happened.
    const { service, prisma } = editing({
      groups: [groupRow(), groupRow({ id: 2, uuid: 'group-2', name: 'Elsewhere' })],
    });

    await service.update(TEMPLATE_UUID, patch({ group: 'Elsewhere' }), 1, context);

    expect(prisma.writes[0]).toMatchObject({ groupId: 2 });
    expect((await service.findDetailByUuid(TEMPLATE_UUID)).group).toMatchObject({
      name: 'Elsewhere',
    });
  });

  it('creates the group a move names when there is none', async () => {
    const { service, prisma } = editing();

    await service.update(TEMPLATE_UUID, patch({ group: 'Brand new' }), 1, context);

    const created = prisma.groups.find((group) => group.name === 'Brand new');

    expect(created, 'the group named by the move was not created').toBeDefined();
    expect(prisma.writes[0]).toMatchObject({ groupId: created?.id });
  });

  it('creates no group for an edit it is about to refuse', async () => {
    // `resolveGroup` runs last of all the reads for this reason: a refused edit
    // that had already made a group would leave an empty one nobody asked for,
    // and nothing in the product ever deletes it.
    const { service, prisma } = editing({ capabilities: [] });
    prisma.nodes = [{ uuid: 'node-uuid', name: 'node-1' }];

    await expect(
      service.update(TEMPLATE_UUID, patch({ group: 'Brand new', stop: RCON_STOP }), 1, context),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(prisma.groups.map((group) => group.name)).toEqual(['Tests']);
  });

  it('leaves the variables alone when the request sends none', async () => {
    const { service, prisma } = editing();

    await service.update(TEMPLATE_UUID, patch({ description: 'Now documented.' }), 1, context);

    expect(prisma.variablesDeleted).toBe(0);
    expect(prisma.variableWrites).toEqual([]);
  });

  it('replaces the variables as one ordered list', async () => {
    // No per-variable route, and none possible: `TemplateVariable` has no uuid
    // and its ids are recreated by every catalogue sync, so nothing an editor
    // could address a single variable by still means that variable an hour
    // later. The order of the array is the order.
    const { service, prisma } = editing();

    await service.update(
      TEMPLATE_UUID,
      patch({
        variables: [
          { name: 'Flags', envVariable: 'FLAGS' },
          { name: 'Version', envVariable: 'VERSION' },
        ],
      }),
      1,
      context,
    );

    expect(prisma.variablesDeleted).toBe(1);
    expect(prisma.variableWrites[0]).toEqual([
      expect.objectContaining({ envVariable: 'FLAGS', sort: 0, templateId: 7 }),
      expect.objectContaining({ envVariable: 'VERSION', sort: 1, templateId: 7 }),
    ]);
  });

  it('reads a reordered list back in the order it was saved in', async () => {
    // The round trip, which neither half proves on its own: the write numbers
    // by position and the read orders by that number, and the value the editor
    // returns to the page it was posted from has to be the list the author
    // arranged.
    const { service } = editing();

    const view = await service.update(
      TEMPLATE_UUID,
      patch({
        variables: [
          { name: 'Flags', envVariable: 'FLAGS' },
          { name: 'Version', envVariable: 'VERSION' },
        ],
      }),
      1,
      context,
    );

    expect(view.variables.map((variable) => variable.envVariable)).toEqual(['FLAGS', 'VERSION']);
  });

  it('refuses a variable list naming the same environment variable twice', async () => {
    const { service, prisma } = editing();

    await expect(
      service.update(
        TEMPLATE_UUID,
        patch({
          variables: [
            { name: 'Version', envVariable: 'VERSION' },
            { name: 'Version again', envVariable: 'VERSION' },
          ],
        }),
        1,
        context,
      ),
    ).rejects.toThrow(/names the same variable twice: VERSION/);
    expect(prisma.writes).toEqual([]);
    expect(prisma.variablesDeleted).toBe(0);
  });

  it('clears a structured stop on an explicit null', async () => {
    // `Prisma.DbNull` and not `undefined`, which would leave the column alone:
    // a template that dropped its stop would go on being stopped over RCON to
    // a port it no longer names, and that failure refuses the stop outright.
    const { service, prisma } = editing();
    prisma.row = templateRow({ stop: RCON_STOP });

    await service.update(TEMPLATE_UUID, patch({ stop: null }), 1, context);

    expect(prisma.writes[0]).toHaveProperty('stop', Prisma.DbNull);
  });

  it('keeps a structured stop the request never mentioned', async () => {
    const { service, prisma } = editing({ capabilities: [NODE_CAPABILITIES.rconStop] });
    prisma.row = templateRow({ stop: RCON_STOP });

    await service.update(TEMPLATE_UUID, patch({ name: 'Renamed' }), 1, context);

    expect(prisma.writes[0]).toMatchObject({ stop: RCON_STOP });
  });

  it('refuses to rename the key of a template the catalogue owns', async () => {
    // Two breakages at once: the next resynchronisation finds nothing under
    // the old key and installs a second copy, and the plugin tab of every
    // server built from it empties out — the Modrinth loader is looked up by
    // this exact string.
    const { service, prisma } = editing();
    prisma.row = templateRow({ key: 'paper' });

    await expect(
      service.update(TEMPLATE_UUID, patch({ key: 'papermc' }), 1, context),
    ).rejects.toThrow(/plugin tab/);
    expect(prisma.writes).toEqual([]);
  });

  it('refuses a rename onto a key another template already answers to', async () => {
    // The same collision the creation refuses, reached from the other verb. The
    // unique index refuses it either way; what is at stake is whether the
    // operator is told which template is in the way or handed a P2002.
    const { service, prisma } = editing({
      templates: [
        templateRow(),
        templateRow({ id: 8, uuid: 'other', key: 'taken', name: 'Taken' }),
      ],
    });

    await expect(
      service.update(TEMPLATE_UUID, patch({ key: 'taken' }), 1, context),
    ).rejects.toThrow(/key "taken" is already used by the template "Taken"/);
    expect(prisma.writes).toEqual([]);
  });

  it('lets an imported template keep its key while everything else moves', async () => {
    // The rule is about keys other code knows, not about keys in general: an
    // egg's key is nobody's lookup, and refusing to touch it would make a
    // typo permanent.
    const { service, prisma } = editing();

    await service.update(TEMPLATE_UUID, patch({ key: 'my-corrected-egg' }), 1, context);

    expect(prisma.writes[0]).toMatchObject({ key: 'my-corrected-egg' });
  });

  it('refuses a rename onto a name the target group already holds', async () => {
    const { service } = editing({
      templates: [
        templateRow(),
        templateRow({ id: 8, uuid: 'other', key: 'taken', name: 'Already here' }),
      ],
    });

    await expect(
      service.update(TEMPLATE_UUID, patch({ name: 'Already here' }), 1, context),
    ).rejects.toThrow(/already holds a template named "Already here" \(key "taken"\)/);
  });

  it('does not count the template being edited as its own collision', async () => {
    // Asserted on the query rather than on the outcome, and deliberately: the
    // caller only reaches this search when the group or the name has actually
    // changed, so today no row can be both the template being edited and a
    // match. The exclusion is the second of the two guards, and it is the one
    // that still holds the moment the first is relaxed — a PATCH restating the
    // current name, an editor that stops comparing before it asks. Without it
    // that request refuses itself, naming the template as its own clash, and
    // there is nothing the operator can do about it.
    const { service, prisma } = editing({
      groups: [groupRow(), groupRow({ id: 2, uuid: 'group-2', name: 'Elsewhere' })],
    });

    await service.update(TEMPLATE_UUID, patch({ group: 'Elsewhere' }), 1, context);

    expect(prisma.argsOf('template', 'findFirst')).toEqual({
      where: { group: { name: 'Elsewhere' }, name: 'My egg', id: { not: 7 } },
    });
  });

  it('flags a shipped template even when the request changes nothing', async () => {
    // Worth writing down because of what it costs rather than because it is
    // right. `updateTemplateSchema.parse({})` yields `{}`, and the update still
    // rewrites every column and sets the flag — so opening a catalogue
    // template's editor and pressing Save with no changes opts that template
    // out of every future resynchronisation, permanently and silently. The
    // flag-on-edit rule itself is deliberate and `assertKeyMayBeTaken` rests on
    // it; it is the no-change case that has no intent behind it, and this test
    // is what makes changing that a decision rather than an accident.
    const { service, prisma } = editing();
    prisma.row = templateRow({ key: 'paper', modifiedByAdmin: false });

    await service.update(TEMPLATE_UUID, patch({}), 1, context);

    expect(prisma.writes[0]).toMatchObject({ modifiedByAdmin: true });
  });

  it('repairs an unreadable config file on a PATCH that never mentioned it', async () => {
    // The whole row goes back through the parsers on any save, so a PATCH
    // touching nothing but the description permanently deletes a malformed
    // entry it said nothing about. Deleting it is the repair rather than a
    // loss — that entry was already failing `serverConfigurationSchema.parse`
    // over the whole payload and dropping the server out of its node's page —
    // but it is a deletion nobody asked for, and it happens once.
    const { service, prisma } = editing();
    prisma.row = templateRow({
      configFiles: [
        { file: 'server.properties', parser: 'properties', replacements: [] },
        { file: 'config.toml', parser: 'toml', replacements: [] },
      ],
    });

    await service.update(TEMPLATE_UUID, patch({ description: 'Now documented.' }), 1, context);

    expect(prisma.writes[0]).toMatchObject({
      configFiles: [{ file: 'server.properties', parser: 'properties', replacements: [] }],
    });
  });

  it('records what changed, after the write and outside the transaction', async () => {
    // An audit entry written inside the transaction disappears with it when the
    // write rolls back, and claims an edit that never happened.
    const { service, prisma, audit } = editing();

    await service.update(TEMPLATE_UUID, patch({ name: 'Renamed', author: 'Me' }), 9, context);

    expect(prisma.auditCallsInsideTransaction).toBe(0);
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'template.updated',
        actorId: 9,
        metadata: { templateUuid: TEMPLATE_UUID, key: 'my-egg', changed: ['name', 'author'] },
      }),
    );
  });
});

/**
 * A variable added to a template reaches no existing server on its own: the
 * container's environment is built from `ServerVariable` rows and nothing else,
 * and no route can add one afterwards — `StartupService.applyVariables` refuses
 * a write to any variable that is not both editable and viewable, which is
 * every secret this codebase declares. Meanwhile the Startup tab renders the
 * template's default, so the panel displays a value the container has never
 * heard of.
 */
describe('TemplateEditorService.update and the rows on existing servers', () => {
  const servers = () => [
    serverRow({ id: 1, name: 'survival' }),
    serverRow({
      id: 2,
      name: 'creative',
      variables: [{ envVariable: 'VERSION', value: '1.20.1' }],
    }),
  ];

  it('writes the missing rows onto every server built from the template', async () => {
    const { service, prisma } = editing({ servers: servers() });

    await service.update(
      TEMPLATE_UUID,
      patch({
        variables: [
          { name: 'Version', envVariable: 'VERSION', defaultValue: 'latest' },
          { name: 'Rcon password', envVariable: 'RCON_PASSWORD', defaultValue: 'changeme' },
        ],
      }),
      1,
      context,
    );

    expect(prisma.serverVariableWrites[0]).toEqual([
      { serverId: 1, envVariable: 'VERSION', value: 'latest' },
      { serverId: 1, envVariable: 'RCON_PASSWORD', value: 'changeme' },
      { serverId: 2, envVariable: 'VERSION', value: 'latest' },
      { serverId: 2, envVariable: 'RCON_PASSWORD', value: 'changeme' },
    ]);
  });

  it('leaves a value a server already holds exactly as it is', async () => {
    // `skipDuplicates` is what makes this a backfill rather than a reset. These
    // are per-server data the template never owned — a licence key, a seed, a
    // password — and there is no undo anywhere in the product.
    const { service, prisma } = editing({ servers: servers() });

    await service.update(
      TEMPLATE_UUID,
      patch({ variables: [{ name: 'Version', envVariable: 'VERSION', defaultValue: 'latest' }] }),
      1,
      context,
    );

    expect(prisma.argsOf('serverVariable', 'createMany')).toMatchObject({ skipDuplicates: true });
    expect(prisma.servers[1]?.variables).toEqual([{ envVariable: 'VERSION', value: '1.20.1' }]);
    expect(prisma.servers[0]?.variables).toEqual([{ envVariable: 'VERSION', value: 'latest' }]);
  });

  it('writes nothing when the template has no servers', async () => {
    const { service, prisma } = editing();

    await service.update(
      TEMPLATE_UUID,
      patch({ variables: [{ name: 'Version', envVariable: 'VERSION' }] }),
      1,
      context,
    );

    expect(prisma.serverVariableWrites).toEqual([]);
  });

  it('names the variables an edit took away, and leaves their rows alone', async () => {
    // A `ServerVariable` row has no foreign key to the template variable it
    // came from, so removing one here removes it from the form and from nothing
    // else: it goes on reaching the container for ever. That is tolerable for a
    // renamed knob and not for a credential, and the difference is not one this
    // code can tell — so the audit entry carries the names, and it is the only
    // record that will ever say which servers are still carrying the value.
    const { service, prisma, audit } = editing({ servers: servers() });

    await service.update(
      TEMPLATE_UUID,
      patch({ variables: [{ name: 'Version', envVariable: 'VERSION' }] }),
      1,
      context,
    );

    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'template.updated',
        metadata: {
          templateUuid: TEMPLATE_UUID,
          key: 'my-egg',
          changed: ['variables'],
          variablesDropped: ['BUILD_PATH'],
        },
      }),
    );
    expect(prisma.servers[1]?.variables).toEqual([{ envVariable: 'VERSION', value: '1.20.1' }]);
  });

  it('says nothing about dropped variables when an edit drops none', async () => {
    // The ordinary edit's entry keeps the shape it has always had; this key
    // appears only when there is something to say.
    const { service, audit } = editing();

    await service.update(TEMPLATE_UUID, patch({ name: 'Renamed' }), 1, context);

    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: { templateUuid: TEMPLATE_UUID, key: 'my-egg', changed: ['name'] },
      }),
    );
  });
});

describe('TemplateEditorService.update and the stop transport', () => {
  it('refuses an RCON stop while a server sits on a daemon that cannot read one', async () => {
    // Not one broken server: the daemon fails to parse the whole page of
    // configurations, `reconcile` throws, and the node ends up knowing about
    // none of its servers.
    const { service, prisma } = editing({ capabilities: [] });
    prisma.nodes = [{ uuid: 'node-uuid', name: 'node-1' }];

    await expect(
      service.update(TEMPLATE_UUID, patch({ stop: RCON_STOP }), 1, context),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(prisma.writes).toEqual([]);
  });

  it('allows it once every node hosting the template announces the capability', async () => {
    const { service, prisma } = editing({ capabilities: [NODE_CAPABILITIES.rconStop] });
    prisma.nodes = [
      { uuid: 'node-uuid', name: 'node-1' },
      { uuid: 'other-uuid', name: 'node-2' },
    ];

    await service.update(TEMPLATE_UUID, patch({ stop: RCON_STOP }), 1, context);

    expect(prisma.writes[0]).toMatchObject({ stop: RCON_STOP });
  });

  it('asks every node, not merely the first', async () => {
    const { service, prisma, client } = editing({ capabilities: [NODE_CAPABILITIES.rconStop] });
    prisma.nodes = [
      { uuid: 'node-uuid', name: 'node-1' },
      { uuid: 'other-uuid', name: 'node-2' },
    ];

    await service.update(TEMPLATE_UUID, patch({ stop: RCON_STOP }), 1, context);

    expect(client.honoursCapability).toHaveBeenCalledTimes(2);
  });

  it('asks nothing of any node for a template that was already stopping over RCON', async () => {
    // What a node has to understand is the arm of the union, not the command
    // inside it. Asking again would refuse an operator the ability to correct
    // the command on a template whose servers sit on a node already in
    // trouble, and moving away from RCON is what leaves the way out.
    const { service, prisma, client, nodes } = editing({ capabilities: [] });
    prisma.row = templateRow({ stop: RCON_STOP });
    prisma.nodes = [{ uuid: 'node-uuid', name: 'node-1' }];

    await service.update(
      TEMPLATE_UUID,
      patch({ stop: { ...RCON_STOP, command: 'quit now' } }),
      1,
      context,
    );

    expect(client.honoursCapability).not.toHaveBeenCalled();
    expect(nodes.getConnection).not.toHaveBeenCalled();
  });

  it('asks nothing of any node for an edit that has nothing to do with stopping', async () => {
    const { service, prisma, client } = editing({ capabilities: [] });
    prisma.nodes = [{ uuid: 'node-uuid', name: 'node-1' }];

    await service.update(TEMPLATE_UUID, patch({ description: 'Now documented.' }), 1, context);

    expect(client.honoursCapability).not.toHaveBeenCalled();
  });
});

/**
 * The two grounds the daemon refuses an RCON stop on that belong to the server
 * rather than to its node. A template edit reaches both at once, and the daemon
 * does not downgrade such a stop to a signal — it refuses it, so Stop and
 * Restart break on every one of these servers and Kill becomes the only way
 * down.
 */
describe('TemplateEditorService.update and what each server can answer', () => {
  const withRcon = (overrides: Record<string, unknown> = {}) =>
    serverRow({
      allocations: [
        { id: 10, ip: '10.0.0.1', port: 25565, role: null },
        { id: 11, ip: '10.0.0.1', port: 25575, role: 'rcon' },
      ],
      variables: [{ envVariable: 'RCON_PASSWORD', value: 'hunter2' }],
      ...overrides,
    });

  it('refuses when no port on a server carries the role', async () => {
    // `ServersService` gives every primary allocation `role: null`, so a
    // template edited to name one names a port that exists on no server
    // anybody has created until somebody names it by hand, per server.
    const { service, prisma } = editing({
      servers: [withRcon({ allocations: [{ id: 10, ip: '10.0.0.1', port: 25565, role: null }] })],
    });

    await expect(
      service.update(TEMPLATE_UUID, patch({ stop: RCON_STOP }), 1, context),
    ).rejects.toThrow(/no port on it is named "rcon"/);
    expect(prisma.writes).toEqual([]);
  });

  it('refuses when the secret variable has no row on a server', async () => {
    // The environment the daemon receives is built from `ServerVariable` rows
    // alone, and an empty password is a refusal rather than a blank login:
    // most servers switch RCON off entirely when it is blank.
    const { service } = editing({ servers: [withRcon({ variables: [] })] });

    await expect(
      service.update(TEMPLATE_UUID, patch({ stop: RCON_STOP }), 1, context),
    ).rejects.toThrow(/RCON_PASSWORD holds no password/);
  });

  it('names the servers standing in the way', async () => {
    // A count alone leaves the operator to go and find which of forty servers
    // is missing a port, and the fix is per server.
    const { service } = editing({
      servers: [
        withRcon({ id: 1, name: 'survival' }),
        withRcon({ id: 2, name: 'creative', variables: [] }),
        withRcon({ id: 3, name: 'lobby' }),
      ],
    });

    await expect(
      service.update(TEMPLATE_UUID, patch({ stop: RCON_STOP }), 1, context),
    ).rejects.toThrow(/1 existing server\(s\).*"creative"/s);
  });

  it('allows it when every server has the port and the password', async () => {
    const { service, prisma } = editing({
      servers: [withRcon({ id: 1 }), withRcon({ id: 2, name: 'creative' })],
    });

    await service.update(TEMPLATE_UUID, patch({ stop: RCON_STOP }), 1, context);

    expect(prisma.writes[0]).toMatchObject({ stop: RCON_STOP });
  });

  it('counts the password this very request adds as present', async () => {
    // Adding the variable and pointing the stop at it is the one edit that
    // actually works, and the backfill writes a row on every one of these
    // servers by the time the write commits. Refusing here would refuse it with
    // a message saying the variable is not set, having just been handed its
    // value.
    const { service, prisma } = editing({ servers: [withRcon({ variables: [] })] });

    await service.update(
      TEMPLATE_UUID,
      patch({
        stop: RCON_STOP,
        variables: [
          { name: 'Rcon password', envVariable: 'RCON_PASSWORD', defaultValue: 'hunter2' },
        ],
      }),
      1,
      context,
    );

    expect(prisma.writes[0]).toMatchObject({ stop: RCON_STOP });
    expect(prisma.serverVariableWrites[0]).toEqual([
      { serverId: 1, envVariable: 'RCON_PASSWORD', value: 'hunter2' },
    ]);
  });

  it('still refuses when the variable this request adds has no value in it', async () => {
    const { service } = editing({ servers: [withRcon({ variables: [] })] });

    await expect(
      service.update(
        TEMPLATE_UUID,
        patch({
          stop: RCON_STOP,
          variables: [{ name: 'Rcon password', envVariable: 'RCON_PASSWORD', defaultValue: '' }],
        }),
        1,
        context,
      ),
    ).rejects.toThrow(/RCON_PASSWORD holds no password/);
  });

  it('asks nothing of any server when the role and the secret are the ones in force', async () => {
    // The narrow escape: a template whose servers are already refusing their
    // stop can have its command corrected without this standing in front of the
    // fix. Narrower than the node check's, because these two preconditions are
    // about *these* values rather than about the arm of the union.
    const { service, prisma } = editing({ servers: [withRcon({ variables: [] })] });
    prisma.row = templateRow({ stop: RCON_STOP });

    await service.update(
      TEMPLATE_UUID,
      patch({ stop: { ...RCON_STOP, command: 'quit now' } }),
      1,
      context,
    );

    expect(prisma.writes[0]).toMatchObject({ stop: { command: 'quit now' } });
  });

  it('asks again when the edit points the stop at another port', async () => {
    // An edit from `role: 'rcon'` to `role: 'rcon2'` is a new question even
    // though both are RCON stops, which is what the node check does not have to
    // care about and this one does.
    const { service, prisma } = editing({ servers: [withRcon()] });
    prisma.row = templateRow({ stop: RCON_STOP });

    await expect(
      service.update(TEMPLATE_UUID, patch({ stop: { ...RCON_STOP, role: 'rcon2' } }), 1, context),
    ).rejects.toThrow(/no port on it is named "rcon2"/);
  });
});

describe('TemplateEditorService.remove', () => {
  it('refuses while servers were built from the template, and says how many', async () => {
    // `Server.templateId` is `onDelete: Restrict`, so the delete would raise a
    // P2003 that reaches the operator as "Internal server error" — and the one
    // thing they need is the number standing in the way.
    const { service, prisma } = editing({
      servers: [
        serverRow({ id: 1 }),
        serverRow({ id: 2 }),
        serverRow({ id: 3 }),
        serverRow({ id: 4 }),
      ],
    });

    await expect(service.remove(TEMPLATE_UUID, 1, context)).rejects.toThrow(/4 server/);
    expect(prisma.templatesDeleted).toBe(0);
  });

  it('counts only the servers built from this template', async () => {
    const { service, prisma } = editing({
      templates: [
        templateRow(),
        templateRow({ id: 8, uuid: 'other', key: 'other', name: 'Other' }),
      ],
      servers: [serverRow({ id: 1, templateId: 8 })],
    });

    await service.remove(TEMPLATE_UUID, 1, context);

    expect(prisma.templatesDeleted).toBe(1);
  });

  it('deletes a template nothing was built from, and records it', async () => {
    const { service, prisma, audit } = editing();

    await service.remove(TEMPLATE_UUID, 1, context);

    expect(prisma.templatesDeleted).toBe(1);
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'template.deleted',
        metadata: { templateUuid: TEMPLATE_UUID, key: 'my-egg', name: 'My egg' },
      }),
    );
  });

  it('reports a template nobody has rather than deleting something else', async () => {
    const { service, prisma } = editing();

    await expect(service.remove('unknown', 1, context)).rejects.toBeInstanceOf(NotFoundException);
    expect(prisma.templatesDeleted).toBe(0);
  });
});

describe('TemplateEditorService and template groups', () => {
  /** A store holding one empty group, which is what a group write needs. */
  const empty = () => editing({ templates: [] });

  it('creates a group with everything the request said about it', async () => {
    // `description` and `author` are the only two columns this route exists to
    // write — a group's name comes back from the template routes on its own,
    // through `resolveGroup`. Writing the name alone leaves the page that
    // created the group showing two empty fields it has just filled in, and no
    // second route to correct them by except the PATCH.
    const { service, prisma } = empty();

    const view = await service.createGroup(
      { name: 'Modpacks', description: 'Curated packs.', author: 'Ops team' },
      1,
      context,
    );

    expect(view).toMatchObject({
      name: 'Modpacks',
      description: 'Curated packs.',
      author: 'Ops team',
      templateCount: 0,
    });
    expect(prisma.groupWrites[0]).toEqual({
      name: 'Modpacks',
      description: 'Curated packs.',
      author: 'Ops team',
    });
  });

  it('records who created it', async () => {
    const { service, audit, prisma } = empty();

    await service.createGroup({ name: 'Modpacks', description: '', author: '' }, 7, context);

    const created = prisma.groups.find((group) => group.name === 'Modpacks');

    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'template-group.created',
        actorId: 7,
        ip: '203.0.113.7',
        metadata: { groupUuid: created?.uuid, name: 'Modpacks' },
      }),
    );
  });

  it('refuses a group name that already exists', async () => {
    const { service, prisma } = editing();

    await expect(
      service.createGroup({ name: 'Tests', description: '', author: '' }, 1, context),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(prisma.groupWrites).toEqual([]);
  });

  it('counts the templates a group holds', async () => {
    const { service } = editing();

    const view = await service.updateGroup(GROUP_UUID, { author: 'Me' }, 1, context);

    expect(view.templateCount).toBe(1);
  });

  it('records what a group edit changed', async () => {
    const { service, audit } = editing();

    await service.updateGroup(GROUP_UUID, { description: 'Now documented.' }, 3, context);

    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'template-group.updated',
        actorId: 3,
        metadata: { groupUuid: GROUP_UUID, changed: ['description'] },
      }),
    );
  });

  it('leaves the columns a group PATCH stayed silent about', async () => {
    const { service } = editing({
      groups: [groupRow({ description: 'Curated packs.', author: 'Ops team' })],
    });

    const view = await service.updateGroup(GROUP_UUID, { author: 'Someone else' }, 1, context);

    expect(view).toMatchObject({ description: 'Curated packs.', author: 'Someone else' });
  });

  it('reports a group nobody has by its uuid', async () => {
    const { service } = editing();

    await expect(
      service.updateGroup('unknown', { author: 'Me' }, 1, context),
    ).rejects.toBeInstanceOf(NotFoundException);
    await expect(service.removeGroup('unknown', 1, context)).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('refuses to delete a group that still holds templates', async () => {
    // `Template.groupId` is `onDelete: Restrict` as well, and a P2003 says
    // nothing an operator can act on.
    const { service, prisma } = editing({
      templates: [
        templateRow(),
        templateRow({ id: 8, uuid: 'other', key: 'other', name: 'Other' }),
      ],
    });

    await expect(service.removeGroup(GROUP_UUID, 1, context)).rejects.toThrow(/2 template/);
    expect(prisma.groupsDeleted).toBe(0);
  });

  it('deletes an empty group, and records it', async () => {
    const { service, prisma, audit } = empty();

    await service.removeGroup(GROUP_UUID, 1, context);

    expect(prisma.groupsDeleted).toBe(1);
    expect(prisma.groups).toEqual([]);
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'template-group.deleted',
        metadata: { groupUuid: GROUP_UUID, name: 'Tests' },
      }),
    );
  });

  it('refuses to rename a group the bundled catalogue installs into', async () => {
    // The name is the catalogue's upsert key for a group. Renaming one only
    // splits it: the next resynchronisation recreates it under the old name and
    // pulls every untouched template back, leaving two groups where the
    // operator asked for one.
    const { service } = editing({
      groups: [groupRow({ name: 'Minecraft: Java Edition' })],
    });

    await expect(service.updateGroup(GROUP_UUID, { name: 'Java' }, 1, context)).rejects.toThrow(
      /resynchronisation/,
    );
  });

  it('lets a group an operator created be renamed', async () => {
    // The rule above is about the names the catalogue upserts by, not about
    // renaming in general: a group somebody typed is nobody's key.
    const { service } = editing({ groups: [groupRow({ id: 3 })], templates: [] });

    const view = await service.updateGroup(GROUP_UUID, { name: 'Test eggs' }, 1, context);

    expect(view.name).toBe('Test eggs');
  });

  it('refuses a rename onto a name another group already answers to', async () => {
    const { service } = editing({
      groups: [groupRow({ id: 3 }), groupRow({ id: 4, uuid: 'group-4', name: 'Taken' })],
      templates: [],
    });

    await expect(service.updateGroup(GROUP_UUID, { name: 'Taken' }, 1, context)).rejects.toThrow(
      /already exists/,
    );
  });
});

/**
 * The code each refusal reaches the browser as.
 *
 * `toThrow(/message/)` says nothing about it: every one of these could become a
 * 500 — or, worse, a 404 on a template that plainly exists — with the message
 * intact and every assertion above still green. The distinction is not
 * cosmetic. The editor page retries a 409 by showing the operator what is in
 * the way and keeping their form; a 500 is a crash it can only apologise for,
 * and a 503 is the one answer that means "come back in a minute", which is
 * exactly right for a node that did not respond and exactly wrong for a node
 * that answered "too old".
 */
describe('TemplateEditorService — the status of every refusal', () => {
  const statusOf = async (run: () => Promise<unknown>): Promise<number> => {
    try {
      await run();
    } catch (error: unknown) {
      return (error as { getStatus?: () => number }).getStatus?.() ?? 500;
    }

    throw new Error('the call was expected to be refused, and was not');
  };

  const rconOnly = () =>
    editing({
      servers: [
        serverRow({
          allocations: [{ id: 10, ip: '10.0.0.1', port: 25565, role: null }],
        }),
      ],
    });

  it.each([
    [
      'creating a template under a key the catalogue owns',
      409,
      () => {
        const { service } = creating();
        return service.create(creation({ key: 'paper' }), 1, context);
      },
    ],
    [
      'creating a template under a key another template holds',
      409,
      () => editing().service.create(creation(), 1, context),
    ],
    [
      'creating a template under a name its group already holds',
      409,
      () => editing().service.create(creation({ key: 'other-egg' }), 1, context),
    ],
    [
      'creating a template naming one variable twice',
      409,
      () => {
        const { service } = creating();
        return service.create(
          creation({
            variables: [
              { name: 'A', envVariable: 'VERSION' },
              { name: 'B', envVariable: 'VERSION' },
            ],
          }),
          1,
          context,
        );
      },
    ],
    [
      'renaming the key of a template the catalogue owns',
      409,
      () => {
        const { service, prisma } = editing();
        prisma.row = templateRow({ key: 'paper' });
        return service.update(TEMPLATE_UUID, patch({ key: 'papermc' }), 1, context);
      },
    ],
    [
      'putting an RCON stop on a template whose node is too old',
      409,
      () => {
        const { service, prisma } = editing({ capabilities: [] });
        prisma.nodes = [{ uuid: 'node-uuid', name: 'node-1' }];
        return service.update(TEMPLATE_UUID, patch({ stop: RCON_STOP }), 1, context);
      },
    ],
    [
      'putting an RCON stop on a template whose node does not answer',
      503,
      () => {
        const { service, prisma } = editing({ capabilities: null });
        prisma.nodes = [{ uuid: 'node-uuid', name: 'node-1' }];
        return service.update(TEMPLATE_UUID, patch({ stop: RCON_STOP }), 1, context);
      },
    ],
    [
      'putting an RCON stop on a template whose servers name no such port',
      409,
      () => rconOnly().service.update(TEMPLATE_UUID, patch({ stop: RCON_STOP }), 1, context),
    ],
    [
      'deleting a template servers were built from',
      409,
      () => editing({ servers: [serverRow()] }).service.remove(TEMPLATE_UUID, 1, context),
    ],
    ['deleting a template nobody has', 404, () => editing().service.remove('unknown', 1, context)],
    ['reading a template nobody has', 404, () => editing().service.findDetailByUuid('unknown')],
    [
      'creating a group under a name that exists',
      409,
      () =>
        editing().service.createGroup({ name: 'Tests', description: '', author: '' }, 1, context),
    ],
    [
      'renaming a group the catalogue installs into',
      409,
      () =>
        editing({ groups: [groupRow({ name: 'Minecraft: Java Edition' })] }).service.updateGroup(
          GROUP_UUID,
          { name: 'Java' },
          1,
          context,
        ),
    ],
    [
      'deleting a group that still holds templates',
      409,
      () => editing().service.removeGroup(GROUP_UUID, 1, context),
    ],
    [
      'editing a group nobody has',
      404,
      () => editing().service.updateGroup('unknown', { author: 'Me' }, 1, context),
    ],
    [
      'deleting a group nobody has',
      404,
      () => editing().service.removeGroup('unknown', 1, context),
    ],
  ])('answers %s with %i', async (_case, status, run) => {
    expect(await statusOf(run)).toBe(status);
  });
});

/**
 * Exporting a template as a file another installation can read.
 *
 * The round trip is what is asserted, and it is asserted through the importer
 * rather than against a fixture: the two functions are each other's inverse and
 * a fixture would only pin down whichever one was written second. What this
 * adds over the exporter's own suite is the half that lives here — the mapping
 * from a database row to the definition it exports, which is the piece that
 * silently loses a column when one is added.
 */
describe('TemplateEditorService.exportEgg', () => {
  it('brings back everything the row holds, through the file', async () => {
    const { service } = editing();

    const egg = await service.exportEgg(TEMPLATE_UUID);
    const { template } = importPterodactylEgg(JSON.parse(JSON.stringify(egg)) as unknown, {
      group: 'Tests',
    });

    expect(template.key).toBe('my-egg');
    expect(template.name).toBe('My egg');
    expect(template.startup).toBe('./start.sh');
    expect(template.installScript).toBe('set -e\ncurl -sSL https://example.invalid -o server.jar');
    expect(template.configFiles).toEqual([
      { file: 'server.properties', parser: 'properties', replacements: [] },
    ]);
    expect(template.fileDenylist).toEqual(['secrets/**']);
  });

  /**
   * The variable the read view hides.
   *
   * `TemplatesService.toView` filters out anything not `userViewable`, because
   * an internal build flag is not something an operator picking a template
   * should be offered. An export built on that view — the obvious shortcut,
   * since the route sits beside `findDetail` — would drop the flag from the
   * file and the template would arrive somewhere else missing the variable its
   * install script reads.
   */
  it('carries the variables an operator is never shown', async () => {
    const { service } = editing();

    const egg = await service.exportEgg(TEMPLATE_UUID);
    const { template } = importPterodactylEgg(JSON.parse(JSON.stringify(egg)) as unknown, {
      group: 'Tests',
    });

    expect(template.variables.map((variable) => variable.envVariable)).toEqual([
      'VERSION',
      'BUILD_PATH',
    ]);
    expect(template.variables[1]?.userViewable).toBe(false);
    expect(template.variables[1]?.defaultValue).toBe('/opt');
  });

  it('names the egg the template was imported from', async () => {
    const { service } = editing();

    // Provenance survives the trip through a file: a template that came from an
    // egg does not become hand-written by being exported.
    expect((await service.exportEgg(TEMPLATE_UUID)).uuid).toBe(
      'e0e0e0e0-0000-4000-8000-000000000000',
    );
  });

  it('does not export a template that is not there', async () => {
    const { service } = editing();

    await expect(service.exportEgg('00000000-0000-4000-8000-000000000000')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });
});
