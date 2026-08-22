import { ConflictException, UnprocessableEntityException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { beforeEach, describe, expect, it } from 'vitest';
import type { PrismaService } from '../../prisma/prisma.service.js';
import { IdempotencyService } from './idempotency.service.js';

/**
 * The protocol under test is three steps — claim, settle, release — and what
 * makes it worth testing is that every interesting case is a *second* call
 * arriving while the first is somewhere in the middle.
 *
 * The store is a real Map behind the same unique constraint PostgreSQL
 * enforces, including the `P2002` it raises, because the whole design rests on
 * losing that race being a normal outcome rather than an error.
 */

interface Row {
  id: number;
  applicationKeyId: number;
  key: string;
  requestHash: string;
  status: number | null;
  response: unknown;
  expiresAt: Date;
}

function store() {
  const rows = new Map<string, Row>();
  let nextId = 1;

  const identify = (applicationKeyId: number, key: string): string => `${applicationKeyId}:${key}`;

  const prisma = {
    idempotentRequest: {
      create: ({ data }: { data: Omit<Row, 'id' | 'status' | 'response'> }) => {
        const id = identify(data.applicationKeyId, data.key);

        if (rows.has(id)) {
          return Promise.reject(
            new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
              code: 'P2002',
              clientVersion: 'test',
            }),
          );
        }

        const row: Row = { ...data, id: nextId++, status: null, response: null };
        rows.set(id, row);
        return Promise.resolve(row);
      },
      findUnique: ({
        where,
      }: {
        where: { applicationKeyId_key: { applicationKeyId: number; key: string } };
      }) =>
        Promise.resolve(
          rows.get(
            identify(where.applicationKeyId_key.applicationKeyId, where.applicationKeyId_key.key),
          ) ?? null,
        ),
      update: ({
        where,
        data,
      }: {
        where: { applicationKeyId_key: { applicationKeyId: number; key: string } };
        data: { status: number; response: unknown };
      }) => {
        const id = identify(
          where.applicationKeyId_key.applicationKeyId,
          where.applicationKeyId_key.key,
        );
        const row = rows.get(id);

        if (!row) {
          return Promise.reject(new Error('Row not found'));
        }

        Object.assign(row, data);
        return Promise.resolve(row);
      },
      deleteMany: ({
        where,
      }: {
        where: {
          applicationKeyId?: number;
          key?: string;
          status?: null;
          id?: { in: number[] };
        };
      }) => {
        for (const [id, row] of [...rows]) {
          const matchesKey =
            where.applicationKeyId === undefined ||
            (row.applicationKeyId === where.applicationKeyId && row.key === where.key);
          const matchesStatus = where.status === undefined || row.status === null;
          const matchesId = where.id === undefined || where.id.in.includes(row.id);

          if (matchesKey && matchesStatus && matchesId) {
            rows.delete(id);
          }
        }

        return Promise.resolve({ count: 0 });
      },
      findMany: ({ where }: { where: { expiresAt: { lt: Date } } }) =>
        Promise.resolve(
          [...rows.values()]
            .filter((row) => row.expiresAt < where.expiresAt.lt)
            .map((row) => ({ id: row.id })),
        ),
    },
  } as unknown as PrismaService;

  return { prisma, rows };
}

let service: IdempotencyService;
let rows: Map<string, Row>;

beforeEach(() => {
  const created = store();
  rows = created.rows;
  service = new IdempotencyService(created.prisma);
});

const KEY = 1;
const BODY = { plan: 'minecraft-4gb', name: 'Survival', owner: { email: 'a@example.com' } };

describe('claiming a key', () => {
  it('lets the first attempt through', async () => {
    await expect(service.claim(KEY, 'order-1041', BODY)).resolves.toEqual({ replayed: false });
  });

  it('replays what the first attempt answered', async () => {
    await service.claim(KEY, 'order-1041', BODY);
    await service.settle(KEY, 'order-1041', 201, { uuid: 'server-uuid' });

    await expect(service.claim(KEY, 'order-1041', BODY)).resolves.toEqual({
      replayed: true,
      status: 201,
      body: { uuid: 'server-uuid' },
    });
  });

  it('tells a second call the first is still running rather than starting a second server', async () => {
    // Answered rather than waited on: provisioning takes seconds, and a
    // request held open for them is a second connection held, a second timeout
    // armed, and usually a third request.
    await service.claim(KEY, 'order-1041', BODY);

    await expect(service.claim(KEY, 'order-1041', BODY)).rejects.toBeInstanceOf(ConflictException);
  });

  it('refuses a key reused for a different request', async () => {
    // Replaying the first server's details here would hide a caller's bug —
    // usually a key derived from something less unique than they thought —
    // until an audit found two customers sharing a machine.
    await service.claim(KEY, 'order-1041', BODY);
    await service.settle(KEY, 'order-1041', 201, { uuid: 'server-uuid' });

    await expect(
      service.claim(KEY, 'order-1041', { ...BODY, name: 'Creative' }),
    ).rejects.toBeInstanceOf(UnprocessableEntityException);
  });

  it('does not let two integrations read each other’s answers', async () => {
    // `order-1041` is a value both of them would pick.
    await service.claim(1, 'order-1041', BODY);
    await service.settle(1, 'order-1041', 201, { uuid: 'one' });

    await expect(service.claim(2, 'order-1041', BODY)).resolves.toEqual({ replayed: false });
  });
});

describe('the shape of the request, not the order it was written in', () => {
  it('treats reordered fields as the same request', async () => {
    await service.claim(KEY, 'order-1041', { a: 1, b: 2 });
    await service.settle(KEY, 'order-1041', 201, { uuid: 'server-uuid' });

    // A client that serialises its object in another order is not making a
    // different request, and refusing it would be a retry lost to a JSON
    // library.
    await expect(service.claim(KEY, 'order-1041', { b: 2, a: 1 })).resolves.toMatchObject({
      replayed: true,
    });
  });

  it('treats a reordered array as a different one', async () => {
    await service.claim(KEY, 'k', { ports: [1, 2] });
    await service.settle(KEY, 'k', 201, {});

    await expect(service.claim(KEY, 'k', { ports: [2, 1] })).rejects.toBeInstanceOf(
      UnprocessableEntityException,
    );
  });

  it('gives different bodies different fingerprints', () => {
    expect(service.fingerprint({ a: 1 })).not.toBe(service.fingerprint({ a: 2 }));
    expect(service.fingerprint({ a: 1, b: 2 })).toBe(service.fingerprint({ b: 2, a: 1 }));
  });
});

describe('releasing a key whose attempt failed', () => {
  it('lets the caller try again', async () => {
    // The call that failed is the one a billing system most needs to repeat —
    // the node was in maintenance, the daemon was restarting. A key answering
    // "500" for a day would turn a transient failure into an unsellable order.
    await service.claim(KEY, 'order-1041', BODY);
    await service.release(KEY, 'order-1041');

    await expect(service.claim(KEY, 'order-1041', BODY)).resolves.toEqual({ replayed: false });
  });

  it('leaves a settled answer alone', async () => {
    // Releasing after a success would be a bug, and it must not delete the
    // record that stops the next retry creating a second server.
    await service.claim(KEY, 'order-1041', BODY);
    await service.settle(KEY, 'order-1041', 201, { uuid: 'server-uuid' });
    await service.release(KEY, 'order-1041');

    await expect(service.claim(KEY, 'order-1041', BODY)).resolves.toMatchObject({
      replayed: true,
    });
  });
});

describe('expiry', () => {
  it('purges what is past its window', async () => {
    await service.claim(KEY, 'old', BODY);
    await service.settle(KEY, 'old', 201, {});

    const row = rows.get(`${KEY}:old`)!;
    row.expiresAt = new Date(Date.now() - 1000);

    // The purge runs on the next claim. It is bounded on purpose: an instance
    // back after a month of downtime must not pay for a million-row delete on
    // the first sale of the morning.
    await service.claim(KEY, 'new', BODY);

    expect(rows.has(`${KEY}:old`)).toBe(false);
  });
});
