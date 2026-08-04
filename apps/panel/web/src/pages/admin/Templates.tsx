import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { PageHeader } from '../../components/PageHeader';
import { Alert, Badge, Button, Card, EmptyState, Spinner } from '../../components/ui';
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
 * Catalogue des templates.
 *
 * En lecture, plus deux actions : resynchroniser le catalogue livré, et
 * importer un « egg » Pterodactyl. L'édition d'un template dans l'interface
 * n'est volontairement pas proposée — un template mal formé rend ses serveurs
 * impossibles à installer, et le format se corrige mieux dans un fichier
 * versionné que dans un formulaire.
 */
export function AdminTemplatesPage() {
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
        `${result.created} créé(s), ${result.updated} mis à jour, ${result.kept} conservé(s) ` +
          'car modifiés par un administrateur.',
      );
      void queryClient.invalidateQueries({ queryKey: ['admin', 'templates'] });
    },
    onError: (error: unknown) => {
      setNotice(null);
      setFailure(error instanceof ApiError ? error.message : 'Synchronisation impossible.');
    },
  });

  if (templates.isLoading) {
    return <Spinner label="Chargement du catalogue…" />;
  }

  const list = templates.data ?? [];

  return (
    <>
      <PageHeader
        title="Templates"
        description="Ce qu’un serveur installe et exécute : image Docker, script d’installation, variables."
        action={
          <Button onClick={() => sync.mutate()} disabled={sync.isPending}>
            {sync.isPending ? 'Synchronisation…' : 'Resynchroniser'}
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
        <EmptyState
          title="Aucun template"
          description="Resynchronisez pour installer le catalogue livré avec le panel."
        />
      ) : (
        <div className="flex flex-col gap-2">
          {list.map((template) => (
            <Card key={template.uuid}>
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-medium text-content">{template.name}</span>
                    {template.group ? <Badge>{template.group.name}</Badge> : null}
                    {/* Un template modifié à la main n'est plus écrasé par la
                        resynchronisation : le signaler évite de croire qu'il
                        suit encore le catalogue. */}
                    {template.modifiedByAdmin ? <Badge tone="warn">modifié</Badge> : null}
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
