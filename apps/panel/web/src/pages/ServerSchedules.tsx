import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useParams } from 'react-router-dom';
import { Modal } from '../components/Modal';
import { PageHeader } from '../components/PageHeader';
import { Toggle } from '../components/Toggle';
import { Alert, Badge, Button, Card, EmptyState, Field, Input, Spinner } from '../components/ui';
import { ApiError, api } from '../lib/api';
import { formatDate } from '../lib/format';
import { useTranslation, type MessageKey } from '../i18n';
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

const ACTION_LABELS: Record<Action, MessageKey> = {
  COMMAND: 'schedules.actionCommand',
  POWER: 'schedules.actionPower',
  BACKUP: 'schedules.actionBackup',
};

/** Offered presets: the timings one actually writes for a server. */
const PRESETS = [
  { label: 'schedules.presetHourly', cron: ['0', '*', '*', '*', '*'] },
  { label: 'schedules.presetNightly', cron: ['0', '5', '*', '*', '*'] },
  { label: 'schedules.presetWeekly', cron: ['0', '5', '*', '*', '1'] },
  { label: 'schedules.presetMonthly', cron: ['0', '4', '1', '*', '*'] },
] as const satisfies readonly { label: MessageKey; cron: readonly string[] }[];

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
  const { t, locale } = useTranslation();

  const [draft, setDraft] = useState<Schedule | null>(null);
  const [failure, setFailure] = useState<string | null>(null);

  const schedules = useQuery({
    queryKey: ['server', uuid, 'schedules'],
    queryFn: () => api.get<{ data: Schedule[] }>(`/api/servers/${uuid}/schedules`),
    // A running task finishes without telling the browser: poll while one is
    // still running, then stop.
    refetchInterval: (query) =>
      query.state.data?.data.some((schedule) => schedule.running) ? 5000 : false,
  });

  const refresh = (): void => {
    void queryClient.invalidateQueries({ queryKey: ['server', uuid, 'schedules'] });
  };

  const fail = (error: unknown): void => {
    setFailure(error instanceof ApiError ? error.message : t('common.operationFailed'));
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
    return <Spinner label={t('common.loading')} />;
  }

  const list = schedules.data?.data ?? [];

  return (
    <>
      <PageHeader
        title={t('schedules.title')}
        description={t('schedules.subtitle')}
        action={
          can('schedule.create') ? (
            <Button variant="primary" onClick={() => setDraft({ ...EMPTY })}>
              {t('schedules.new')}
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
        <EmptyState title={t('schedules.empty')} description={t('schedules.emptyHint')} />
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
                    {schedule.running ? <Badge tone="warn">{t('schedules.running')}</Badge> : null}
                    {!schedule.active ? <Badge>{t('schedules.inactive')}</Badge> : null}
                    {schedule.onlyWhenOnline ? <Badge>{t('schedules.whenOnline')}</Badge> : null}
                  </div>

                  <p className="mt-1 text-xs text-content-muted">
                    {t('schedules.stepCount', { count: schedule.tasks.length })}
                    {schedule.nextRunAt
                      ? ` · ${t('schedules.nextRun', { date: formatDate(schedule.nextRunAt, locale) })}`
                      : ` · ${t('schedules.noNextRun')}`}
                    {schedule.lastRunAt
                      ? ` · ${t('schedules.lastRun', { date: formatDate(schedule.lastRunAt, locale) })}`
                      : null}
                  </p>

                  <ol className="mt-2 flex flex-col gap-1">
                    {schedule.tasks.map((task, index) => (
                      <li key={task.uuid ?? index} className="text-xs text-content-muted">
                        {index + 1}. {t(ACTION_LABELS[task.action])}
                        {task.payload ? ` — ${task.payload.split('\n')[0]}` : null}
                        {task.offsetSeconds > 0
                          ? ` (${t('schedules.afterSeconds', { seconds: task.offsetSeconds })})`
                          : null}
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
                      {t('schedules.run')}
                    </Button>
                  ) : null}
                  {can('schedule.update') ? (
                    <Button variant="ghost" onClick={() => setDraft(schedule)}>
                      {t('common.edit')}
                    </Button>
                  ) : null}
                  {can('schedule.delete') ? (
                    <Button
                      variant="danger"
                      onClick={() => {
                        if (window.confirm(t('schedules.deleteConfirm', { name: schedule.name }))) {
                          remove.mutate(schedule.uuid);
                        }
                      }}
                    >
                      {t('common.delete')}
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
        title={t(draft?.uuid ? 'schedules.editTitle' : 'schedules.createTitle')}
        onClose={() => setDraft(null)}
        footer={
          <>
            <Button variant="ghost" onClick={() => setDraft(null)}>
              {t('common.cancel')}
            </Button>
            <Button
              variant="primary"
              onClick={() => draft && save.mutate(draft)}
              disabled={save.isPending || !draft?.name.trim()}
            >
              {save.isPending ? t('common.saving') : t('common.save')}
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
  const { t } = useTranslation();
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
      <Field label={t('schedules.name')}>
        <Input
          value={value.name}
          onChange={(event) => patch({ name: event.target.value })}
          placeholder={t('schedules.namePlaceholder')}
        />
      </Field>

      <div>
        <span className="mb-1.5 block text-sm font-medium text-content">
          {t('schedules.schedule')}
        </span>
        <div className="grid grid-cols-5 gap-2">
          {(
            [
              ['minute', 'schedules.cronMinute'],
              ['hour', 'schedules.cronHour'],
              ['dayOfMonth', 'schedules.cronDayOfMonth'],
              ['month', 'schedules.cronMonth'],
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

        <p className="mt-2 text-xs text-content-muted">{t('schedules.cronHint')}</p>
      </div>

      <Toggle
        checked={value.active}
        onChange={(active) => patch({ active })}
        label={t('schedules.active')}
        description={t('schedules.activeHint')}
      />

      <Toggle
        checked={value.onlyWhenOnline}
        onChange={(onlyWhenOnline) => patch({ onlyWhenOnline })}
        label={t('schedules.onlyWhenOnline')}
        description={t('schedules.onlyWhenOnlineHint')}
      />

      <div>
        <span className="mb-2 block text-sm font-medium text-content">{t('schedules.steps')}</span>

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
                  {t('schedules.afterLabel')}
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
                    {t('schedules.removeStep')}
                  </Button>
                ) : null}
              </div>

              {task.action !== 'POWER' ? (
                <textarea
                  className="mt-2 min-h-16 w-full rounded-lg border border-border-subtle bg-surface-raised px-3 py-2 font-mono text-xs text-content placeholder:text-content-subtle"
                  placeholder={
                    task.action === 'COMMAND'
                      ? t('schedules.payloadCommand')
                      : t('schedules.payloadBackup')
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
                {t('schedules.continueOnFailure')}
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
          {t('schedules.addStep')}
        </Button>

        <p className="mt-2 text-xs text-content-muted">{t('schedules.offsetHint')}</p>
      </div>
    </div>
  );
}
