import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { PageHeader } from '../../components/PageHeader';
import { Alert, Badge, Button, Card, EmptyState, Spinner } from '../../components/ui';
import { useTranslation, type MessageKey } from '../../i18n';
import { ApiError, api, type TemplateDetail, type TemplateGroupSummary } from '../../lib/api';
import {
  blankDraft,
  buildPayload,
  draftFromDetail,
  type DraftError,
  type TemplateDraft,
} from '../../lib/template-draft';
import { ExportButton } from './TemplateGroup';
import { FilesTab, GeneralTab, InstallTab, ProcessTab, VariablesTab } from './TemplateEditorTabs';

/**
 * Writing a template by hand.
 *
 * One form and one save, across five tabs, because a template is one row: the
 * API takes the whole thing and the tabs are a way of reading it, not five
 * separate saves. Switching tab therefore keeps the edits — the draft lives
 * here, above them.
 *
 * What this screen changes about the servers already built from the template is
 * worth knowing before using it, and the API's own documentation is the place
 * it is written out. The short version, which the notice below says: the
 * startup command and the Docker image are copies taken at creation and are not
 * touched, while the stop, the readiness, the configuration files and the whole
 * install block are read live and reach every existing server the moment its
 * daemon next fetches.
 */

const TABS = [
  ['general', 'adminTemplate.tabGeneral'],
  ['process', 'adminTemplate.tabProcess'],
  ['files', 'adminTemplate.tabFiles'],
  ['install', 'adminTemplate.tabInstall'],
  ['variables', 'adminTemplate.tabVariables'],
] as const satisfies readonly (readonly [string, MessageKey])[];

type Tab = (typeof TABS)[number][0];

export function AdminTemplateEditorPage() {
  // One component on two routes: `/admin/templates/:uuid` edits, and
  // `/admin/templates/groups/:groupUuid/new` creates. Only the matched
  // parameter is present, which is what tells the two apart.
  const { uuid, groupUuid } = useParams();
  const { t } = useTranslation();

  const groups = useQuery({
    queryKey: ['admin', 'template-groups'],
    queryFn: () => api.get<TemplateGroupSummary[]>('/api/admin/templates/groups'),
  });

  const detail = useQuery({
    queryKey: ['admin', 'template', uuid],
    queryFn: () => api.get<TemplateDetail>(`/api/admin/templates/${uuid}/detail`),
    enabled: uuid !== undefined,
  });

  if (groups.isLoading || detail.isLoading) {
    return <Spinner label={t('common.loading')} />;
  }

  if (detail.error instanceof ApiError) {
    return (
      <EmptyState
        title={t('adminTemplate.missing')}
        description={detail.error.message}
        action={
          <Link to="/admin/templates">
            <Button>{t('adminTemplateGroup.back')}</Button>
          </Link>
        }
      />
    );
  }

  const names = (groups.data ?? []).map((group) => group.name);
  const group = (groups.data ?? []).find((candidate) => candidate.uuid === groupUuid);

  if (detail.data) {
    return (
      <TemplateForm
        // Remounted when the route changes template, so the draft is seeded
        // from the one being edited rather than left over from the last one.
        key={detail.data.uuid}
        template={detail.data}
        initial={draftFromDetail(detail.data)}
        groups={names}
      />
    );
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

  return (
    <TemplateForm
      key={group.uuid}
      template={null}
      initial={blankDraft(group.name)}
      groups={names}
    />
  );
}

function TemplateForm({
  template,
  initial,
  groups,
}: {
  /** `null` while creating: there is nothing to delete and nothing to warn about. */
  template: TemplateDetail | null;
  initial: TemplateDraft;
  groups: string[];
}) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [tab, setTab] = useState<Tab>('general');
  const [draft, setDraft] = useState(initial);
  const [errors, setErrors] = useState<DraftError[]>([]);
  const [saved, setSaved] = useState(false);

  const save = useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      template
        ? api.patch<TemplateDetail>(`/api/admin/templates/${template.uuid}`, body)
        : api.post<TemplateDetail>('/api/admin/templates', body),
    onSuccess: (result) => {
      setSaved(true);
      void queryClient.invalidateQueries({ queryKey: ['admin', 'templates'] });
      void queryClient.invalidateQueries({ queryKey: ['admin', 'template-groups'] });
      void queryClient.invalidateQueries({ queryKey: ['admin', 'template', result.uuid] });

      if (!template) {
        void navigate(`/admin/templates/${result.uuid}`);
      }
    },
  });

  const remove = useMutation({
    mutationFn: () => api.delete(`/api/admin/templates/${template?.uuid}`),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['admin', 'templates'] });
      void navigate(`/admin/templates/groups/${template?.group.uuid ?? ''}`);
    },
  });

  function patch(partial: Partial<TemplateDraft>): void {
    setSaved(false);
    setDraft((current) => ({ ...current, ...partial }));
  }

  function submit(): void {
    const result = buildPayload(draft, template ? 'update' : 'create');

    setErrors(result.ok ? [] : result.errors);

    if (result.ok) {
      save.mutate(result.body);
    }
  }

  const props = { draft, patch, errors, groups };

  return (
    <>
      <PageHeader
        title={template ? draft.name || template.name : t('adminTemplate.newTitle')}
        description={
          <Link
            to={template ? `/admin/templates/groups/${template.group.uuid}` : '/admin/templates'}
            className="hover:text-content"
          >
            ← {template ? template.group.name : t('adminTemplateGroup.back')}
          </Link>
        }
        action={
          <div className="flex items-center gap-3">
            {saved && !save.error ? (
              <span className="text-sm text-content-muted">{t('common.saved')}</span>
            ) : null}
            {/* The template as it is stored, not as the form currently holds
                it: an export of unsaved edits would be a file describing a
                template that exists nowhere. */}
            {template ? <ExportButton uuid={template.uuid} templateKey={template.key} /> : null}
            <Button variant="primary" onClick={submit} disabled={save.isPending}>
              {save.isPending ? t('common.saving') : t('common.save')}
            </Button>
          </div>
        }
      />

      {template ? (
        <div className="mb-4 flex flex-wrap items-center gap-2">
          <span className="font-mono text-xs text-content-subtle">{template.key}</span>
          {template.modifiedByAdmin ? (
            <Badge tone="warn">{t('adminTemplates.modified')}</Badge>
          ) : null}
          {template.importedFromEgg ? <Badge>{t('adminTemplate.importedFromEgg')}</Badge> : null}
          {template.serverCount > 0 ? (
            <Badge>{t('adminTemplate.serverCount', { count: template.serverCount })}</Badge>
          ) : null}
        </div>
      ) : null}

      {/* Shown once, above everything, because it is the thing an operator is
          most likely to get wrong: editing the startup command of a template
          with servers on it and expecting those servers to change. */}
      {template && template.serverCount > 0 ? (
        <div className="mb-4">
          <Alert tone="info">{t('adminTemplate.liveWarning')}</Alert>
        </div>
      ) : null}

      <div className="-mx-4 mb-4 flex gap-1 overflow-x-auto px-4">
        {TABS.map(([key, label]) => (
          <button
            key={key}
            type="button"
            onClick={() => setTab(key)}
            className={
              tab === key
                ? 'whitespace-nowrap rounded-lg bg-surface-hover px-3 py-2 text-sm font-medium text-content'
                : 'whitespace-nowrap rounded-lg px-3 py-2 text-sm text-content-muted hover:bg-surface-hover hover:text-content'
            }
          >
            {t(label)}
          </button>
        ))}
      </div>

      {/* The refusals worth reading are all here: a key the catalogue owns, a
          name already taken in the group, a stop no existing server could
          answer, an install container the daemon's own contract refuses. */}
      {save.error instanceof ApiError ? (
        <div className="mb-4">
          <Alert>
            {save.error.message}
            {save.error.issues?.length ? (
              <ul className="mt-2 list-inside list-disc font-mono text-xs">
                {save.error.issues.map((issue) => (
                  <li key={`${issue.path}:${issue.message}`}>
                    {issue.path}: {issue.message}
                  </li>
                ))}
              </ul>
            ) : null}
          </Alert>
        </div>
      ) : null}

      {/* A field the browser refused is on a tab that may not be the one in
          front of the operator, so the summary names the tab as well. */}
      {errors.length > 0 ? (
        <div className="mb-4">
          <Alert>{t('adminTemplate.draftInvalid')}</Alert>
        </div>
      ) : null}

      {tab === 'general' ? <GeneralTab {...props} /> : null}
      {tab === 'process' ? <ProcessTab {...props} /> : null}
      {tab === 'files' ? <FilesTab {...props} /> : null}
      {tab === 'install' ? <InstallTab {...props} /> : null}
      {tab === 'variables' ? <VariablesTab {...props} /> : null}

      {template ? (
        <Card className="mt-6 border-danger/40">
          <div className="flex flex-wrap items-center justify-between gap-4">
            <div>
              <h2 className="font-medium text-content">{t('adminTemplate.deleteTitle')}</h2>
              <p className="mt-1 text-sm text-content-muted">{t('adminTemplate.deleteHint')}</p>
            </div>

            <Button
              variant="danger"
              disabled={remove.isPending}
              onClick={() => {
                if (window.confirm(t('adminTemplate.deleteConfirm', { name: template.name }))) {
                  remove.mutate();
                }
              }}
            >
              {t('common.delete')}
            </Button>
          </div>

          {remove.error instanceof ApiError ? (
            <div className="mt-4">
              <Alert>{remove.error.message}</Alert>
            </div>
          ) : null}
        </Card>
      ) : null}
    </>
  );
}
