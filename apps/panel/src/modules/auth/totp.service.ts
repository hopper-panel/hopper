import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Secret, TOTP } from 'otpauth';
import type { Environment } from '../../config/environment.js';

/**
 * Double authentification par code temporel (RFC 6238).
 *
 * Réglages standards — 6 chiffres, 30 secondes, SHA-1 — parce que c'est ce que
 * savent lire Google Authenticator, Aegis, 1Password et Bitwarden. Passer en
 * SHA-256 casserait la compatibilité avec une partie des applications sans
 * gain réel : le secret fait déjà 160 bits.
 */
const TOTP_DIGITS = 6;
const TOTP_PERIOD_SECONDS = 30;

/**
 * Fenêtre de tolérance, en pas de 30 secondes, de part et d'autre du code
 * courant. 1 accepte donc une horloge décalée de 30 s au plus — indispensable
 * en pratique, les téléphones dérivent. Au-delà, la fenêtre d'attaque par
 * rejeu s'élargit sans bénéfice.
 */
const TOTP_WINDOW = 1;

@Injectable()
export class TotpService {
  private readonly issuer: string;

  constructor(config: ConfigService<Environment, true>) {
    // L'émetteur apparaît dans l'application d'authentification : il doit
    // désigner l'instance, pas le logiciel, sinon deux panels Hopper créent
    // deux entrées indiscernables.
    this.issuer = new URL(config.get('APP_URL', { infer: true })).host;
  }

  /** Secret aléatoire en base32, à stocker chiffré. */
  generateSecret(): string {
    return new Secret({ size: 20 }).base32;
  }

  private build(secret: string, label: string): TOTP {
    return new TOTP({
      issuer: this.issuer,
      label,
      algorithm: 'SHA1',
      digits: TOTP_DIGITS,
      period: TOTP_PERIOD_SECONDS,
      secret: Secret.fromBase32(secret),
    });
  }

  /** URI `otpauth://` à encoder en QR code côté interface. */
  buildProvisioningUri(secret: string, username: string): string {
    return this.build(secret, username).toString();
  }

  /**
   * Valide un code saisi par l'utilisateur.
   *
   * Les espaces et tirets sont retirés : les applications affichent souvent
   * `123 456`, et refuser une saisie recopiée telle quelle serait une friction
   * gratuite. Toute autre entrée est rejetée sans être transmise à la
   * bibliothèque.
   */
  verify(secret: string, code: string): boolean {
    const normalized = code.replace(/[\s-]/g, '');

    if (!/^\d{6}$/.test(normalized)) {
      return false;
    }

    const delta = this.build(secret, 'verification').validate({
      token: normalized,
      window: TOTP_WINDOW,
    });

    return delta !== null;
  }
}
