import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Secret, TOTP } from 'otpauth';
import type { Environment } from '../../config/environment.js';

/**
 * Two-factor authentication by time-based code (RFC 6238).
 *
 * Standard settings — 6 digits, 30 seconds, SHA-1 — because that is what Google
 * Authenticator, Aegis, 1Password and Bitwarden can read. Moving to SHA-256
 * would break compatibility with some apps for no real gain: the secret is
 * already 160 bits.
 */
const TOTP_DIGITS = 6;
const TOTP_PERIOD_SECONDS = 30;

/**
 * Tolerance window, in 30-second steps, either side of the current code. 1
 * therefore accepts a clock off by at most 30s — indispensable in practice,
 * phones drift. Beyond that, the replay window widens for no benefit.
 */
const TOTP_WINDOW = 1;

@Injectable()
export class TotpService {
  private readonly issuer: string;

  constructor(config: ConfigService<Environment, true>) {
    // The issuer shows up in the authenticator app: it has to name the
    // instance, not the software, otherwise two Hopper panels create two
    // indistinguishable entries.
    this.issuer = new URL(config.get('APP_URL', { infer: true })).host;
  }

  /** Random base32 secret, to be stored encrypted. */
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

  /** `otpauth://` URI, to be encoded as a QR code by the interface. */
  buildProvisioningUri(secret: string, username: string): string {
    return this.build(secret, username).toString();
  }

  /**
   * Validates a code typed by the user.
   *
   * Spaces and hyphens are stripped: apps often display `123 456`, and refusing
   * an entry copied as shown would be gratuitous friction. Any other input is
   * rejected without being passed to the library.
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
