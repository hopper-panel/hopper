import { randomUUID } from 'node:crypto';
import {
  CONSOLE_TOKEN_TTL_SECONDS,
  SIGNED_URL_TTL_SECONDS,
  consoleTokenPayloadSchema,
  signedUrlPayloadSchema,
  type ConsoleTokenPayload,
  type Permission,
  type SignedUrlPayload,
} from '@hopper/shared';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SignJWT, jwtVerify } from 'jose';
import { CryptoService } from '../../common/crypto/crypto.service.js';
import type { Environment } from '../../config/environment.js';

/** Durée de vie de l'access token du panel. */
export const ACCESS_TOKEN_TTL_SECONDS = 15 * 60;
/** Durée de vie d'une session de rafraîchissement. */
export const REFRESH_TOKEN_TTL_SECONDS = 30 * 24 * 60 * 60;

export interface AccessTokenPayload {
  sub: string;
  username: string;
  role: 'ADMIN' | 'USER';
  /** Identifiant de session, pour révoquer un access token via sa session. */
  sid: string;
}

/**
 * Émission et vérification des jetons du panel.
 *
 * Trois familles distinctes, jamais interchangeables :
 *
 *  • **access token** — signé avec la clé du panel, prouve l'identité auprès de
 *    l'API. Court, non stocké.
 *  • **refresh token** — chaîne opaque aléatoire, stockée hashée en base. Ce
 *    n'est pas un JWT : il doit être révocable immédiatement.
 *  • **jeton de console / URL signée** — signés avec le secret du *node*
 *    concerné, car c'est le daemon qui les vérifie, sans rappeler le panel.
 *
 * L'audience (`aud`) sépare les familles : un jeton de console présenté à l'API
 * du panel échoue à la vérification, et réciproquement.
 */
@Injectable()
export class TokenService {
  private readonly issuer: string;

  constructor(
    private readonly crypto: CryptoService,
    config: ConfigService<Environment, true>,
  ) {
    this.issuer = config.get('APP_URL', { infer: true });
  }

  // -------------------------------------------------------------------------
  // Access token
  // -------------------------------------------------------------------------

  async signAccessToken(payload: AccessTokenPayload): Promise<string> {
    return new SignJWT({ username: payload.username, role: payload.role, sid: payload.sid })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(payload.sub)
      .setIssuer(this.issuer)
      .setAudience('hopper:panel')
      .setIssuedAt()
      .setExpirationTime(`${ACCESS_TOKEN_TTL_SECONDS}s`)
      .sign(this.crypto.getSigningKey());
  }

  async verifyAccessToken(token: string): Promise<AccessTokenPayload | null> {
    try {
      const { payload } = await jwtVerify(token, this.crypto.getSigningKey(), {
        issuer: this.issuer,
        audience: 'hopper:panel',
        algorithms: ['HS256'],
      });

      if (
        typeof payload.sub !== 'string' ||
        typeof payload.username !== 'string' ||
        typeof payload.sid !== 'string' ||
        (payload.role !== 'ADMIN' && payload.role !== 'USER')
      ) {
        return null;
      }

      return {
        sub: payload.sub,
        username: payload.username,
        role: payload.role,
        sid: payload.sid,
      };
    } catch {
      // Signature invalide, jeton expiré, audience erronée : dans tous les cas
      // la requête n'est pas authentifiée. Le détail n'intéresse pas l'appelant.
      return null;
    }
  }

  // -------------------------------------------------------------------------
  // Refresh token
  // -------------------------------------------------------------------------

  /**
   * Génère un refresh token opaque et son empreinte.
   * Seule l'empreinte est stockée : une fuite de la base ne donne pas de
   * session utilisable.
   */
  generateRefreshToken(): { token: string; hash: string } {
    const token = this.crypto.randomString(64);
    return { token, hash: this.crypto.hashToken(token) };
  }

  /** Identifiant de famille, partagé par toutes les rotations d'une session. */
  generateSessionFamily(): string {
    return randomUUID();
  }

  // -------------------------------------------------------------------------
  // Jetons destinés au daemon
  // -------------------------------------------------------------------------

  /**
   * Jeton autorisant une connexion WebSocket à la console d'un serveur.
   *
   * Signé avec le secret du node, pas avec celui du panel : le daemon le vérifie
   * seul, sans appel réseau. C'est ce qui rend la console fluide, et c'est
   * pourquoi la durée de vie est courte — une permission retirée dans le panel
   * ne prend effet qu'au renouvellement.
   */
  async signConsoleToken(input: {
    nodeUuid: string;
    nodeJwtSecret: string;
    userUuid: string;
    serverUuid: string;
    permissions: Permission[];
  }): Promise<string> {
    return new SignJWT({
      serverUuid: input.serverUuid,
      permissions: input.permissions,
    })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(input.userUuid)
      .setIssuer(this.issuer)
      .setAudience(input.nodeUuid)
      .setJti(randomUUID())
      .setIssuedAt()
      .setExpirationTime(`${CONSOLE_TOKEN_TTL_SECONDS}s`)
      .sign(Buffer.from(input.nodeJwtSecret, 'utf8'));
  }

  /** Vérifie un jeton de console. Utilisé par les tests et par le daemon. */
  async verifyConsoleToken(
    token: string,
    nodeUuid: string,
    nodeJwtSecret: string,
  ): Promise<ConsoleTokenPayload | null> {
    try {
      const { payload } = await jwtVerify(token, Buffer.from(nodeJwtSecret, 'utf8'), {
        issuer: this.issuer,
        audience: nodeUuid,
        algorithms: ['HS256'],
      });

      const parsed = consoleTokenPayloadSchema.safeParse(payload);
      return parsed.success ? parsed.data : null;
    } catch {
      return null;
    }
  }

  /**
   * URL signée à usage unique pour un téléchargement ou un envoi de fichier.
   * Très courte durée : l'URL passe en clair dans la barre d'adresse et
   * l'historique du navigateur.
   */
  async signResourceUrl(input: {
    nodeUuid: string;
    nodeJwtSecret: string;
    userUuid: string;
    serverUuid: string;
    resource: SignedUrlPayload['resource'];
  }): Promise<string> {
    return new SignJWT({ serverUuid: input.serverUuid, resource: input.resource })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(input.userUuid)
      .setIssuer(this.issuer)
      .setAudience(input.nodeUuid)
      .setJti(randomUUID())
      .setIssuedAt()
      .setExpirationTime(`${SIGNED_URL_TTL_SECONDS}s`)
      .sign(Buffer.from(input.nodeJwtSecret, 'utf8'));
  }

  async verifyResourceUrl(
    token: string,
    nodeUuid: string,
    nodeJwtSecret: string,
  ): Promise<SignedUrlPayload | null> {
    try {
      const { payload } = await jwtVerify(token, Buffer.from(nodeJwtSecret, 'utf8'), {
        issuer: this.issuer,
        audience: nodeUuid,
        algorithms: ['HS256'],
      });

      const parsed = signedUrlPayloadSchema.safeParse(payload);
      return parsed.success ? parsed.data : null;
    } catch {
      return null;
    }
  }
}
