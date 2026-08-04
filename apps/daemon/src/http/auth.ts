import { timingSafeEqual } from 'node:crypto';
import { extractBearerToken, parseNodeToken } from '@hopper/shared';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { DaemonConfig } from '../config/schema.js';

/**
 * Compares two strings in constant time.
 *
 * A naive comparison (`a === b`) exits at the first differing character: by
 * measuring the response time, an attacker can guess the secret byte by byte.
 * The length is compared first, then buffers of equal size are forced so that
 * `timingSafeEqual` does not throw.
 */
function secureCompare(a: string, b: string): boolean {
  const bufferA = Buffer.from(a, 'utf8');
  const bufferB = Buffer.from(b, 'utf8');

  if (bufferA.length !== bufferB.length) {
    // A comparison is performed anyway, so as not to reveal the expected length
    // through a faster response.
    timingSafeEqual(bufferA, bufferA);
    return false;
  }

  return timingSafeEqual(bufferA, bufferB);
}

/**
 * Checks the `Authorization` header of a request coming from the panel.
 *
 * Every cause of failure returns the same response: a malformed token, an
 * unknown identifier and a wrong secret are indistinguishable from outside.
 */
export function createNodeTokenGuard(config: DaemonConfig) {
  return function authenticateNode(request: FastifyRequest, reply: FastifyReply): boolean {
    const token = extractBearerToken(request.headers.authorization);
    const parsed = token ? parseNodeToken(token) : null;

    const authenticated =
      parsed !== null &&
      secureCompare(parsed.id, config.tokenId) &&
      secureCompare(parsed.secret, config.tokenSecret);

    if (!authenticated) {
      request.log.warn({ ip: request.ip, url: request.url }, 'Node authentication refused');
      void reply.code(401).send({
        error: {
          code: 'unauthorized',
          message: 'Node token missing or invalid.',
          requestId: request.id,
        },
      });
      return false;
    }

    return true;
  };
}
