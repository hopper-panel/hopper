import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useParams } from 'react-router-dom';
import { Modal } from '../components/Modal';
import { PageHeader } from '../components/PageHeader';
import { Toggle } from '../components/Toggle';
import { Alert, Badge, Button, Card, EmptyState, Field, Input, Spinner } from '../components/ui';
import { ApiError, api } from '../lib/api';
import { formatDate } from '../lib/format';
import { useServerContext } from '../lib/server-context';

type Action = 'COMMAND' | 'POWER' | 'BACKUP';

interface Task {
  uuid?: string;
  action: Action;
  payload: string;
  offsetSeconds: number;
  continueOnFailure: boolean;
}

interface Schedule {
  uuid: string;
  name: string;
  cron: { minute: string; hour: string; dayOfMonth: string; month: string; dayOfWeek: string };
  expression: string;
  active: boolean;
  onlyWhenOnline: boolean;
  lastRunAt: string | null;
  nextRunAt: string | null;
  running: boolean;
  tasks: Task[];
}

const ACTION_LABELS: Record<Action, string> = {
  COMMAND: 'Commande',
  POWER: 'Puissance',
  BACKUP: 'Sauvegarde',
};

/** Modèles proposés : les horaires que l'on écrit réellement pour un serveur. */
const PRESETS = [
  { label: 'Toutes les heures', cron: ['0', '*', '*', '*', '*'] },
  { label: 'Chaque nuit à 5 h', cron: ['0', '5', '*', '*', '*'] },
  { label: 'Chaque lundi à 5 h', cron: ['0', '5', '*', '*', '1'] },
  { label: 'Le 1er du mois à 4 h', cron: ['0', '4', '1', '*', '*'] },
] as const;

const EMPTY: Schedule = {
  uuid: '',
  name: '',
  cron: { minute: '0', hour: '5', dayOfMonth: '*', month: '*', dayOfWeek: '*' },
  expression: '0 5 * * *',
  active: true,
  onlyWhenOnline: false,
  lastRunAt: null,
  nextRunAt: null,
  running: false,
  tasks: [{ action: 'BACKUP', payload: '', offsetSeconds: 0, continueOnFailure: false }],
};

export function ServerSchedulesPage() {
  const { uuid = '' } = useParams();
  const queryClient = useQueryClient();
  const { can } = useServerContext();

  const [draft, setDraft] = useState<Schedule | null>(null);
  const [failure, setFailure] = useState<string | null>(null);

  const schedules = useQuery({
    queryKey: ['server', uuid, 'schedules'],
    queryFn: () => api.get<{ data: Schedule[] }>(`/api/servers/${uuid}/schedules`),
    // Une tâche en cours d'exécution se termine sans prévenir le navigateur :
    // on suit tant qu'il en reste une, et on s'arrête ensuite.
    refetchInterval: (query) =>
      query.state.data?.data.some((schedule) => schedule.running) ? 5000 : false,
  });

  const refresh = (): void => {
    void queryClient.invalidateQueries({ queryKey: ['server', uuid, 'schedules'] });
  };

  const fail = (error: unknown): void => {
    setFailure(error instanceof ApiError ? error.message : 'Opération impossible.');
  };

  const save = useMutation({
    mutationFn: (schedule: Schedule) => {
      const body = {
        name: schedule.name,
        cronMinute: schedule.cron.minute,
        cronHour: schedule.cron.hour,
        cronDayOfMonth: schedule.cron.dayOfMonth,
        cronMonth: schedule.cron.month,
        cronDayOfWeek: schedule.cron.dayOfWeek,
        active: schedule.active,
        onlyWhenOnline: schedule.onlyWhenOnline,
        tasks: schedule.tasks,
      };

      return schedule.uuid
        ? api.patch<Schedule>(`/api/servers/${uuid}/schedules/${schedule.uuid}`, body)
        : api.post<Schedule>(`/api/servers/${uuid}/schedules`, body);
    },
    onSuccess: () => {
      setDraft(null);
      setFailure(null);
      refresh();
    },
    onError: fail,
  });

  const remove = useMutation({
    mutationFn: (scheduleUuid: string) =>
      api.delete<void>(`/api/servers/${uuid}/schedules/${scheduleUuid}`),
    onSuccess: refresh,
    onError: fail,
  });

  const runNow = useMutation({
    mutationFn: (scheduleUuid: string) =>
      api.post<void>(`/api/servers/${uuid}/schedules/${scheduleUuid}/run`),
    onSuccess: refresh,
    onError: fail,
  });

  if (schedules.isLoading) {
    return <Spinner label="Chargement des tâches planifiées…" />;
  }

  const list = schedules.data?.data ?? [];

  return (
    <>
      <PageHeader
        title="Planificateur"
        description="Commandes, redémarrages et sauvegardes déclenchés automatiquement."
        action={
          can('schedule.create') ? (
            <Button variant="primary" onClick={() => setDraft({ ...EMPTY })}>
              Nouvelle tâche
            </Button>
          ) : null
        }
      />

      {failure ? (
        <div className="mb-4">
          <Alert tone="danger">{failure}</Alert>
        </div>
      ) : null}

      {list.length === 0 ? (
        <EmptyState
          title="Aucune tâche planifiée"
          description="Une tâche exécute une suite d’étapes à un horaire donné : annoncer un redémarrage, attendre, puis redémarrer."
        />
      ) : (
        <div className="flex flex-col gap-2">
          {list.map((schedule) => (
            <Card key={schedule.uuid}>
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-medium text-content">{schedule.name}</span>
                    <code className="rounded bg-surface px-1.5 py-0.5 font-mono text-xs text-content-muted">
                      {schedule.expression}
                    </code>
                    {schedule.running ? <Badge tone="warn">en cours</Badge> : null}
                    {!schedule.active ? <Badge>inactive</Badge> : null}
                    {schedule.onlyWhenOnline ? <Badge>si en ligne</Badge> : null}
                  </div>

                  <p className="mt-1 text-xs text-content-muted">
                    {schedule.tasks.length} étape{schedule.tasks.length > 1 ? 's' : ''}
                    {schedule.nextRunAt
                      ? ` · prochaine exécution ${formatDate(schedule.nextRunAt)}`
                      : ' · aucune exécution prévue'}
                    {schedule.lastRunAt ? ` · dernière ${formatDate(schedule.lastRunAt)}` : null}
                  </p>

                  <ol className="mt-2 flex flex-col gap-1">
                    {schedule.tasks.map((task, index) => (
                      <li key={task.uuid ?? index} className="text-xs text-content-muted">
                        {index + 1}. {ACTION_LABELS[task.action]}
                        {task.payload ? ` — ${task.payload.split('\n')[0]}` : null}
                        {task.offsetSeconds > 0 ? ` (après ${task.offsetSeconds} s)` : null}
                      </li>
                    ))}
                  </ol>
                </div>

                <div className="flex flex-wrap gap-2">
                  {can('schedule.update') ? (
                    <Button
                      variant="ghost"
                      onClick={() => runNow.mutate(schedule.uuid)}
                      disabled={schedule.running || runNow.isPending}
                    >
                      Exécuter
                    </Button>
                  ) : null}
                  {can('schedule.update') ? (
                    <Button variant="ghost" onClick={() => setDraft(schedule)}>
                      Modifier
                    </Button>
                  ) : null}
                  {can('schedule.delete') ? (
                    <Button
                      variant="danger"
                      onClick={() => {
                        if (window.confirm(`Supprimer la tâche « ${schedule.name} » ?`)) {
                          remove.mutate(schedule.uuid);
                        }
                      }}
                    >
                      Supprimer
                    </Button>
                  ) : null}
                </div>
              </div>
            </Card>
          ))}
        </div>
      )}

      <Modal
        open={draft !== null}
        title={draft?.uuid ? 'Modifier la tâche' : 'Nouvelle tâche planifiée'}
        onClose={() => setDraft(null)}
        footer={
          <>
            <Button variant="ghost" onClick={() => setDraft(null)}>
              Annuler
            </Button>
            <Button
              variant="primary"
              onClick={() => draft && save.mutate(draft)}
              disabled={save.isPending || !draft?.name.trim()}
            >
              {save.isPending ? 'Enregistrement…' : 'Enregistrer'}
            </Button>
          </>
        }
      >
        {draft ? <ScheduleForm value={draft} onChange={setDraft} /> : null}
      </Modal>
    </>
  );
}

function ScheduleForm({
  value,
  onChange,
}: {
  value: Schedule;
  onChange: (schedule: Schedule) => void;
}) {
  const patch = (changes: Partial<Schedule>): void => onChange({ ...value, ...changes });

  const setTask = (index: number, changes: Partial<Task>): void => {
    patch({
      tasks: value.tasks.map((task, position) =>
        position === index ? { ...task, ...changes } : task,
      ),
    });
  };

  return (
    <div className="flex flex-col gap-5">
      <Field label="Nom">
        <Input
          value={value.name}
          onChange={(event) => patch({ name: event.target.value })}
          placeholder="Redémarrage nocturne"
        />
      </Field>

      <div>
        <span className="mb-1.5 block text-sm font-medium text-content">Horaire</span>
        <div className="grid grid-cols-5 gap-2">
          {(
            [
              ['minute', 'min'],
              ['hour', 'heure'],
              ['dayOfMonth', 'jour'],
              ['month', 'mois'],
              ['dayOfWeek', 'sem.'],
            ] as const
          ).map(([key, label]) => (
            <label key={key} className="block">
              <span className="mb-1 block text-center text-xs text-content-muted">{label}</span>
              <Input
                className="text-center font-mono"
                value={value.cron[key]}
                onChange={(event) => patch({ cron: { ...value.cron, [key]: event.target.value } })}
              />
            </label>
          ))}
        </div>

        <div className="mt-2 flex flex-wrap gap-1.5">
          {PRESETS.map((preset) => (
            <button
              key={preset.label}
              type="button"
              className="rounded-full border border-border-subtle px-2.5 py-1 text-xs text-content-muted transition-colors hover:bg-surface-hover hover:text-content"
              onClick={() =>
                patch({
                  cron: {
                    minute: preset.cron[0],
                    hour: preset.cron[1],
                    dayOfMonth: preset.cron[2],
                    month: preset.cron[3],
                    dayOfWeek: preset.cron[4],
                  },
                })
              }
            >
              {preset.label}
            </button>
          ))}
        </div>

        <p className="mt-2 text-xs text-content-muted">
          Syntaxe crontab : <code>*</code>, <code>5</code>, <code>1,3</code>, <code>1-5</code>,{' '}
          <code>*/15</code>. L’horaire suit le fuseau du panel.
        </p>
      </div>

      <Toggle
        checked={value.active}
        onChange={(active) => patch({ active })}
        label="Active"
        description="Une tâche inactive est conservée mais ne se déclenche plus."
      />

      <Toggle
        checked={value.onlyWhenOnline}
        onChange={(onlyWhenOnline) => patch({ onlyWhenOnline })}
        label="Seulement si le serveur est en ligne"
        description="Évite qu’un redémarrage planifié ne rallume un serveur volontairement arrêté."
      />

      <div>
        <span className="mb-2 block text-sm font-medium text-content">Étapes</span>

        <div className="flex flex-col gap-3">
          {value.tasks.map((task, index) => (
            <div
              key={index}
              className="rounded-lg border border-border-subtle bg-surface p-3 text-sm"
            >
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-xs text-content-muted">{index + 1}.</span>

                <select
                  className="rounded-lg border border-border-subtle bg-surface-raised px-2 py-1.5 text-sm text-content"
                  value={task.action}
                  onChange={(event) =>
                    setTask(index, { action: event.target.value as Action, payload: '' })
                  }
                >
                  {Object.entries(ACTION_LABELS).map(([action, label]) => (
                    <option key={action} value={action}>
                      {label}
                    </option>
                  ))}
                </select>

                {task.action === 'POWER' ? (
                  <select
                    className="rounded-lg border border-border-subtle bg-surface-raised px-2 py-1.5 text-sm text-content"
                    value={task.payload || 'restart'}
                    onChange={(event) => setTask(index, { payload: event.target.value })}
                  >
                    {['start', 'stop', 'restart', 'kill'].map((action) => (
                      <option key={action} value={action}>
                        {action}
                      </option>
                    ))}
                  </select>
                ) : null}

                <label className="ml-auto flex items-center gap-1.5 text-xs text-content-muted">
                  après
                  <Input
                    type="number"
                    min={0}
                    className="w-20"
                    value={String(task.offsetSeconds)}
                    onChange={(event) =>
                      setTask(index, { offsetSeconds: Number(event.target.value) || 0 })
                    }
                  />
                  s
                </label>

                {value.tasks.length > 1 ? (
                  <Button
                    variant="ghost"
                    onClick={() =>
                      onChange({
                        ...value,
                        tasks: value.tasks.filter((_, position) => position !== index),
                      })
                    }
                  >
                    Retirer
                  </Button>
                ) : null}
              </div>

              {task.action !== 'POWER' ? (
                <textarea
                  className="mt-2 min-h-16 w-full rounded-lg border border-border-subtle bg-surface-raised px-3 py-2 font-mono text-xs text-content placeholder:text-content-subtle"
                  placeholder={
                    task.action === 'COMMAND'
                      ? 'say Redémarrage dans 60 secondes'
                      : 'Exclusions, une par ligne (facultatif)'
                  }
                  value={task.payload}
                  onChange={(event) => setTask(index, { payload: event.target.value })}
                />
              ) : null}

              <label className="mt-2 flex items-center gap-2 text-xs text-content-muted">
                <input
                  type="checkbox"
                  checked={task.continueOnFailure}
                  onChange={(event) => setTask(index, { continueOnFailure: event.target.checked })}
                />
                Poursuivre la séquence même si cette étape échoue
              </label>
            </div>
          ))}
        </div>

        <Button
          className="mt-3"
          onClick={() =>
            onChange({
              ...value,
              tasks: [
                ...value.tasks,
                { action: 'COMMAND', payload: '', offsetSeconds: 0, continueOnFailure: false },
              ],
            })
          }
        >
          Ajouter une étape
        </Button>

        <p className="mt-2 text-xs text-content-muted">
          Le décalage s’applique <strong>avant</strong> l’étape : annoncer, attendre 60 s, puis
          redémarrer.
        </p>
      </div>
    </div>
  );
}
