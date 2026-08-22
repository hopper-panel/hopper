import type { StatusReport } from '@hopper/shared';
import { describe, expect, it, vi } from 'vitest';
import type { PrismaService } from '../../prisma/prisma.service.js';
import { AUDIT_EVENTS, type AuditService } from '../audit/audit.service.js';
import type { BackupsService } from '../backups/backups.service.js';
import type { ServerConfigurationService } from '../servers/server-configuration.service.js';
import { WEBHOOK_EVENTS } from '../webhooks/events.js';
import type { InstanceWebhooksService } from '../webhooks/instance-webhooks.service.js';
import type { WebhooksService } from '../webhooks/webhooks.service.js';
import type { RemoteRequest } from './remote-node.guard.js';
import type { SftpAuthService } from './sftp-auth.service.js';
import { RemoteController, describeStop } from './remote.controller.js';

/**
 * What the recipient of a crash notification is told.
 *
 * This sentence is the whole of what most operators ever see about a stop:
 * the console it happened in is not open, and the panel does not store the
 * state. Getting it wrong sends somebody looking for a crash that never
 * happened.
 */

const report = (fields: Partial<StatusReport>): StatusReport => ({
  state: 'offline',
  at: Date.now(),
  expected: false,
  oomKilled: false,
  ...fields,
});

describe('describeStop', () => {
  it('names Hopper when Hopper is what stopped the server', () => {
    // The daemon stops a server whose readiness never confirmed. Reported as
    // "the process stopped on its own", that is a lie about who did it — and
    // it came with the exit code of the SIGTERM the daemon had just sent.
    expect(describeStop(report({ cause: 'readiness_failed', exitCode: 143 }))).toContain('Hopper');
  });

  it('points at the console, where the actual reason is', () => {
    // The daemon prints the precise line before giving up — which pattern
    // never matched, which port never answered. The notification says who
    // stopped the server and where to read why, rather than trying to be both.
    expect(describeStop(report({ cause: 'readiness_failed' }))).toContain('console');
  });

  it('keeps the old sentence for a daemon that sends no cause', () => {
    // The degradation that matters: a node running a daemon older than the
    // field sends nothing, and the notification is the one this panel has
    // always produced. Less precise, never missing.
    expect(describeStop(report({}))).toBe('the process stopped on its own');
  });

  it('still puts running out of memory first', () => {
    // The kernel killing the container explains a stop nobody understands, and
    // it outranks everything else: a readiness check that never confirmed
    // because the server was being killed is a symptom, not the cause.
    expect(describeStop(report({ oomKilled: true, cause: 'readiness_failed' }))).toContain(
      'out of memory',
    );
  });
});

/**
 * A stop the daemon would not deliver.
 *
 * The only report that arrives without a transition behind it: the server is
 * still running, and saying so is the point. Every branch of this handler was
 * written for a state the server had just moved into, and the first of them
 * would announce that a server had started — to an operator whose stop had just
 * silently failed.
 */
interface AuditEntry {
  event: string;
  serverId: number;
  metadata: Record<string, unknown>;
}

function controller() {
  const record = vi.fn((_entry: AuditEntry) => Promise.resolve());
  const dispatch = vi.fn();
  /** The instance-wide subscribers, which hear the same installation report. */
  const dispatchForServer = vi.fn();

  const prisma = {
    server: { findFirst: vi.fn(() => Promise.resolve({ id: 7, name: 'Test' })) },
  } as unknown as PrismaService;

  const instance = new RemoteController(
    {} as unknown as ServerConfigurationService,
    prisma,
    { record } as unknown as AuditService,
    {} as unknown as SftpAuthService,
    {} as unknown as BackupsService,
    { dispatch } as unknown as WebhooksService,
    { dispatchForServer } as unknown as InstanceWebhooksService,
  );

  return { instance, record, dispatch, dispatchForServer };
}

const fromNode = { node: { id: 1, name: 'node-1' } } as unknown as RemoteRequest;

describe('a refused stop reported by a daemon', () => {
  it('is recorded as a power action that did not happen', async () => {
    const { instance, record, dispatch } = controller();

    await instance.reportStatus(
      'server-uuid',
      report({ state: 'running', cause: 'stop_refused' }),
      fromNode,
    );

    const entry = record.mock.calls[0]?.[0];

    expect(entry?.event).toBe(AUDIT_EVENTS.SERVER_POWER);
    expect(entry?.serverId).toBe(7);
    expect(entry?.metadata).toMatchObject({ action: 'stop', refused: true });
    // The regression this guard exists for: without it the running branch fires
    // and the operator is told their server started, moments after the stop
    // they asked for was refused.
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('leaves an ordinary start alone', async () => {
    const { instance, record, dispatch } = controller();

    await instance.reportStatus(
      'server-uuid',
      report({ state: 'running', expected: true }),
      fromNode,
    );

    expect(dispatch).toHaveBeenCalledWith(7, WEBHOOK_EVENTS.SERVER_STARTED);
    expect(record).not.toHaveBeenCalled();
  });
});
