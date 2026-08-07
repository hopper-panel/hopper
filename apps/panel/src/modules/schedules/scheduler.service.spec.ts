import { describe, expect, it, vi } from 'vitest';
import type { PrismaService } from '../../prisma/prisma.service.js';
import { AUDIT_EVENTS, type AuditService } from '../audit/audit.service.js';
import type { BackupsService } from '../backups/backups.service.js';
import type { NodeClientService } from '../nodes/node-client.service.js';
import type { NodesService } from '../nodes/nodes.service.js';
import { SchedulerService } from './scheduler.service.js';

/**
 * What a scheduled run leaves behind when a command did not reach the server.
 *
 * The whole point of making `sendCommand` fail is that somebody eventually
 * reads about it, and a scheduled task is the case where nobody is watching the
 * console: it runs at four in the morning, its output scrolls past in a buffer
 * of five hundred lines, and the audit record is the only durable trace. A
 * failure swallowed anywhere between the daemon and this record is the same
 * no-op as before, moved.
 *
 * These tests drive `tick` rather than the private `execute`, so the claim, the
 * run and the record are exercised as one — a failure that threw out of the run
 * and skipped the record would pass a narrower test.
 */

const SCHEDULE = {
  id: 1,
  uuid: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  name: 'Nightly save',
  onlyWhenOnline: false,
  serverId: 7,
  cronMinute: '0',
  cronHour: '4',
  cronDayOfMonth: '*',
  cronMonth: '*',
  cronDayOfWeek: '*',
  server: { uuid: 'server-uuid', node: { uuid: 'node-uuid' } },
  tasks: [
    {
      sequence: 0,
      action: 'COMMAND',
      payload: 'save-all',
      offsetSeconds: 0,
      continueOnFailure: false,
    },
  ],
};

function scheduler(sendCommands: () => Promise<void>) {
  const record = vi.fn(() => Promise.resolve());

  const prisma = {
    schedule: {
      findMany: vi.fn(() => Promise.resolve([{ id: 1, uuid: SCHEDULE.uuid, name: SCHEDULE.name }])),
      // The claim: the database arbitrates, and this run is the one that won.
      updateMany: vi.fn(() => Promise.resolve({ count: 1 })),
      findUnique: vi.fn(() => Promise.resolve(SCHEDULE)),
      update: vi.fn(() => Promise.resolve(SCHEDULE)),
    },
  } as unknown as PrismaService;

  const nodes = {
    getConnection: () => Promise.resolve({ uuid: 'node-uuid', url: 'https://n', token: 'a.b' }),
  } as unknown as NodesService;

  const client = { sendCommands: vi.fn(sendCommands) } as unknown as NodeClientService;
  const audit = { record } as unknown as AuditService;

  return {
    record,
    service: new SchedulerService(prisma, nodes, client, {} as unknown as BackupsService, audit),
  };
}

/** The `failures` array of the run's audit record, whatever else it holds. */
function failuresOf(record: ReturnType<typeof vi.fn>): string[] {
  const entry = record.mock.calls[0]?.[0] as
    { event: string; metadata: { failures: string[] } } | undefined;

  expect(entry?.event).toBe(AUDIT_EVENTS.SCHEDULE_RUN);

  return entry?.metadata.failures ?? [];
}

describe('a scheduled command the server never received', () => {
  it('is recorded as a failure of the run', async () => {
    // The regression guard. Before the console had a transport of its own, this
    // path resolved: the daemon wrote into a pty nobody reads, answered 204,
    // and the run was recorded with an empty `failures` array — indistinguishable
    // from a world that was actually saved.
    const { service, record } = scheduler(() =>
      Promise.reject(
        new Error(
          'The daemon refused the operation (HTTP 502): The command "save-all" was not delivered: the variable RCON_PASSWORD holds this server\'s RCON password and is not set.',
        ),
      ),
    );

    await service.tick();

    const failures = failuresOf(record);

    expect(failures).toHaveLength(1);
    // Named down to what has to change: a failure an operator cannot act on is
    // barely better than none.
    expect(failures[0]).toContain('step 1 (COMMAND)');
    expect(failures[0]).toContain('RCON_PASSWORD');
  });

  it('records nothing when the command was delivered', async () => {
    // The other half of the guard: a run whose `failures` is empty has to mean
    // something, which it only does if a failure would have shown up there.
    const { service, record } = scheduler(() => Promise.resolve());

    await service.tick();

    expect(failuresOf(record)).toEqual([]);
  });
});
