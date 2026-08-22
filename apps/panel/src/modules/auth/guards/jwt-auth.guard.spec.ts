import type { ExecutionContext } from '@nestjs/common';
import type { Reflector } from '@nestjs/core';
import { describe, expect, it, vi } from 'vitest';
import type { PrismaService } from '../../../prisma/prisma.service.js';
import type { ApiKeysService } from '../../api-keys/api-keys.service.js';
import { generateApplicationKey } from '../../application/application-key.js';
import type { ApplicationKeysService } from '../../application/application-keys.service.js';
import {
  IS_APPLICATION_API_KEY,
  IS_PUBLIC_KEY,
  REQUIRED_ROLE_KEY,
  UNGOVERNED_APPLICATION_ROUTE,
} from '../decorators.js';
import type { AuthenticatedRequest } from '../request-user.js';
import type { TokenService } from '../token.service.js';
import { JwtAuthGuard } from './jwt-auth.guard.js';

/**
 * What is under test here is one property, and it is the reason the
 * application API can be handed to a third party's software at all: the two
 * kinds of credential do not overlap.
 *
 * An application key opens `/api/application` and nothing else — so the
 * credential most likely to leak, the one sitting in a billing server's
 * configuration file, cannot read a customer's files or open a console.
 *
 * And the application routes open to nothing else — so an integration cannot
 * be half-built on an administrator's browser session or on a personal key that
 * dies with its owner's account, and discover the difference on the day it
 * stops provisioning.
 *
 * Both directions have to be tested, because each is enforced by a separate
 * branch and either could be deleted without the other failing.
 */

const APPLICATION_TOKEN = generateApplicationKey().token;
const PERSONAL_TOKEN = `hpk_${'a'.repeat(16)}.${'b'.repeat(48)}`;
const SESSION_TOKEN = 'a.session.jwt';

interface HarnessOptions {
  /** Metadata the route carries: `@ApplicationApi()`, `@Public()`, `@AdminOnly()`. */
  metadata?: Record<string, unknown>;
  /** What the application key service answers. `null` refuses. */
  application?: { id: number; uuid: string; name: string; permissions: string[] } | null;
  method?: string;
}

function harness(options: HarnessOptions = {}) {
  const metadata = options.metadata ?? {};

  const reflector = {
    getAllAndOverride: (key: string) => metadata[key],
  } as unknown as Reflector;

  const applicationKeys = {
    authenticate: vi.fn(() =>
      Promise.resolve(
        options.application === undefined
          ? {
              id: 1,
              uuid: 'a-uuid',
              name: 'Paymenter',
              permissions: ['servers:write', 'plans:read'],
            }
          : options.application,
      ),
    ),
  } as unknown as ApplicationKeysService;

  const apiKeys = {
    authenticate: vi.fn(() =>
      Promise.resolve({
        id: 7,
        scopes: ['read', 'write'],
        user: {
          id: 3,
          uuid: 'user-uuid',
          username: 'julien',
          email: 'julien@example.com',
          role: 'ADMIN' as const,
        },
      }),
    ),
  } as unknown as ApiKeysService;

  // Answers "valid" to anything, so a test that expects a refusal cannot be
  // passing because the session branch happened to fail on its own.
  const tokens = {
    verifyAccessToken: vi.fn(() => Promise.resolve({ sub: 'user-uuid', sid: '1' })),
  } as unknown as TokenService;

  const prisma = {
    session: {
      findFirst: vi.fn(() =>
        Promise.resolve({
          user: {
            id: 3,
            uuid: 'user-uuid',
            username: 'julien',
            email: 'julien@example.com',
            role: 'ADMIN',
            suspended: false,
          },
        }),
      ),
    },
  } as unknown as PrismaService;

  const guard = new JwtAuthGuard(reflector, tokens, prisma, apiKeys, applicationKeys);

  const run = async (
    token: string,
  ): Promise<{ allowed: boolean; request: AuthenticatedRequest }> => {
    const request = {
      headers: { authorization: `Bearer ${token}` },
      method: options.method ?? 'GET',
      url: '/api/application/servers',
      ip: '203.0.113.7',
      cookies: {},
    } as unknown as AuthenticatedRequest;

    const context = {
      switchToHttp: () => ({ getRequest: () => request }),
      getHandler: () => undefined,
      getClass: () => undefined,
    } as unknown as ExecutionContext;

    const allowed = await guard.canActivate(context);
    return { allowed, request };
  };

  return { run, applicationKeys, apiKeys };
}

describe('an application key reaches the application API and nothing else', () => {
  it('is accepted on a route marked @ApplicationApi()', async () => {
    const { run } = harness({ metadata: { [IS_APPLICATION_API_KEY]: 'servers' } });

    const { allowed, request } = await run(APPLICATION_TOKEN);

    expect(allowed).toBe(true);
    expect(request.application).toEqual({
      id: 1,
      uuid: 'a-uuid',
      name: 'Paymenter',
      permissions: ['servers:write', 'plans:read'],
    });
  });

  it('leaves request.user unset, so nothing downstream reads it as a person', async () => {
    // The audit log names an actor from `request.user`, and an ownership check
    // decides on one. A fabricated user would make both answer about somebody
    // who was not there.
    const { run } = harness({ metadata: { [IS_APPLICATION_API_KEY]: 'servers' } });

    const { request } = await run(APPLICATION_TOKEN);

    expect(request.user).toBeUndefined();
  });

  it('is refused everywhere else, and told why', async () => {
    const { run, applicationKeys } = harness({ metadata: {} });

    await expect(run(APPLICATION_TOKEN)).rejects.toThrow(/only opens \/api\/application/);

    // Refused before the key is even looked up: an application key presented
    // to `/api/servers` is a wrong route, not a wrong credential, and there is
    // no reason to spend a query confirming it exists.
    expect(applicationKeys.authenticate).not.toHaveBeenCalled();
  });

  it('is refused on an administration route, which is the one worth stating', async () => {
    // `/api/admin/application-keys` is where keys are made. A key able to
    // reach it could mint another of its own kind, turning one leak into a
    // foothold that survives revoking the leaked key.
    const { run } = harness({ metadata: { [REQUIRED_ROLE_KEY]: 'ADMIN' } });

    await expect(run(APPLICATION_TOKEN)).rejects.toThrow(/only opens \/api\/application/);
  });

  it('is refused when the service refuses it, without saying which check failed', async () => {
    const { run } = harness({
      metadata: { [IS_APPLICATION_API_KEY]: 'servers' },
      application: null,
    });

    await expect(run(APPLICATION_TOKEN)).rejects.toThrow(/invalid, expired or revoked/);
  });

  it('is refused when its permission on this resource does not cover the verb', async () => {
    const { run } = harness({
      metadata: { [IS_APPLICATION_API_KEY]: 'servers' },
      application: { id: 1, uuid: 'a-uuid', name: 'Status page', permissions: ['servers:read'] },
      method: 'POST',
    });

    // The resource is named, and the level with it: "insufficient permissions"
    // sends an integrator to re-read the whole matrix, this sends them to one
    // line of it.
    await expect(run(APPLICATION_TOKEN)).rejects.toThrow(/read & write on servers/);
  });

  it('is refused on a resource it was granted nothing on, even holding another', async () => {
    // The reason the matrix exists at all.
    const { run } = harness({
      metadata: { [IS_APPLICATION_API_KEY]: 'servers' },
      application: { id: 1, uuid: 'a-uuid', name: 'Status page', permissions: ['plans:read'] },
      method: 'GET',
    });

    await expect(run(APPLICATION_TOKEN)).rejects.toThrow(/read on servers/);
  });

  it('lets a key with nothing granted still check itself', async () => {
    // `instance` is how an integrator finds out a key works at all. Governing
    // it by a permission would mean a key granted nothing cannot even be told
    // apart from a key that is wrong.
    const { run } = harness({
      metadata: { [IS_APPLICATION_API_KEY]: UNGOVERNED_APPLICATION_ROUTE },
      application: { id: 1, uuid: 'a-uuid', name: 'Fresh', permissions: [] },
    });

    await expect(run(APPLICATION_TOKEN)).resolves.toMatchObject({ allowed: true });
  });
});

describe('the application API opens to nothing but an application key', () => {
  it('refuses a browser session, and names the credential to use', async () => {
    const { run } = harness({ metadata: { [IS_APPLICATION_API_KEY]: 'servers' } });

    await expect(run(SESSION_TOKEN)).rejects.toThrow(/application key \(hpa_…\)/);
  });

  it('refuses a personal API key, even an administrator’s', async () => {
    const { run, apiKeys } = harness({ metadata: { [IS_APPLICATION_API_KEY]: 'servers' } });

    await expect(run(PERSONAL_TOKEN)).rejects.toThrow(/application key \(hpa_…\)/);
    expect(apiKeys.authenticate).not.toHaveBeenCalled();
  });

  it('still lets a public route through untouched', async () => {
    // `@Public()` is read first and stays first: the application check must not
    // start demanding a credential on the health endpoint.
    const { run } = harness({
      metadata: { [IS_PUBLIC_KEY]: true, [IS_APPLICATION_API_KEY]: 'servers' },
    });

    await expect(run(SESSION_TOKEN)).resolves.toEqual(expect.objectContaining({ allowed: true }));
  });
});
