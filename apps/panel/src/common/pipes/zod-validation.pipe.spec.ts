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

  it('renvoie la valeur analysée, valeurs par défaut appliquées', () => {
    expect(pipe.transform({ name: 'Survie', port: 25565 })).toEqual({
      name: 'Survie',
      port: 25565,
      description: '',
    });
  });

  // Sans ce comportement, un champ mal orthographié serait silencieusement
  // ignoré et l'opérateur croirait avoir modifié un réglage.
  it('retire les propriétés non déclarées', () => {
    const result = pipe.transform({ name: 'Survie', port: 25565, isAdmin: true });
    expect(result).not.toHaveProperty('isAdmin');
  });

  it('lève une 400 sur une valeur invalide', () => {
    expect(() => pipe.transform({ name: '', port: 99999 })).toThrow(BadRequestException);
  });

  it('détaille chaque problème avec son chemin', () => {
    try {
      pipe.transform({ name: '', port: 99999 });
      expect.unreachable('la validation aurait dû échouer');
    } catch (error) {
      const response = (error as BadRequestException).getResponse() as {
        issues: { path: string }[];
      };
      expect(response.issues.map((issue) => issue.path).sort()).toEqual(['name', 'port']);
    }
  });

  it('refuse une valeur non objet', () => {
    expect(() => pipe.transform('pas un objet')).toThrow(BadRequestException);
    expect(() => pipe.transform(null)).toThrow(BadRequestException);
  });
});
