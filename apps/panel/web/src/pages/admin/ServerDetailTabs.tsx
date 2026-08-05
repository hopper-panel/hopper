import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type ReactNode } from 'react';
import { Alert, Badge, Button, Card, Spinner } from '../../components/ui';
import { useTranslation, type MessageKey } from '../../i18n';
import { api, ApiError } from '../../lib/api';

/**
 * The heavier tabs of the administration's server page.
 *
 * Split out because the page was becoming one file nobody could hold in their
 * head, and because these four are the ones that talk to endpoints an owner
 * also uses — keeping them together makes that shared surface visible.
 *
 * None of it is new API. Renaming, startup, allocations and databases all
 * existed for the owner's own tabs; an administrator reaches the same routes
 * with an administrator's permissions.
 */

export interface AdminServerSummary {
  uuid: string;
  name: string;
  description: string;
}

function Field({
  label,
  hint,
  children,
}: {
  label: MessageKey;
  hint?: MessageKey;
  children: ReactNode;
}) {
  const { t } = useTranslation();

  return (
    <label className="block">
      <span className="mb-1 block text-sm text-content">{t(label)}</span>
      {children}
      {hint ? <span className="mt-1 block text-xs text-content-subtle">{t(hint)}</span> : null}
    </label>
  );
}

const INPUT =
  'w-full rounded-lg border border-border-subtle bg-surface px-3 py-2 text-sm text-content';

/** Name and description, on the same endpoint an owner renames their own with. */
export function DetailsTab({
  server,
  onSaved,
}: {
  server: AdminServerSummary;
  onSaved: () => void;
}) {
  const { t } = useTranslation();
  const [name, setName] = useState(server.name);
  const [description, setDescription] = useState(server.description);

  const save = useMutation({
    mutationFn: () => api.patch(`/api/servers/${server.uuid}`, { name, description }),
    onSuccess: onSaved,
  });

  return (
    <Card>
      <form
        className="grid gap-4"
        onSubmit={(event) => {
          event.preventDefault();
          save.mutate();
        }}
      >
        <Field label="adminServer.name">
          <input
            value={name}
            onChange={(event) => setName(event.target.value)}
            maxLength={100}
            className={INPUT}
          />
        </Field>

        <Field label="adminServer.description">
          <textarea
            value={description}
            onChange={(event) => setDescription(event.target.value)}
            maxLength={1000}
            rows={3}
            className={INPUT}
          />
        </Field>

        {save.error instanceof ApiError ? <Alert tone="danger">{save.error.message}</Alert> : null}

        <div>
          <Button type="submit" variant="primary" disabled={save.isPending}>
            {save.isPending ? t('adminServer.saving') : t('adminServer.save')}
          </Button>
        </div>
      </form>
    </Card>
  );
}

interface StartupView {
  startupCommand: string;
  dockerImage: string;
  dockerImages: { name: string; image: string }[];
  variables: {
    envVariable: string;
    name: string;
    description: string;
    value: string;
    editable: boolean;
  }[];
}

/**
 * The command, the image and the template's variables.
 *
 * The command is shown but not editable. It belongs to the template, and a
 * server whose line diverges from the one its template installs stops being
 * reproducible: reinstalling would silently change how it starts.
 */
export function StartupTab({ server }: { server: AdminServerSummary }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [image, setImage] = useState<string | null>(null);

  const startup = useQuery({
    queryKey: ['admin', 'server', server.uuid, 'startup'],
    queryFn: () => api.get<StartupView>(`/api/servers/${server.uuid}/startup`),
  });

  const save = useMutation({
    mutationFn: () =>
      api.patch(`/api/servers/${server.uuid}/startup`, {
        variables: draft,
        ...(image ? { dockerImage: image } : {}),
      }),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: ['admin', 'server', server.uuid, 'startup'] }),
  });

  if (startup.isPending) {
    return <Spinner />;
  }

  if (startup.error instanceof ApiError) {
    return <Alert tone="danger">{startup.error.message}</Alert>;
  }

  const data = startup.data!;
  const known = data.dockerImages.some((option) => option.image === data.dockerImage);

  return (
    <div className="grid gap-4">
      <Card>
        <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-content">
          {t('adminServer.command')}
        </h2>
        <pre className="overflow-x-auto rounded-lg bg-surface p-3 font-mono text-xs text-content">
          {data.startupCommand}
        </pre>
        <p className="mt-2 text-xs text-content-subtle">{t('adminServer.commandHint')}</p>
      </Card>

      <Card>
        <form
          className="grid gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            save.mutate();
          }}
        >
          <Field label="adminServer.image" hint="adminServer.imageHint">
            <select
              value={image ?? data.dockerImage}
              onChange={(event) => setImage(event.target.value)}
              className={INPUT}
            >
              {/* The current image is listed even when the template no longer
                  offers it: a template edited afterwards must not make this
                  field show something the server is not running. */}
              {known ? null : <option value={data.dockerImage}>{data.dockerImage}</option>}
              {data.dockerImages.map((option) => (
                <option key={option.image} value={option.image}>
                  {option.name} — {option.image}
                </option>
              ))}
            </select>
          </Field>

          {data.variables.map((variable) => (
            <label key={variable.envVariable} className="block">
              <span className="mb-1 block text-sm text-content">
                {variable.name}
                <code className="ml-2 font-mono text-xs text-content-subtle">
                  {variable.envVariable}
                </code>
              </span>
              <input
                value={draft[variable.envVariable] ?? variable.value}
                onChange={(event) =>
                  setDraft({ ...draft, [variable.envVariable]: event.target.value })
                }
                className={INPUT}
              />
              {variable.description ? (
                <span className="mt-1 block text-xs text-content-subtle">
                  {variable.description}
                </span>
              ) : null}
            </label>
          ))}

          {save.error instanceof ApiError ? (
            <Alert tone="danger">{save.error.message}</Alert>
          ) : null}

          <div>
            <p className="mb-3 text-sm text-content-muted">{t('adminServer.rebuildNotice')}</p>
            <Button type="submit" variant="primary" disabled={save.isPending}>
              {save.isPending ? t('adminServer.saving') : t('adminServer.save')}
            </Button>
          </div>
        </form>
      </Card>
    </div>
  );
}

interface Allocation {
  id: number;
  ip: string;
  port: number;
  alias: string | null;
  primary: boolean;
}

export function NetworkTab({ server }: { server: AdminServerSummary }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();

  const allocations = useQuery({
    queryKey: ['admin', 'server', server.uuid, 'allocations'],
    queryFn: () => api.get<Allocation[]>(`/api/servers/${server.uuid}/allocations`),
  });

  const reload = (): Promise<void> =>
    queryClient.invalidateQueries({ queryKey: ['admin', 'server', server.uuid, 'allocations'] });

  const makePrimary = useMutation({
    mutationFn: (id: number) =>
      api.post(`/api/servers/${server.uuid}/allocations/${id}/primary`, {}),
    onSuccess: reload,
  });

  const remove = useMutation({
    mutationFn: (id: number) => api.delete(`/api/servers/${server.uuid}/allocations/${id}`),
    onSuccess: reload,
  });

  if (allocations.isPending) {
    return <Spinner />;
  }

  if (allocations.error instanceof ApiError) {
    return <Alert tone="danger">{allocations.error.message}</Alert>;
  }

  return (
    <Card>
      {allocations.data?.length === 0 ? (
        <p className="text-sm text-content-muted">{t('adminServer.noAllocations')}</p>
      ) : null}

      <ul className="grid gap-2">
        {allocations.data?.map((allocation) => (
          <li
            key={allocation.id}
            className="flex flex-wrap items-center justify-between gap-2 border-b border-border-subtle/50 pb-2 text-sm last:border-0 last:pb-0"
          >
            <span className="flex items-center gap-2 font-mono text-content">
              {allocation.alias ?? allocation.ip}:{allocation.port}
              {allocation.primary ? <Badge tone="online">{t('adminServer.primary')}</Badge> : null}
            </span>

            {/* The primary carries no buttons at all rather than disabled ones:
                a server with no address is a server nobody reaches, and the API
                refuses both operations on it anyway. */}
            {allocation.primary ? null : (
              <div className="flex gap-2">
                <Button onClick={() => makePrimary.mutate(allocation.id)}>
                  {t('adminServer.makePrimary')}
                </Button>
                <Button variant="danger" onClick={() => remove.mutate(allocation.id)}>
                  {t('adminServer.remove')}
                </Button>
              </div>
            )}
          </li>
        ))}
      </ul>
    </Card>
  );
}

interface ServerDatabase {
  uuid: string;
  database: string;
  username: string;
  remote: string;
  host: { name: string };
}

export function DatabasesTab({ server }: { server: AdminServerSummary }) {
  const { t } = useTranslation();

  const databases = useQuery({
    queryKey: ['admin', 'server', server.uuid, 'databases'],
    queryFn: () => api.get<ServerDatabase[]>(`/api/servers/${server.uuid}/databases`),
  });

  if (databases.isPending) {
    return <Spinner />;
  }

  if (databases.error instanceof ApiError) {
    return <Alert tone="danger">{databases.error.message}</Alert>;
  }

  return (
    <Card>
      {databases.data?.length === 0 ? (
        <p className="text-sm text-content-muted">{t('adminServer.noDatabases')}</p>
      ) : (
        <ul className="grid gap-2 text-sm">
          {databases.data?.map((database) => (
            <li key={database.uuid} className="border-b border-border-subtle/50 pb-2 last:border-0">
              <span className="font-mono text-content">{database.database}</span>
              <span className="ml-2 text-content-subtle">
                {database.username}@{database.remote} · {database.host.name}
              </span>
            </li>
          ))}
        </ul>
      )}

      {/* Creating one stays on the owner's tab, which already asks for the host
          and the connection pattern. Two forms writing the same rows are two
          forms to keep in step, and the passwords belong on the side that shows
          them once. */}
      <p className="mt-3 text-xs text-content-subtle">{t('adminServer.databasesHint')}</p>
    </Card>
  );
}
