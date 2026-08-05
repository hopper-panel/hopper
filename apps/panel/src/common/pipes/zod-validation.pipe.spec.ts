import { BadRequestException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { ZodValidationPipe } from './zod-validation.pipe.js';

const schema = z.object({
  name: z.string().min(1),
  port: z.number().int().min(1).max(65535),
  description: z.string().default(''),
});

describe('ZodValidationPipe', () => {
  const pipe = new ZodValidationPipe(schema);

  it('returns the parsed value, defaults applied', () => {
    expect(pipe.transform({ name: 'Survival', port: 25565 })).toEqual({
      name: 'Survival',
      port: 25565,
      description: '',
    });
  });

  // Without this behaviour, a misspelled field would be silently ignored and
  // the operator would believe they had changed a setting.
  it('strips the undeclared properties', () => {
    const result = pipe.transform({ name: 'Survival', port: 25565, isAdmin: true });
    expect(result).not.toHaveProperty('isAdmin');
  });

  it('throws a 400 on an invalid value', () => {
    expect(() => pipe.transform({ name: '', port: 99999 })).toThrow(BadRequestException);
  });

  it('details each problem with its path', () => {
    try {
      pipe.transform({ name: '', port: 99999 });
      expect.unreachable('validation should have failed');
    } catch (error) {
      const response = (error as BadRequestException).getResponse() as {
        issues: { path: string }[];
      };
      expect(response.issues.map((issue) => issue.path).sort()).toEqual(['name', 'port']);
    }
  });

  it('rejects a non-object value', () => {
    expect(() => pipe.transform('pas un objet')).toThrow(BadRequestException);
    expect(() => pipe.transform(null)).toThrow(BadRequestException);
  });
});
