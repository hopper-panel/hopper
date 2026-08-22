import 'reflect-metadata';

import { ConflictException, NotFoundException } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { PrismaService } from '../../prisma/prisma.service.js';
import { ApiKeysService } from '../api-keys/api-keys.service.js';
import { ApplicationKeysService } from '../application/application-keys.service.js';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard.js';
import { TokenService } from '../auth/token.service.js';
import { TemplateEditorService } from './template-editor.service.js';
import { TemplateSyncService } from './template-sync.service.js';
import { TemplatesController } from './templates.controller.js';
import { TemplatesService } from './templates.service.js';

/**
 * Who may reach these routes, and what the wire says when they do.
 *
 * Both halves were invisible to this suite. Deleting `@AdminOnly()` from the
 * controller left the whole panel green — 613 of 613 — while every write route
 * became reachable by any authenticated user: creating templates, editing the
 * install script every server on a node runs, deleting groups. And the status
 * codes were asserted nowhere, so `@HttpCode(HttpStatus.NO_CONTENT)` could go
 * from either DELETE and a refusal could turn from a 409 into a 500 without a
 * test noticing.
 *
 * So this drives the **real** `JwtAuthGuard` through a real Fastify router,
 * rather than reading the decorator's metadata back. Reading the metadata would
 * pass on a guard that had stopped honouring `REQUIRED_ROLE_KEY`, which is the
 * other half of the same hole — and the guard checks the role in two places,
 * once for a session and once for an API key, with a scope check in between
 * that only looks at the path. The services behind the controller are stubs:
 * what is under test is the door, not the room.
 */

const TEMPLATE_UUID = '6f1c2f4a-8f43-4d31-9d1b-9e2b7c2f0f11';
const GROUP_UUID = 'c4b6a5c8-2a1e-4c8f-9a52-2c2b0d5f7e10';

/** A well-formed key: `hpk_<16>.<48>`, which is what `parseApiKey` insists on. */
const ADMIN_KEY = `hpk_${'a'.repeat(16)}.${'b'.repeat(48)}`;

const user = (role: 'ADMIN' | 'USER') => ({
  id: role === 'ADMIN' ? 1 : 2,
  uuid: `user-${role}`,
  username: role.toLowerCase(),
  email: `${role.toLowerCase()}@example.invalid`,
  role,
  suspended: false,
});

const detailView = {
  uuid: TEMPLATE_UUID,
  key: 'my-egg',
  group: { uuid: GROUP_UUID, name: 'Tests' },
  name: 'My egg',
};

const groupView = { uuid: GROUP_UUID, name: 'Tests', templateCount: 0 };

const templateBody = {
  key: 'my-egg',
  group: 'Tests',
  name: 'My egg',
  dockerImages: [{ name: 'Java 21', image: 'eclipse-temurin:21-jre-noble' }],
  startup: './start.sh',
  installScript: 'set -e',
};

/**
 * Every route the controller declares, with a body that gets past its pipe.
 *
 * Listed rather than sampled: `@AdminOnly()` sits on the class, so a route
 * added later inherits it — and the only thing that notices a route added
 * *without* inheriting it is a test that walks the whole list.
 */
const ROUTES = [
  { method: 'GET' as const, url: '/api/admin/templates/groups' },
  { method: 'POST' as const, url: '/api/admin/templates/groups', body: { name: 'Modpacks' } },
  { method: 'PATCH' as const, url: `/api/admin/templates/groups/${GROUP_UUID}`, body: {} },
  { method: 'DELETE' as const, url: `/api/admin/templates/groups/${GROUP_UUID}` },
  { method: 'GET' as const, url: '/api/admin/templates' },
  { method: 'GET' as const, url: `/api/admin/templates/${TEMPLATE_UUID}` },
  { method: 'GET' as const, url: `/api/admin/templates/${TEMPLATE_UUID}/detail` },
  // The export carries the install script and every variable's default value,
  // so it belongs behind the same door as the detail view above rather than
  // being a download anybody signed in could fetch.
  { method: 'GET' as const, url: `/api/admin/templates/${TEMPLATE_UUID}/export` },
  { method: 'POST' as const, url: '/api/admin/templates', body: templateBody },
  { method: 'PATCH' as const, url: `/api/admin/templates/${TEMPLATE_UUID}`, body: {} },
  { method: 'DELETE' as const, url: `/api/admin/templates/${TEMPLATE_UUID}` },
  { method: 'POST' as const, url: '/api/admin/templates/sync', body: {} },
  {
    method: 'POST' as const,
    url: '/api/admin/templates/import',
    body: { egg: {}, group: 'Tests' },
  },
];

const editor = {
  findDetailByUuid: vi.fn(() => Promise.resolve(detailView)),
  create: vi.fn(() => Promise.resolve(detailView)),
  update: vi.fn(() => Promise.resolve(detailView)),
  remove: vi.fn(() => Promise.resolve(undefined)),
  createGroup: vi.fn(() => Promise.resolve(groupView)),
  updateGroup: vi.fn(() => Promise.resolve(groupView)),
  removeGroup: vi.fn(() => Promise.resolve(undefined)),
};

const templates = {
  list: vi.fn(() => Promise.resolve([])),
  listGroups: vi.fn(() => Promise.resolve([])),
  findByUuid: vi.fn(() => Promise.resolve(detailView)),
  findByKey: vi.fn(() => Promise.resolve(detailView)),
};

const sync = {
  syncCatalog: vi.fn(() => Promise.resolve({ created: 0, updated: 0, skipped: 0 })),
  upsert: vi.fn(() => Promise.resolve('created' as const)),
};

/**
 * The three the guard itself needs. The session is looked up on every request
 * — that is what lets a sign-out take effect before the token expires — so the
 * role has to come back from here rather than from the token.
 */
const tokens = {
  verifyAccessToken: vi.fn((token: string) =>
    Promise.resolve(
      token === 'session-admin'
        ? { sid: '1', sub: 'user-ADMIN' }
        : token === 'session-user'
          ? { sid: '2', sub: 'user-USER' }
          : null,
    ),
  ),
};

const prisma = {
  session: {
    findFirst: vi.fn(({ where }: { where: { id: number } }) =>
      Promise.resolve({ user: user(where.id === 1 ? 'ADMIN' : 'USER') }),
    ),
  },
};

/** A key belonging to a non-administrator, carrying the `admin` scope. */
let keyRole: 'ADMIN' | 'USER' = 'USER';

const apiKeys = {
  authenticate: vi.fn(() =>
    Promise.resolve({ id: 3, scopes: ['read', 'write', 'admin'], user: user(keyRole) }),
  ),
};

/**
 * The guard injects this since application keys exist, and refuses every token
 * it is offered here: no route of this controller is an application route, so
 * an application key has nothing to do on one. Answering `null` rather than
 * omitting the provider keeps the guard whole — a test that stubs away half of
 * it stops testing the thing that runs in production.
 */
const applicationKeys = {
  authenticate: vi.fn(() => Promise.resolve(null)),
};

let app: NestFastifyApplication;

beforeAll(async () => {
  const moduleRef = await Test.createTestingModule({
    controllers: [TemplatesController],
    providers: [
      { provide: TemplatesService, useValue: templates },
      { provide: TemplateEditorService, useValue: editor },
      { provide: TemplateSyncService, useValue: sync },
      { provide: TokenService, useValue: tokens },
      { provide: PrismaService, useValue: prisma },
      { provide: ApiKeysService, useValue: apiKeys },
      { provide: ApplicationKeysService, useValue: applicationKeys },
      // Exactly how `AuthModule` registers it: globally, so that forgetting a
      // guard on a route is impossible rather than merely unlikely.
      { provide: APP_GUARD, useClass: JwtAuthGuard },
    ],
  }).compile();

  app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());

  await app.init();
  await app.getHttpAdapter().getInstance().ready();
});

afterAll(async () => {
  await app?.close();
});

const call = (
  route: {
    method: 'GET' | 'POST' | 'PATCH' | 'DELETE';
    url: string;
    body?: Record<string, unknown>;
  },
  token?: string,
) =>
  app.inject({
    method: route.method,
    url: route.url,
    ...(route.body === undefined ? {} : { payload: route.body }),
    ...(token === undefined ? {} : { headers: { authorization: `Bearer ${token}` } }),
  });

describe('TemplatesController — who gets in', () => {
  it.each(ROUTES.map((route) => [`${route.method} ${route.url}`, route] as const))(
    'refuses %s to a signed-in user who is not an administrator',
    async (_label, route) => {
      // Not a 401 and not a 404: the caller is authenticated and the route
      // exists. 403 is the answer, and it is the one the web interface reads to
      // decide the page is not theirs.
      const response = await call(route, 'session-user');

      expect(response.statusCode).toBe(403);
      expect(response.json<{ message: string }>().message).toBe(
        'This action is for administrators only.',
      );
    },
  );

  it.each(ROUTES.map((route) => [`${route.method} ${route.url}`, route] as const))(
    'refuses %s to an admin-scoped key belonging to a non-administrator',
    async (_label, route) => {
      // The scope check in front of this one passes: `scopeAllows` grants any
      // `/api/admin/` path to a key carrying `admin`, and says nothing about
      // the account behind it. The role is checked separately, from the
      // database, so demoting a user takes effect without revoking their keys
      // one by one — and this is the branch that does it.
      keyRole = 'USER';

      const response = await call(route, ADMIN_KEY);

      expect(response.statusCode).toBe(403);
    },
  );

  it('refuses a request carrying no credential at all', async () => {
    const response = await call(ROUTES[0]!);

    expect(response.statusCode).toBe(401);
  });

  it.each(ROUTES.map((route) => [`${route.method} ${route.url}`, route] as const))(
    'lets an administrator through to %s',
    async (_label, route) => {
      // The other half of the pair: a guard that refused everybody would pass
      // every test above and leave the feature unusable. Only the door is
      // asserted — the egg importer answers 400 to the empty egg posted above,
      // which is the room doing its job.
      const response = await call(route, 'session-admin');

      expect(response.statusCode).not.toBe(401);
      expect(response.statusCode).not.toBe(403);
    },
  );

  it('lets an administrator through on an admin-scoped key', async () => {
    keyRole = 'ADMIN';

    expect((await call(ROUTES[0]!, ADMIN_KEY)).statusCode).toBe(200);
  });
});

describe('TemplatesController — what the wire says', () => {
  it('answers a delete with 204 and no body', async () => {
    // A delete that answered 200 with an empty body is not merely untidy: the
    // web interface distinguishes the two, and `undefined` serialised into a
    // 200 is a response body of `""` that a JSON client throws on.
    const response = await call(
      { method: 'DELETE', url: `/api/admin/templates/${TEMPLATE_UUID}` },
      'session-admin',
    );

    expect(response.statusCode).toBe(204);
    expect(response.body).toBe('');
  });

  it('answers a group delete with 204 too', async () => {
    const response = await call(
      { method: 'DELETE', url: `/api/admin/templates/groups/${GROUP_UUID}` },
      'session-admin',
    );

    expect(response.statusCode).toBe(204);
    expect(response.body).toBe('');
  });

  it('answers a creation with 201', async () => {
    expect(
      (
        await call(
          { method: 'POST', url: '/api/admin/templates', body: templateBody },
          'session-admin',
        )
      ).statusCode,
    ).toBe(201);
    expect(
      (
        await call(
          { method: 'POST', url: '/api/admin/templates/groups', body: { name: 'Modpacks' } },
          'session-admin',
        )
      ).statusCode,
    ).toBe(201);
  });

  it('answers a resynchronisation with 200 rather than 201', async () => {
    // A POST that creates nothing. Nest's default for POST is 201, so this is
    // the one route where the decorator is saying something other than the
    // obvious.
    expect(
      (await call({ method: 'POST', url: '/api/admin/templates/sync', body: {} }, 'session-admin'))
        .statusCode,
    ).toBe(200);
  });

  it('turns a refusal the database would have raised into a 409', async () => {
    // `Server.templateId` is `onDelete: Restrict`. The service counts first so
    // the operator is told how many servers are in the way rather than handed a
    // P2003 as "Internal server error" — and this is the half of that which
    // decides whether the browser sees a conflict or a crash.
    editor.remove.mockRejectedValueOnce(
      new ConflictException('4 server(s) were built from this template.'),
    );

    const response = await call(
      { method: 'DELETE', url: `/api/admin/templates/${TEMPLATE_UUID}` },
      'session-admin',
    );

    expect(response.statusCode).toBe(409);
    expect(response.json<{ message: string }>().message).toMatch(/4 server/);
  });

  it('turns an unknown uuid into a 404', async () => {
    editor.findDetailByUuid.mockRejectedValueOnce(new NotFoundException('Template not found.'));

    expect(
      (
        await call(
          { method: 'GET', url: `/api/admin/templates/${TEMPLATE_UUID}/detail` },
          'session-admin',
        )
      ).statusCode,
    ).toBe(404);
  });

  it('refuses a body the schema will not take, before anything is written', async () => {
    const response = await call(
      { method: 'POST', url: '/api/admin/templates', body: { ...templateBody, key: 'Not A Key' } },
      'session-admin',
    );

    expect(response.statusCode).toBe(400);
    expect(editor.create).not.toHaveBeenCalledWith(
      expect.objectContaining({ key: 'Not A Key' }),
      expect.anything(),
      expect.anything(),
    );
  });

  it('routes the literal "groups" segment to the group list, not to a uuid', async () => {
    // `groups` is a plausible template uuid as far as the router is concerned,
    // and the declaration order is what settles it. Getting this wrong sends
    // every group request to `findByUuid`, which answers 404 for a page that
    // exists.
    templates.listGroups.mockClear();
    templates.findByUuid.mockClear();

    await call({ method: 'GET', url: '/api/admin/templates/groups' }, 'session-admin');

    expect(templates.listGroups).toHaveBeenCalled();
    expect(templates.findByUuid).not.toHaveBeenCalled();
  });
});
