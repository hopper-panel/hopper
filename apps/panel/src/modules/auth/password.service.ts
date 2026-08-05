import { Algorithm, hash, verify } from '@node-rs/argon2';
import { Injectable, Logger } from '@nestjs/common';

/**
 * Argon2id parameters.
 *
 * 19 MiB of memory and 2 passes match OWASP's 2024 advice for Argon2id. The
 * memory cost is what counts against a GPU-equipped attacker: raising
 * `timeCost` without `memoryCost` achieves nothing.
 *
 * These values are frozen here rather than configurable: an operator who
 * lowered them to "speed up sign-in" would weaken every password on their
 * instance without noticing.
 */
const ARGON2_OPTIONS = {
  algorithm: Algorithm.Argon2id,
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1,
  outputLen: 32,
} as const;

/**
 * Splits the header of a PHC-format digest:
 * `$argon2id$v=19$m=19456,t=2,p=1$<salt>$<digest>`
 */
const PHC_PATTERN = /^\$argon2(id|i|d)\$v=(\d+)\$m=(\d+),t=(\d+),p=(\d+)\$/;

@Injectable()
export class PasswordService {
  private readonly logger = new Logger(PasswordService.name);

  async hash(password: string): Promise<string> {
    return hash(password, ARGON2_OPTIONS);
  }

  /**
   * Verifies a password. Returns `false` on an unreadable digest instead of
   * throwing: a corrupt row in the database has to refuse the sign-in, not
   * return a 500 that reveals the account exists.
   */
  async verify(hashed: string, password: string): Promise<boolean> {
    try {
      return await verify(hashed, password, ARGON2_OPTIONS);
    } catch (error: unknown) {
      this.logger.error(`Unreadable password digest: ${String(error)}`);
      return false;
    }
  }

  /**
   * Says whether the digest was produced with weaker parameters than the
   * current ones.
   *
   * `@node-rs/argon2` exposes no equivalent: the parameters are therefore read
   * from the digest's PHC header, which carries them in the clear by design.
   *
   * Called after a successful sign-in — the only moment the plaintext password
   * is available to be re-encoded without asking the user anything. An
   * unreadable digest returns `true`: better to re-encode needlessly than to
   * leave alive a digest we cannot assess.
   */
  needsRehash(hashed: string): boolean {
    const match = PHC_PATTERN.exec(hashed);

    if (!match) {
      return true;
    }

    const [, variant, , memoryCost, timeCost, parallelism] = match;

    if (variant !== 'id') {
      return true;
    }

    // Strictly lower: a digest costlier than the current configuration stays
    // valid. Downgrading an already well-protected password because an operator
    // lowered the settings would be a step backwards.
    return (
      Number(memoryCost) < ARGON2_OPTIONS.memoryCost ||
      Number(timeCost) < ARGON2_OPTIONS.timeCost ||
      Number(parallelism) < ARGON2_OPTIONS.parallelism
    );
  }
}
