import type { FastifyReply, FastifyRequest } from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import type { DaemonConfig } from '../config/schema.js';
import { createNodeTokenGuard } from './auth.js';

const TOKEN_ID = 'abcdefghijklmnop';
const TOKEN_SECRET = 'z'.repeat(64);

const config = {
  tokenId: TOKEN_ID,
  tokenSecret: TOKEN_SECRET,
} as DaemonConfig;

function makeRequest(authorization?: string): FastifyRequest {
  return {
    headers: authorization === undefined ? {} : { authorization },
    ip: '10.0.0.1',
    url: '/api/system',
    id: 'req-1',
    log: { warn: vi.fn() },
  } as unknown as FastifyRequest;
}

function makeReply(): { reply: FastifyReply; send: ReturnType<typeof vi.fn> } {
  const send = vi.fn();
  const reply = { code: vi.fn(() => ({ send })) } as unknown as FastifyReply;
  return { reply, send };
}

describe('createNodeTokenGuard', () => {
  const guard = createNodeTokenGuard(config);

  it('accepte le jeton attendu', () => {
    const { reply, send } = makeReply();
    expect(guard(makeRequest(`Bearer ${TOKEN_ID}.${TOKEN_SECRET}`), reply)).toBe(true);
    expect(send).not.toHaveBeenCalled();
  });

  it.each([
    ['header absent', undefined],
    ['Basic scheme', `Basic ${TOKEN_ID}.${TOKEN_SECRET}`],
    ['jeton vide', 'Bearer '],
    ['malformed token', 'Bearer not-a-token'],
    ['identifiant inconnu', `Bearer ${'q'.repeat(16)}.${TOKEN_SECRET}`],
    ['wrong secret', `Bearer ${TOKEN_ID}.${'y'.repeat(64)}`],
    ['truncated secret', `Bearer ${TOKEN_ID}.${'z'.repeat(63)}`],
    ['identifiant et secret intervertis', `Bearer ${TOKEN_SECRET}.${TOKEN_ID}`],
  ])('refuse : %s', (_label, authorization) => {
    const { reply } = makeReply();
    expect(guard(makeRequest(authorization), reply)).toBe(false);
    expect(reply.code).toHaveBeenCalledWith(401);
  });

  // A different message per cause would allow enumerating valid node
  // identifiers before attacking the secret.
  it('returns the same message whatever the cause of the refusal', () => {
    const messages = [
      'Bearer pas-un-jeton',
      `Bearer ${'q'.repeat(16)}.${TOKEN_SECRET}`,
      `Bearer ${TOKEN_ID}.${'y'.repeat(64)}`,
    ].map((header) => {
      const { reply, send } = makeReply();
      guard(makeRequest(header), reply);
      return (send.mock.calls[0]?.[0] as { error: { message: string; code: string } }).error;
    });

    expect(new Set(messages.map((m) => m.message)).size).toBe(1);
    expect(new Set(messages.map((m) => m.code)).size).toBe(1);
  });

  it('never returns the expected secret in the response', () => {
    const { reply, send } = makeReply();
    guard(makeRequest('Bearer wrong'), reply);
    expect(JSON.stringify(send.mock.calls[0]?.[0])).not.toContain(TOKEN_SECRET);
  });
});
