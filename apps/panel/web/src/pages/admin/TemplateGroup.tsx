import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRef, useState, type FormEvent } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { DownloadIcon } from '../../components/icons';
import { PageHeader } from '../../components/PageHeader';
import { Alert, Badge, Button, Card, EmptyState, Field, Input, Spinner } from '../../components/ui';
import { useTranslation } from '../../i18n';
import { downloadJson } from '../../lib/download';
import { ApiError, api, type TemplateGroupSummary, type TemplateSummary } from '../../lib/api';

/**
 * One group, its templates, and the two ways a template gets into it.
 *
 * The group's own fields are edited here rather than on the listing because
 * this is the only screen that can show what the two refusals depend on: a
 * group is undeletable while it holds templates, and the templates are on this
 * page.
 *
 * There is no route fetching a single group — the listing is one query for the
 * whole instance and a group is found in it. That is deliberate rather than
 * lazy: the same query already backs the previous screen, so arriving here from
 * it costs nothing, and a group's row is three short strings.
 */
export function AdminTemplateGroupPage() {
  const { uuid = '' } = useParams();
  const { t } = useTranslation();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState(false);
  const picker = useRef<HTMLInputElement>(null);
  const [unreadable, setUnreadable] = useState<string | null>(null);

  const groups = useQuery({
    queryKey: ['admin', 'template-groups'],
    queryFn: () => api.get<TemplateGroupSummary[]>('/api/admin/templates/groups'),
  });

  const templates = useQuery({
    queryKey: ['admin', 'templates'],
    queryFn: () => api.get<TemplateSummary[]>('/api/admin/templates'),
  });

  // Resolved before the hooks below rather than after the loading guard: they
  // close over it, and every hook has to run before the first early return.
  const group = groups.data?.find((candidate) => candidate.uuid === uuid);

  const remove = useMutation({
    mutationFn: () => api.delete(`/api/admin/templates/groups/${uuid}`),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['admin', 'template-groups'] });
      void navigate('/admin/templates');
    },
  });

  /**
   * Uploading a Pterodactyl egg.
   *
   * The mutation lives on the page rather than inside a card of its own,
   * because the button that starts it is in the header: "Import an egg" opens
   * the file dialog directly. It used to unfold a panel whose only content was
   * a second button saying "Choose a file", which is two clicks and an
   * explanation to do the thing the first button already named.
   *
   * There is still something to render afterwards, and it is the reason the
   * result is not a toast: an import that succeeds routinely drops something
   * the egg declared — a `file` parser whose semantics differ here, a
   * `{{config.*}}` token nothing on this side can resolve — and that list is
   * the only warning before the first server built from it fails to start.
   */
  const upload = useMutation({
    mutationFn: (egg: unknown) =>
      api.post<{ template: TemplateSummary; warnings: string[] }>('/api/admin/templates/import', {
        egg,
        group: group?.name,
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['admin', 'templates'] });
      void queryClient.invalidateQueries({ queryKey: ['admin', 'template-groups'] });
    },
  });

  async function importEgg(file: File): Promise<void> {
    setUnreadable(null);
    upload.reset();

    let parsed: unknown;

    try {
      parsed = JSON.parse(await file.text());
    } catch {
      // Read here rather than posted: an egg saved from a browser tab as HTML
      // is the common mistake, and "unexpected token <" from the API says less
      // than the file's own name does.
      setUnreadable(t('adminTemplateGroup.notJson', { file: file.name }));
      return;
    }

    upload.mutate(parsed);
  }

  if (groups.isLoading || templates.isLoading) {
    return <Spinner label={t('common.loading')} />;
  }

  if (!group) {
    return (
      <EmptyState
        title={t('adminTemplateGroup.missing')}
        description={t('adminTemplateGroup.missingHint')}
        action={
          <Link to="/admin/templates">
            <Button>{t('adminTemplateGroup.back')}</Button>
          </Link>
        }
      />
    );
  }

  const owned = (templates.data ?? []).filter((template) => template.group.uuid === uuid);

  return (
    <>
      <PageHeader
        title={group.name}
        description={
          <Link to="/admin/templates" className="hover:text-content">
            ← {t('adminTemplateGroup.back')}
          </Link>
        }
        action={
          <div className="flex gap-2">
            <Button onClick={() => setEditing((value) => !value)}>
              {editing ? t('common.cancel') : t('common.edit')}
            </Button>
            <Button disabled={upload.isPending} onClick={() => picker.current?.click()}>
              {upload.isPending
                ? t('adminTemplateGroup.importing')
                : t('adminTemplateGroup.importEgg')}
            </Button>
            <Link to={`/admin/templates/groups/${uuid}/new`}>
              <Button variant="primary">{t('adminTemplateGroup.newTemplate')}</Button>
            </Link>
          </div>
        }
      />

      {/* Always mounted, never shown: the header button is what opens it, and a
          file input rendered only while some panel is open cannot be clicked by
          a button that is the thing opening the panel. */}
      <input
        ref={picker}
        type="file"
        accept="application/json,.json"
        className="hidden"
        onChange={(event) => {
          const file = event.target.files?.[0];

          if (file) {
            void importEgg(file);
          }

          // Cleared so that picking the same file twice fires a second change:
          // correcting an egg and re-uploading it is the ordinary case.
          event.target.value = '';
        }}
      />

      {editing ? <GroupSettingsCard group={group} onSaved={() => setEditing(false)} /> : null}

      <ImportOutcome unreadable={unreadable} error={upload.error} result={upload.data} />

      {owned.length === 0 ? (
        <EmptyState
          title={t('adminTemplateGroup.empty')}
          description={t('adminTemplateGroup.emptyHint')}
        />
      ) : (
        <div className="flex flex-col gap-2">
          {owned.map((template) => (
            <Link key={template.uuid} to={`/admin/templates/${template.uuid}`} className="block">
              <Card className="transition-colors hover:border-accent/50">
                <div className="flex flex-wrap items-start justify-between gap-4">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-medium text-content">{template.name}</span>
                      {/* A hand-edited template is no longer overwritten by the
                          resync: flagging it avoids believing it still follows
                          the catalogue. */}
                      {template.modifiedByAdmin ? (
                        <Badge tone="warn">{t('adminTemplates.modified')}</Badge>
                      ) : null}
                    </div>

                    {template.description ? (
                      <p className="mt-1 text-sm text-content-muted">{template.description}</p>
                    ) : null}
                    <p className="mt-1 text-xs text-content-subtle">
                      {template.author} · <span className="font-mono">{template.key}</span>
                    </p>
                  </div>

                  <div className="flex items-center gap-4">
                    <dl className="text-xs">
                      <dt className="text-content-muted">{t('adminTemplates.servers')}</dt>
                      <dd className="mt-0.5 text-content">{template.serverCount}</dd>
                    </dl>

                    <ExportButton uuid={template.uuid} templateKey={template.key} />
                  </div>
                </div>
              </Card>
            </Link>
          ))}
        </div>
      )}

      <Card className="mt-6 border-danger/40">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div>
            <h2 className="font-medium text-content">{t('adminTemplateGroup.deleteTitle')}</h2>
            <p className="mt-1 text-sm text-content-muted">{t('adminTemplateGroup.deleteHint')}</p>
          </div>

          <Button
            variant="danger"
            disabled={remove.isPending}
            onClick={() => {
              if (window.confirm(t('adminTemplateGroup.deleteConfirm', { name: group.name }))) {
                remove.mutate();
              }
            }}
          >
            {t('common.delete')}
          </Button>
        </div>

        {/* The API refuses a group that still holds templates and says how
            many. Rendered here rather than swallowed: the count is the whole
            instruction. */}
        {remove.error instanceof ApiError ? (
          <div className="mt-4">
            <Alert>{remove.error.message}</Alert>
          </div>
        ) : null}
      </Card>
    </>
  );
}

/**
 * Downloading one template as a Pterodactyl egg.
 *
 * Inside the row's `<Link>`, so the click has to be stopped from following it:
 * a button that both exports the template and navigates away from the list is a
 * button nobody presses twice.
 */
export function ExportButton({ uuid, templateKey }: { uuid: string; templateKey: string }) {
  const { t } = useTranslation();

  const download = useMutation({
    mutationFn: async () => {
      const egg = await api.get<unknown>(`/api/admin/templates/${uuid}/export`);

      // `egg-<key>.json` is what Pterodactyl names its own exports, so a file
      // from either panel lands in a downloads folder looking like the other's.
      downloadJson(`egg-${templateKey}.json`, egg);
    },
  });

  return (
    <Button
      variant="ghost"
      title={t('adminTemplate.export')}
      aria-label={t('adminTemplate.export')}
      disabled={download.isPending}
      onClick={(event) => {
        event.preventDefault();
        event.stopPropagation();
        download.mutate();
      }}
    >
      <DownloadIcon className="size-4" />
    </Button>
  );
}

/**
 * The group's own three fields, behind the header's Edit.
 *
 * It used to sit open below the templates, between them and the delete card,
 * on every visit — a form nobody had asked for, under a heading that repeated
 * the page title, offering to rename the thing the reader had just navigated
 * into. Reading a group is the common case and editing one is rare, so the
 * rare one now costs a click and the common one costs nothing.
 *
 * Not deleted outright: `author` exists as a column for this form and nowhere
 * else, and the only description a group will ever have is the one typed here.
 */
function GroupSettingsCard({
  group,
  onSaved,
}: {
  group: TemplateGroupSummary;
  onSaved: () => void;
}) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [form, setForm] = useState({
    name: group.name,
    description: group.description,
    author: group.author,
  });

  const save = useMutation({
    mutationFn: () => api.patch(`/api/admin/templates/groups/${group.uuid}`, form),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['admin', 'template-groups'] });
      // Closed on success, so the page returns to what it is for. A refusal
      // keeps it open, because the message belongs next to the field.
      onSaved();
    },
  });

  function handleSubmit(event: FormEvent): void {
    event.preventDefault();
    save.mutate();
  }

  return (
    <Card className="mb-6">
      <form onSubmit={handleSubmit} className="space-y-4">
        {/* Renaming a group the bundled catalogue installs into is refused, and
            the message explains that the next resynchronisation would recreate
            it and split the group in two. */}
        {save.error instanceof ApiError ? <Alert>{save.error.message}</Alert> : null}

        <div className="grid gap-4 sm:grid-cols-2">
          <Field label={t('adminTemplates.groupName')}>
            <Input
              value={form.name}
              onChange={(event) => setForm({ ...form, name: event.target.value })}
              maxLength={100}
              required
            />
          </Field>

          <Field label={t('adminTemplates.groupAuthor')} hint={t('adminTemplates.groupAuthorHint')}>
            <Input
              value={form.author}
              onChange={(event) => setForm({ ...form, author: event.target.value })}
              maxLength={100}
            />
          </Field>
        </div>

        <Field label={t('adminTemplates.groupDescription')}>
          <Input
            value={form.description}
            onChange={(event) => setForm({ ...form, description: event.target.value })}
            maxLength={1000}
          />
        </Field>

        <Button type="submit" variant="primary" disabled={save.isPending}>
          {save.isPending ? t('common.saving') : t('common.save')}
        </Button>
      </form>
    </Card>
  );
}

/**
 * What an import left behind.
 *
 * Rendered only once there is something to say, so the page carries nothing
 * about importing until an egg has actually been picked. The warnings are the
 * reason a *successful* import is worth reporting at all: one routinely drops
 * something the egg declared, and this list is the only notice before the
 * first server built from it fails to start.
 */
function ImportOutcome({
  unreadable,
  error,
  result,
}: {
  unreadable: string | null;
  error: unknown;
  result: { template: TemplateSummary; warnings: string[] } | undefined;
}) {
  const { t } = useTranslation();

  if (unreadable) {
    return (
      <div className="mb-6">
        <Alert>{unreadable}</Alert>
      </div>
    );
  }

  if (error instanceof ApiError) {
    return (
      <div className="mb-6">
        <Alert>
          {error.message}
          {/* The importer returns the field-by-field reasons, and without them
              "the egg is invalid" is not something anyone can act on. */}
          {error.issues?.length ? (
            <ul className="mt-2 list-inside list-disc font-mono text-xs">
              {error.issues.map((issue) => (
                <li key={`${issue.path}:${issue.message}`}>
                  {issue.path}: {issue.message}
                </li>
              ))}
            </ul>
          ) : null}
        </Alert>
      </div>
    );
  }

  if (!result) {
    return null;
  }

  return (
    <div className="mb-6">
      <Alert tone="info">
        <p>{t('adminTemplateGroup.imported', { name: result.template.name })}</p>

        {result.warnings.length > 0 ? (
          <>
            <p className="mt-2 font-medium">{t('adminTemplateGroup.warnings')}</p>
            <ul className="mt-1 list-inside list-disc text-xs">
              {result.warnings.map((warning) => (
                <li key={warning}>{warning}</li>
              ))}
            </ul>
          </>
        ) : null}
      </Alert>
    </div>
  );
}
