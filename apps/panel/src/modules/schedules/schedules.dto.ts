import { z } from 'zod';
import { validateCron } from './cron.js';

/**
 * An offset counts in seconds and serves to give players time to disconnect
 * after an announcement. Beyond an hour it is no longer an offset but a second
 * scheduled task.
 */
const MAX_OFFSET_SECONDS = 3600;

export const taskActionSchema = z.enum(['COMMAND', 'POWER', 'BACKUP']);
export type TaskAction = z.infer<typeof taskActionSchema>;

export const scheduleTaskSchema = z
  .object({
    action: taskActionSchema,
    /**
     * Meaning depends on the action: the command to send, the power action, or
     * a backup's exclusion patterns — one per line.
     */
    payload: z.string().max(2000).default(''),
    offsetSeconds: z.number().int().min(0).max(MAX_OFFSET_SECONDS).default(0),
    /** Carry on with the sequence even if this step fails. */
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
    message: 'An empty command would be sent to nobody.',
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
 * Checks the cron expression on the way in.
 *
 * An invalid expression accepted here would stay silent: the task would appear
 * in the list and never fire, with nothing to say so. Better to refuse at the
 * moment the user can fix it.
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
    /** Do nothing if the server is stopped, rather than start it. */
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
    /** When absent, the existing steps are kept as they are. */
    tasks: z.array(scheduleTaskSchema).min(1).max(20).optional(),
  })
  .superRefine(checkCron);

export type UpdateScheduleDto = z.infer<typeof updateScheduleSchema>;
