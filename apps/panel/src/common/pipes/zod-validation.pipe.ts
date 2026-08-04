import { BadRequestException, Injectable, type PipeTransform } from '@nestjs/common';
import type { ZodType } from 'zod';

/**
 * Validates a body, a parameter or a query with a Zod schema.
 *
 * The panel deliberately does not use `class-validator`: the schemas describing
 * the panel↔daemon contract already live in `@hopper/shared` as Zod. Two
 * validation systems side by side would end up diverging, and divergence is
 * exactly what the shared package exists to prevent.
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
        message: 'Invalid request.',
        // The path and message of each problem are returned: they describe the
        // request the client sent, never the server's state.
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
