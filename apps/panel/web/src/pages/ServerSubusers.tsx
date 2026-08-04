import { PERMISSION_DETAILS, PERMISSION_GROUPS, type Permission } from '@hopper/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useParams } from 'react-router-dom';
import { Modal } from '../components/Modal';
import { PageHeader } from '../components/PageHeader';
import { Alert, Button, Card, EmptyState, Field, Input, Spinner } from '../components/ui';
import { ApiError, api } from '../lib/api';
import { useServerContext } from '../lib/server-context';

interface Subuser {
  uuid: string;
  user: { uuid: string; username: string; email: string };
  permissions: Permission[];
  dangerous: Permission[];
  createdAt: string;
}

interface Draft {
  /** Vide pour une création. */
  uuid: string;
  email: string;
  permissions: Set<Permission>;
}

export function ServerSubusersPage() {
  const { uuid = '' } = useParams();
  const queryClient = useQueryClient();
  const { can, permissions: mine } = useServerContext();

  const [draft, setDraft] = useState<Draft | null>(null);
  const [failure, setFailure] = useState<string | null>(null);

  const subusers = useQuery({
    queryKey: ['server', uuid, 'subusers'],
    queryFn: () => api.get<{ data: Subuser[] }>(`/api/servers/${uuid}/subusers`),
  });

  const refresh = (): void => {
    void queryClient.invalidateQueries({ queryKey: ['server', uuid, 'subusers'] });
  };

  const fail = (error: unknown): void => {
    setFailure(error instanceof ApiError ? error.message : 'Opération impossible.');
  };

  const save = useMutation({
    mutationFn: (input: Draft) => {
      const permissions = [...input.permissions];

      return input.uuid
        ? api.patch<Subuser>(`/api/servers/${uuid}/subusers/${input.uuid}`, { permissions })
        : api.post<Subuser>(`/api/servers/${uuid}/subusers`, { email: input.email, permissions });
    },
    onSuccess: () => {
      setDraft(null);
      setFailure(null);
      refresh();
    },
    onError: fail,
  });

  const remove = useMutation({
    mutationFn: (subuserUuid: string) =>
      api.delete<void>(`/api/servers/${uuid}/subusers/${subuserUuid}`),
    onSuccess: refresh,
    onError: fail,
  });

  if (subusers.isLoading) {
    return <Spinner label="Chargement des sous-utilisateurs…" />;
  }

  const list = subusers.data?.data ?? [];

  return (
    <>
      <PageHeader
        title="Sous-utilisateurs"
        description="Comptes du panel autorisés à agir sur ce serveur, permission par permission."
        action={
          can('user.create') ? (
            <Button
              variant="primary"
              onClick={() => setDraft({ uuid: '', email: '', permissions: new Set() })}
            >
              Ajouter un accès
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
          title="Aucun sous-utilisateur"
          description="Un sous-utilisateur est un compte existant du panel à qui vous ouvrez ce serveur, avec les seules permissions que vous choisissez."
        />
      ) : (
        <div className="flex flex-col gap-2">
          {list.map((subuser) => (
            <Card key={subuser.uuid}>
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-medium text-content">{subuser.user.username}</span>
                    <span className="text-sm text-content-muted">{subuser.user.email}</span>
                  </div>

                  <p className="mt-1 text-xs text-content-muted">
                    {subuser.permissions.length} permission
                    {subuser.permissions.length > 1 ? 's' : ''} accordée
                    {subuser.permissions.length > 1 ? 's' : ''}
                  </p>
                </div>

                <div className="flex flex-wrap gap-2">
                  {can('user.update') ? (
                    <Button
                      variant="ghost"
                      onClick={() =>
                        setDraft({
                          uuid: subuser.uuid,
                          email: subuser.user.email,
                          permissions: new Set(subuser.permissions),
                        })
                      }
                    >
                      Permissions
                    </Button>
                  ) : null}
                  {can('user.delete') ? (
                    <Button
                      variant="danger"
                      onClick={() => {
                        if (window.confirm(`Retirer l’accès de ${subuser.user.username} ?`)) {
                          remove.mutate(subuser.uuid);
                        }
                      }}
                    >
                      Retirer
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
        title={draft?.uuid ? 'Permissions' : 'Ajouter un accès'}
        onClose={() => setDraft(null)}
        size="lg"
        footer={
          <>
            <Button variant="ghost" onClick={() => setDraft(null)}>
              Annuler
            </Button>
            <Button
              variant="primary"
              onClick={() => draft && save.mutate(draft)}
              disabled={save.isPending || (!draft?.uuid && !draft?.email.trim())}
            >
              {save.isPending ? 'Enregistrement…' : 'Enregistrer'}
            </Button>
          </>
        }
      >
        {draft ? (
          <div className="flex flex-col gap-5">
            {draft.uuid ? (
              <p className="text-sm text-content-muted">{draft.email}</p>
            ) : (
              <Field
                label="Adresse du compte"
                hint="Le compte doit déjà exister sur le panel : un accès s’accorde, il ne se crée pas ici."
              >
                <Input
                  type="email"
                  value={draft.email}
                  onChange={(event) => setDraft({ ...draft, email: event.target.value })}
                  placeholder="moderateur@exemple.fr"
                />
              </Field>
            )}

            <PermissionPicker
              selected={draft.permissions}
              grantable={mine}
              onChange={(permissions) => setDraft({ ...draft, permissions })}
            />
          </div>
        ) : null}
      </Modal>
    </>
  );
}

/**
 * Choix des permissions, un panneau par groupe.
 *
 * Chaque permission est accompagnée de ce qu'elle ouvre réellement. Sans cela,
 * on coche `file.create` en croyant autoriser l'envoi d'un fichier de
 * configuration, alors qu'on autorise le dépôt d'un greffon — donc l'exécution
 * de code arbitraire par le serveur. Une case sans explication se coche par
 * défaut ; une case expliquée se choisit.
 *
 * Seules les permissions que l'on possède soi-même sont proposées : l'API
 * refuse d'accorder plus que ce que l'on a, et afficher des cases qui feraient
 * échouer l'enregistrement serait une invitation à l'erreur.
 */
function PermissionPicker({
  selected,
  grantable,
  onChange,
}: {
  selected: Set<Permission>;
  grantable: Permission[];
  onChange: (permissions: Set<Permission>) => void;
}) {
  const toggle = (permission: Permission, checked: boolean): void => {
    const next = new Set(selected);

    if (checked) {
      next.add(permission);
    } else {
      next.delete(permission);
    }

    onChange(next);
  };

  const toggleGroup = (permissions: Permission[], checked: boolean): void => {
    const next = new Set(selected);

    for (const permission of permissions) {
      if (checked) {
        next.add(permission);
      } else {
        next.delete(permission);
      }
    }

    onChange(next);
  };

  return (
    <div className="flex flex-col gap-3">
      {Object.entries(PERMISSION_GROUPS).map(([key, group]) => {
        const available = group.permissions.filter((permission) => grantable.includes(permission));

        if (available.length === 0) {
          return null;
        }

        const all = available.every((permission) => selected.has(permission));
        const some = available.some((permission) => selected.has(permission)) && !all;

        return (
          <section
            key={key}
            className="overflow-hidden rounded-lg border border-border-subtle bg-surface"
          >
            <header className="flex items-center justify-between gap-3 border-b border-border-subtle bg-surface-raised px-4 py-2.5">
              <h3 className="text-sm font-semibold uppercase tracking-wide text-content">
                {group.label}
              </h3>

              <label className="flex items-center gap-2 text-xs text-content-muted">
                tout
                <input
                  type="checkbox"
                  aria-label={`Tout cocher dans « ${group.label} »`}
                  checked={all}
                  // L'état intermédiaire n'existe pas en HTML : sans lui, un
                  // groupe à moitié coché s'afficherait comme vide.
                  ref={(element) => {
                    if (element) {
                      element.indeterminate = some;
                    }
                  }}
                  onChange={(event) => toggleGroup(available, event.target.checked)}
                />
              </label>
            </header>

            <p className="px-4 pt-3 text-xs text-content-muted">{group.description}</p>

            <div className="flex flex-col gap-3 px-4 py-3">
              {available.map((permission) => {
                const detail = PERMISSION_DETAILS[permission];

                return (
                  <label key={permission} className="flex cursor-pointer items-start gap-3">
                    <input
                      type="checkbox"
                      className="mt-1"
                      checked={selected.has(permission)}
                      onChange={(event) => toggle(permission, event.target.checked)}
                    />

                    <span className="min-w-0">
                      <span className="flex flex-wrap items-center gap-2">
                        <span className="text-sm font-medium text-content">{detail.label}</span>
                        <code className="font-mono text-xs text-content-subtle">{permission}</code>
                      </span>

                      <span className="mt-0.5 block text-xs text-content-muted">
                        {detail.description}
                      </span>
                    </span>
                  </label>
                );
              })}
            </div>
          </section>
        );
      })}
    </div>
  );
}
