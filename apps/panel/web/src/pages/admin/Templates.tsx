import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { PageHeader } from '../../components/PageHeader';
import { Alert, Badge, Button, Card, EmptyState, Spinner } from '../../components/ui';
import { useTranslation } from '../../i18n';
import { ApiError, api } from '../../lib/api';

interface Template {
  uuid: string;
  key: string | null;
  name: string;
  description: string;
  author: string;
  group: { uuid: string; name: string } | null;
  modifiedByAdmin: boolean;
  servers?: number;
}

/**
 * Template catalogue.
 *
 * Read-only, plus two actions: resynchronise the shipped catalogue, and import
 * a Pterodactyl egg. Editing a template from the interface is deliberately not
 * offered — a malformed template makes its servers impossible to install, and
 * the format is better fixed in a versioned file than in a form.
 */
export function AdminTemplatesPage() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [failure, setFailure] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const templates = useQuery({
    queryKey: ['admin', 'templates'],
    queryFn: () => api.get<Template[]>('/api/admin/templates'),
  });

  const sync = useMutation({
    mutationFn: () =>
      api.post<{ created: number; updated: number; kept: number }>('/api/admin/templates/sync'),
    onSuccess: (result) => {
      setFailure(null);
      setNotice(
        t('adminTemplates.resynced', {
          created: result.created,
          updated: result.updated,
          kept: result.kept,
        }),
      );
      void queryClient.invalidateQueries({ queryKey: ['admin', 'templates'] });
    },
    onError: (error: unknown) => {
      setNotice(null);
      setFailure(error instanceof ApiError ? error.message : t('adminTemplates.resyncFailed'));
    },
  });

  if (templates.isLoading) {
    return <Spinner label={t('common.loading')} />;
  }

  const list = templates.data ?? [];

  return (
    <>
      <PageHeader
        title={t('adminTemplates.title')}
        description={t('adminTemplates.subtitle')}
        action={
          <Button onClick={() => sync.mutate()} disabled={sync.isPending}>
            {sync.isPending ? t('adminTemplates.resyncing') : t('adminTemplates.resync')}
          </Button>
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

      {list.length === 0 ? (
        <EmptyState title={t('adminTemplates.empty')} description={t('adminTemplates.emptyHint')} />
      ) : (
        <div className="flex flex-col gap-2">
          {list.map((template) => (
            <Card key={template.uuid}>
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-medium text-content">{template.name}</span>
                    {template.group ? <Badge>{template.group.name}</Badge> : null}
                    {/* A hand-edited template is no longer overwritten by the
                        resync: flagging it avoids believing it still follows
                        the catalogue. */}
                    {template.modifiedByAdmin ? (
                      <Badge tone="warn">{t('adminTemplates.modified')}</Badge>
                    ) : null}
                  </div>

                  <p className="mt-1 text-sm text-content-muted">{template.description}</p>
                  <p className="mt-1 text-xs text-content-subtle">
                    {template.author}
                    {template.key ? ` · ${template.key}` : null}
                  </p>
                </div>
              </div>
            </Card>
          ))}
        </div>
      )}
    </>
  );
}
