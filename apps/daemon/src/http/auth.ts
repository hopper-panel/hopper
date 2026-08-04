import { timingSafeEqual } from 'node:crypto';
import { extractBearerToken, parseNodeToken } from '@hopper/shared';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { DaemonConfig } from '../config/schema.js';

/**
 * Compare deux chaînes en temps constant.
 *
 * Une comparaison naïve (`a === b`) sort au premier caractère différent : en
 * mesurant le temps de réponse, un attaquant peut deviner le secret octet par
 * octet. La longueur est comparée d'abord, puis on force des tampons de même
 * taille pour que `timingSafeEqual` ne lève pas.
 */
function secureCompare(a: string, b: string): boolean {
  const bufferA = Buffer.from(a, 'utf8');
  const bufferB = Buffer.from(b, 'utf8');

  if (bufferA.length !== bufferB.length) {
    // On effectue quand même une comparaison pour ne pas révéler la longueur
    // attendue par une réponse plus rapide.
    timingSafeEqual(bufferA, bufferA);
    return false;
  }

  return timingSafeEqual(bufferA, bufferB);
}

/**
 * Vérifie l'en-tête `Authorization` d'une requête venant du panel.
 *
 * Toutes les causes d'échec renvoient la même réponse : un jeton mal formé, un
 * identifiant inconnu et un secret erroné sont indiscernables de l'extérieur.
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
      request.log.warn({ ip: request.ip, url: request.url }, 'Authentification de node refusée');
      void reply.code(401).send({
        error: {
          code: 'unauthorized',
          message: 'Jeton de node absent ou invalide.',
          requestId: request.id,
        },
      });
      return false;
    }

    return true;
  };
}
