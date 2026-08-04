import { z } from 'zod';
import { MAX_VARIABLE_LENGTH } from './variable-rules.js';

export const updateStartupSchema = z.object({
  /**
   * Valeurs indexées par nom de variable d'environnement.
   *
   * La borne de longueur est posée ici **et** dans le validateur de règles :
   * ici pour rejeter une charge démesurée avant tout traitement, là pour
   * couvrir les appels qui ne passeraient pas par ce schéma.
   */
  variables: z.record(z.string(), z.string().max(MAX_VARIABLE_LENGTH)).optional(),
  dockerImage: z.string().min(1).max(255).optional(),
});

export type UpdateStartupDto = z.infer<typeof updateStartupSchema>;
