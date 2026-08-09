import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { PageHeader } from '../../components/PageHeader';
import { FormDialog } from '../../components/FormDialog';
import { Alert, Button, Card, EmptyState, Field, Input, Spinner } from '../../components/ui';
import { useTranslation } from '../../i18n';
import { ApiError, api, type TemplateGroupSummary } from '../../lib/api';

/**
 * The groups a template can live in — Pterodactyl calls them nests.
 *
 * The catalogue used to be one flat list of every template on the instance,
 * which was survivable while the instance held the eleven Hopper ships and
 * stopped being survivable the moment egg import worked: the public corpus is
 * 274 eggs, and a page listing all of them alphabetically is not a page an
 * operator can find anything in. So the top level is the groups, and a group's
 * templates are behind it.
 *
 * Groups are editable here because they are now something an operator owns
 * rather than a label the catalogue happened to install. What they cannot do
 * from this screen is delete one that still holds templates, or rename one the
 * bundled catalogue installs into — both are refused by the API, with the
 * reasoning, and both refusals are shown where the click happened.
 */
export function AdminTemplatesPage() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [creating, setCreating] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const groups = useQuery({
    queryKey: ['admin', 'template-groups'],
    queryFn: () => api.get<TemplateGroupSummary[]>('/api/admin/templates/groups'),
  });

  const sync = useMutation({
    mutationFn: () =>
      api.post<{ created: number; updated: number; skipped: number }>('/api/admin/templates/sync'),
    onSuccess: (result) => {
      setFailure(null);
      setNotice(
        t('adminTemplates.resynced', {
          created: result.created,
          updated: result.updated,
          // The API calls it `skipped` and the sentence calls them kept: the
          // page read `result.kept` for as long as it existed and rendered
          // "undefined kept because an administrator edited them" on every
          // synchronisation.
          kept: result.skipped,
        }),
      );
      void queryClient.invalidateQueries({ queryKey: ['admin', 'template-groups'] });
      void queryClient.invalidateQueries({ queryKey: ['admin', 'templates'] });
    },
    onError: (error: unknown) => {
      setNotice(null);
      setFailure(error instanceof ApiError ? error.message : t('adminTemplates.resyncFailed'));
    },
  });

  const create = useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      api.post<TemplateGroupSummary>('/api/admin/templates/groups', body),
    onSuccess: () => {
      setCreating(false);
      void queryClient.invalidateQueries({ queryKey: ['admin', 'template-groups'] });
    },
  });

  if (groups.isLoading) {
    return <Spinner label={t('common.loading')} />;
  }

  const list = groups.data ?? [];

  return (
    <>
      <PageHeader
        title={t('adminTemplates.title')}
        description={t('adminTemplates.subtitle')}
        action={
          <div className="flex gap-2">
            <Button onClick={() => sync.mutate()} disabled={sync.isPending}>
              {sync.isPending ? t('adminTemplates.resyncing') : t('adminTemplates.resync')}
            </Button>
            <Button variant="primary" onClick={() => setCreating(true)}>
              {t('adminTemplates.addGroup')}
            </Button>
          </div>
        }
      />

      {failure ? (
        <div className="mb-4">
          <Alert tone="danger">{failure}</Alert>
        </div>
      ) : null}

      {notice && !failure ? (
        <div className="mb-4">
          <Alert tone="info">{notice}</Alert>
        </div>
      ) : null}

      {creating ? (
        <GroupDialog
          onClose={() => setCreating(false)}
          onSubmit={(body) => create.mutate(body)}
          pending={create.isPending}
          error={create.error}
        />
      ) : null}

      {list.length === 0 ? (
        <EmptyState title={t('adminTemplates.empty')} description={t('adminTemplates.emptyHint')} />
      ) : (
        <div className="flex flex-col gap-2">
          {list.map((group) => (
            <Link key={group.uuid} to={`/admin/templates/groups/${group.uuid}`} className="block">
              <Card className="transition-colors hover:border-accent/50">
                <div className="flex flex-wrap items-center justify-between gap-4">
                  <div className="min-w-0">
                    <p className="font-medium text-content">{group.name}</p>
                    {group.description ? (
                      <p className="mt-1 text-sm text-content-muted">{group.description}</p>
                    ) : null}
                    {group.author ? (
                      <p className="mt-1 text-xs text-content-subtle">{group.author}</p>
                    ) : null}
                  </div>

                  <dl className="text-xs">
                    <dt className="text-content-muted">{t('adminTemplates.templates')}</dt>
                    <dd className="mt-0.5 text-content">{group.templateCount}</dd>
                  </dl>
                </div>
              </Card>
            </Link>
          ))}
        </div>
      )}
    </>
  );
}

/**
 * Creating a group.
 *
 * Rendered behind a condition rather than with an `open` prop, which is what
 * makes a dismissed dialog reopen empty — see {@link FormDialog}.
 */
function GroupDialog({
  onClose,
  onSubmit,
  pending,
  error,
}: {
  onClose: () => void;
  onSubmit: (body: Record<string, unknown>) => void;
  pending: boolean;
  error: unknown;
}) {
  const { t } = useTranslation();
  const [form, setForm] = useState({ name: '', description: '', author: '' });

  return (
    <FormDialog
      title={t('adminTemplates.addGroup')}
      formId="create-template-group"
      onClose={onClose}
      onSubmit={() => onSubmit(form)}
      submit={t('adminTemplates.createGroup')}
      submitting={t('adminTemplates.creating')}
      pending={pending}
      disabled={form.name.trim() === ''}
      error={error}
    >
      <Field label={t('adminTemplates.groupName')}>
        <Input
          value={form.name}
          onChange={(event) => setForm({ ...form, name: event.target.value })}
          placeholder="Rust"
          maxLength={100}
          autoFocus
        />
      </Field>

      <Field label={t('adminTemplates.groupAuthor')} hint={t('adminTemplates.groupAuthorHint')}>
        <Input
          value={form.author}
          onChange={(event) => setForm({ ...form, author: event.target.value })}
          maxLength={100}
        />
      </Field>

      <Field label={t('adminTemplates.groupDescription')}>
        <Input
          value={form.description}
          onChange={(event) => setForm({ ...form, description: event.target.value })}
          maxLength={1000}
        />
      </Field>
    </FormDialog>
  );
}
