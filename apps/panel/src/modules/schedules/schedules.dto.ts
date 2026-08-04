import { z } from 'zod';
import { validateCron } from './cron.js';

/**
 * Un décalage se compte en secondes et sert à laisser aux joueurs le temps de
 * se déconnecter après une annonce. Au-delà d'une heure, ce n'est plus un
 * décalage mais une seconde tâche planifiée.
 */
const MAX_OFFSET_SECONDS = 3600;

export const taskActionSchema = z.enum(['COMMAND', 'POWER', 'BACKUP']);
export type TaskAction = z.infer<typeof taskActionSchema>;

export const scheduleTaskSchema = z
  .object({
    action: taskActionSchema,
    /**
     * Sens selon l'action : la commande à envoyer, l'action de puissance, ou
     * les motifs d'exclusion d'une sauvegarde — un par ligne.
     */
    payload: z.string().max(2000).default(''),
    offsetSeconds: z.number().int().min(0).max(MAX_OFFSET_SECONDS).default(0),
    /** Poursuivre la séquence même si cette étape échoue. */
    continueOnFailure: z.boolean().default(false),
  })
  .refine(
    (task) =>
      task.action !== 'POWER' || ['start', 'stop', 'restart', 'kill'].includes(task.payload),
    {
      message: 'Action de puissance attendue : start, stop, restart ou kill.',
      path: ['payload'],
    },
  )
  .refine((task) => task.action !== 'COMMAND' || task.payload.trim() !== '', {
    message: 'Une commande vide ne serait envoyée à personne.',
    path: ['payload'],
  });

export type ScheduleTaskDto = z.infer<typeof scheduleTaskSchema>;

const cronFields = {
  cronMinute: z.string().max(64).default('*'),
  cronHour: z.string().max(64).default('*'),
  cronDayOfMonth: z.string().max(64).default('*'),
  cronMonth: z.string().max(64).default('*'),
  cronDayOfWeek: z.string().max(64).default('*'),
};

/**
 * Vérifie l'expression cron à l'entrée.
 *
 * Une expression invalide acceptée ici resterait silencieuse : la tâche
 * apparaîtrait dans la liste et ne se déclencherait jamais, sans que rien ne
 * l'indique. Autant refuser au moment où l'utilisateur peut corriger.
 */
function checkCron(
  value: {
    cronMinute?: string;
    cronHour?: string;
    cronDayOfMonth?: string;
    cronMonth?: string;
    cronDayOfWeek?: string;
  },
  context: z.RefinementCtx,
): void {
  try {
    validateCron({
      minute: value.cronMinute ?? '*',
      hour: value.cronHour ?? '*',
      dayOfMonth: value.cronDayOfMonth ?? '*',
      month: value.cronMonth ?? '*',
      dayOfWeek: value.cronDayOfWeek ?? '*',
    });
  } catch (error: unknown) {
    context.addIssue({
      code: 'custom',
      message: error instanceof Error ? error.message : 'Expression cron invalide.',
    });
  }
}

export const createScheduleSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    ...cronFields,
    active: z.boolean().default(true),
    /** Ne rien faire si le serveur est arrêté, plutôt que de le démarrer. */
    onlyWhenOnline: z.boolean().default(false),
    tasks: z.array(scheduleTaskSchema).min(1).max(20),
  })
  .superRefine(checkCron);

export type CreateScheduleDto = z.infer<typeof createScheduleSchema>;

export const updateScheduleSchema = z
  .object({
    name: z.string().trim().min(1).max(120).optional(),
    ...cronFields,
    active: z.boolean().optional(),
    onlyWhenOnline: z.boolean().optional(),
    /** Absent, les tâches existantes sont conservées telles quelles. */
    tasks: z.array(scheduleTaskSchema).min(1).max(20).optional(),
  })
  .superRefine(checkCron);

export type UpdateScheduleDto = z.infer<typeof updateScheduleSchema>;
