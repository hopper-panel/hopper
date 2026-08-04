import { Algorithm, hash, verify } from '@node-rs/argon2';
import { Injectable, Logger } from '@nestjs/common';

/**
 * Paramètres Argon2id.
 *
 * 19 Mio de mémoire et 2 passes correspondent à la recommandation OWASP de
 * 2024 pour Argon2id. Le coût mémoire est ce qui compte face à un attaquant
 * équipé de GPU : augmenter `timeCost` sans `memoryCost` ne sert à rien.
 *
 * Ces valeurs sont figées ici plutôt que configurables : un opérateur qui les
 * baisserait pour « accélérer la connexion » affaiblirait tous les mots de
 * passe de son instance sans s'en rendre compte.
 */
const ARGON2_OPTIONS = {
  algorithm: Algorithm.Argon2id,
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1,
  outputLen: 32,
} as const;

/**
 * Découpe l'en-tête d'une empreinte au format PHC :
 * `$argon2id$v=19$m=19456,t=2,p=1$<sel>$<empreinte>`
 */
const PHC_PATTERN = /^\$argon2(id|i|d)\$v=(\d+)\$m=(\d+),t=(\d+),p=(\d+)\$/;

@Injectable()
export class PasswordService {
  private readonly logger = new Logger(PasswordService.name);

  async hash(password: string): Promise<string> {
    return hash(password, ARGON2_OPTIONS);
  }

  /**
   * Vérifie un mot de passe. Retourne `false` sur une empreinte illisible au
   * lieu de lever : une ligne corrompue en base doit refuser la connexion, pas
   * renvoyer une 500 qui révèle l'existence du compte.
   */
  async verify(hashed: string, password: string): Promise<boolean> {
    try {
      return await verify(hashed, password, ARGON2_OPTIONS);
    } catch (error: unknown) {
      this.logger.error(`Empreinte de mot de passe illisible : ${String(error)}`);
      return false;
    }
  }

  /**
   * Indique si l'empreinte a été produite avec des paramètres plus faibles que
   * les paramètres courants.
   *
   * `@node-rs/argon2` n'expose pas d'équivalent : les paramètres sont donc lus
   * dans l'en-tête PHC de l'empreinte, qui les porte en clair par conception.
   *
   * Appelé après une connexion réussie — le seul moment où le mot de passe en
   * clair est disponible pour être réencodé sans rien demander à l'utilisateur.
   * Une empreinte illisible renvoie `true` : mieux vaut réencoder inutilement
   * que laisser vivre une empreinte qu'on ne sait pas évaluer.
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

    // Strictement inférieur : une empreinte plus coûteuse que la configuration
    // courante reste valable. Rétrograder un mot de passe déjà bien protégé
    // parce qu'un opérateur a baissé les réglages serait un recul.
    return (
      Number(memoryCost) < ARGON2_OPTIONS.memoryCost ||
      Number(timeCost) < ARGON2_OPTIONS.timeCost ||
      Number(parallelism) < ARGON2_OPTIONS.parallelism
    );
  }
}
