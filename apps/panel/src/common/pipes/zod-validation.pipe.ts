import { BadRequestException, Injectable, type PipeTransform } from '@nestjs/common';
import type { ZodType } from 'zod';

/**
 * Valide un corps, un paramètre ou une requête avec un schéma Zod.
 *
 * Le panel n'utilise volontairement pas `class-validator` : les schémas qui
 * décrivent le contrat panel↔daemon vivent déjà dans `@hopper/shared` sous forme
 * Zod. Deux systèmes de validation en parallèle finiraient par diverger, et
 * c'est justement la divergence que le paquet partagé sert à empêcher.
 *
 * @example
 * ```ts
 * @Post()
 * create(@Body(new ZodValidationPipe(createServerRequestSchema)) body: CreateServerRequest) {}
 * ```
 */
@Injectable()
export class ZodValidationPipe<TOutput> implements PipeTransform<unknown, TOutput> {
  constructor(private readonly schema: ZodType<TOutput>) {}

  transform(value: unknown): TOutput {
    const result = this.schema.safeParse(value);

    if (!result.success) {
      throw new BadRequestException({
        message: 'Requête invalide.',
        // Le chemin et le message de chaque problème sont renvoyés : ils
        // décrivent la requête envoyée par le client, jamais l'état du serveur.
        issues: result.error.issues.map((issue) => ({
          path: issue.path.join('.'),
          message: issue.message,
          code: issue.code,
        })),
      });
    }

    return result.data;
  }
}
