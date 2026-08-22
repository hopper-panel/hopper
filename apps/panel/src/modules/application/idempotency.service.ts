import { createHash } from 'node:crypto';
import { ConflictException, Injectable, UnprocessableEntityException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service.js';

/**
 * Replaying a provisioning call instead of repeating it.
 *
 * The caller names an attempt with an `Idempotency-Key` header; the answer to
 * the first attempt is stored and handed back to every repeat of it. What this
 * protects against is not a caller pressing a button twice — it is the retry
 * that follows a timeout, where the caller genuinely cannot tell "the request
 * never arrived" from "it arrived, it worked, and the answer was lost". Without
 * this, the safe-looking choice (retry) creates a second server and a second
 * invoice, and the other choice (do not retry) silently loses a purchase.
 */

/**
 * How long a key means something.
 *
 * A day covers every retry a billing system makes — they give up in minutes —
 * and keeping them for ever would turn a table nobody reads into the biggest
 * one in the database.
 */
const RETENTION_MS = 24 * 60 * 60 * 1000;

/**
 * Rows purged per call.
 *
 * Bounded, because the purge runs inside a customer's purchase: an instance
 * coming back after a month of downtime must not pay for a million-row delete
 * on the first sale of the morning. At a few per call it catches up within the
 * hour, and nothing depends on it having caught up.
 */
const PURGE_BATCH = 100;

export type IdempotentOutcome =
  { replayed: true; status: number; body: unknown } | { replayed: false };

@Injectable()
export class IdempotencyService {
  constructor(private readonly prisma: PrismaService) {}

  /** Digest of a request body, as stored and compared. */
  fingerprint(body: unknown): string {
    return createHash('sha256').update(stableStringify(body)).digest('hex');
  }

  /**
   * Claims a key, or hands back what the first attempt answered.
   *
   * @throws {ConflictException} when a first attempt is still running, or when
   *   the key was used for a different request.
   */
  async claim(applicationKeyId: number, key: string, body: unknown): Promise<IdempotentOutcome> {
    void this.purgeExpired();

    const requestHash = this.fingerprint(body);
    const now = new Date();

    try {
      await this.prisma.idempotentRequest.create({
        data: {
          applicationKeyId,
          key,
          requestHash,
          expiresAt: new Date(now.getTime() + RETENTION_MS),
        },
      });

      return { replayed: false };
    } catch (error: unknown) {
      // P2002 is the unique index doing its job: somebody already claimed this
      // key. Anything else is not ours to interpret.
      if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== 'P2002') {
        throw error;
      }
    }

    const existing = await this.prisma.idempotentRequest.findUnique({
      where: { applicationKeyId_key: { applicationKeyId, key } },
    });

    if (!existing) {
      // Expired and purged between the failed insert and this read. Rare
      // enough to be worth no machinery: the caller retries and claims it
      // cleanly.
      throw new ConflictException(
        'This idempotency key expired while the request was being handled. Retry it.',
      );
    }

    if (existing.requestHash !== requestHash) {
      // Refused rather than answered. Replaying the first server's details
      // here would hide a caller's bug — a key derived from something less
      // unique than they thought — until an audit found two customers sharing
      // a machine.
      throw new UnprocessableEntityException(
        'This idempotency key was used for a different request. Use a new key, or send the original body.',
      );
    }

    if (existing.status === null) {
      // The first attempt is still running. Answering "in flight" rather than
      // waiting on it: a provisioning call can take twenty seconds, and a
      // second request held open for twenty seconds is a second connection
      // held, a second timeout armed, and usually a third request.
      throw new ConflictException(
        'A request with this idempotency key is still being handled. Retry in a moment.',
      );
    }

    return { replayed: true, status: existing.status, body: existing.response };
  }

  /** Records what the first attempt answered, for every repeat of it. */
  async settle(
    applicationKeyId: number,
    key: string,
    status: number,
    body: unknown,
  ): Promise<void> {
    await this.prisma.idempotentRequest.update({
      where: { applicationKeyId_key: { applicationKeyId, key } },
      data: { status, response: body as Prisma.InputJsonValue },
    });
  }

  /**
   * Releases a key whose attempt failed.
   *
   * Deliberately *not* storing the failure to replay it. A provisioning call
   * that failed is the one a billing system most needs to be able to make
   * again — the node was in maintenance, the daemon was restarting — and a key
   * that answered "500" for a day would turn a transient failure into an
   * unsellable order.
   */
  async release(applicationKeyId: number, key: string): Promise<void> {
    await this.prisma.idempotentRequest
      .deleteMany({ where: { applicationKeyId, key, status: null } })
      .catch(() => {
        // Nothing to release, or the row is already gone. Either way the
        // failure being reported to the caller matters more than this.
      });
  }

  private async purgeExpired(): Promise<void> {
    const expired = await this.prisma.idempotentRequest
      .findMany({
        where: { expiresAt: { lt: new Date() } },
        select: { id: true },
        take: PURGE_BATCH,
      })
      .catch(() => []);

    if (expired.length === 0) {
      return;
    }

    await this.prisma.idempotentRequest
      .deleteMany({ where: { id: { in: expired.map((row) => row.id) } } })
      .catch(() => undefined);
  }
}

/**
 * JSON with its object keys ordered.
 *
 * `JSON.stringify` preserves insertion order, so the same request serialised by
 * two versions of a client — or by one client that reordered a field — would
 * hash differently and be refused as "a different request". The comparison is
 * about what was asked, not about the order it was written in.
 */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value) ?? 'null';
  }

  if (Array.isArray(value)) {
    // Arrays keep their order: `[a, b]` and `[b, a]` are different requests.
    return `[${value.map((entry) => stableStringify(entry)).join(',')}]`;
  }

  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, entry]) => entry !== undefined)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([name, entry]) => `${JSON.stringify(name)}:${stableStringify(entry)}`);

  return `{${entries.join(',')}}`;
}
