import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { PageHeader } from '../../components/PageHeader';
import { Alert, Badge, Button, Card, Field, Input, Spinner } from '../../components/ui';
import { ApiError, api, type Paginated, type UserSummary } from '../../lib/api';
import { formatDate } from '../../lib/format';
import { useAuth } from '../../lib/auth';

export function AdminUsersPage() {
  const queryClient = useQueryClient();
  const { user: currentUser } = useAuth();
  const [creating, setCreating] = useState(false);

  const { data, isLoading } = useQuery({
    queryKey: ['admin', 'users'],
    queryFn: () => api.get<Paginated<UserSummary>>('/api/admin/users'),
  });

  const createMutation = useMutation({
    mutationFn: (body: Record<string, unknown>) => api.post<UserSummary>('/api/admin/users', body),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['admin', 'users'] });
      setCreating(false);
    },
  });

  const deleteMutation = useMutation({
    mutationFn: (uuid: string) => api.delete<void>(`/api/admin/users/${uuid}`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['admin', 'users'] }),
  });

  if (isLoading) {
    return <Spinner />;
  }

  return (
    <>
      <PageHeader
        title="Utilisateurs"
        description={`${data?.meta.total ?? 0} compte(s)`}
        action={
          <Button variant="primary" onClick={() => setCreating((value) => !value)}>
            {creating ? 'Annuler' : 'Créer un utilisateur'}
          </Button>
        }
      />

      {creating ? (
        <CreateUserForm
          onSubmit={(body) => createMutation.mutate(body)}
          pending={createMutation.isPending}
          error={createMutation.error}
        />
      ) : null}

      {deleteMutation.error instanceof ApiError ? (
        <div className="mb-4">
          <Alert>{deleteMutation.error.message}</Alert>
        </div>
      ) : null}

      <Card className="p-0">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border-subtle text-left text-xs text-content-muted">
              <th className="px-5 py-3 font-medium">Utilisateur</th>
              <th className="px-5 py-3 font-medium">Rôle</th>
              <th className="px-5 py-3 font-medium">2FA</th>
              <th className="px-5 py-3 font-medium">Dernière connexion</th>
              <th className="px-5 py-3" />
            </tr>
          </thead>
          <tbody>
            {data?.data.map((user) => (
              <tr key={user.uuid} className="border-b border-border-subtle/50 last:border-0">
                <td className="px-5 py-3">
                  <p className="text-content">{user.username}</p>
                  <p className="text-xs text-content-muted">{user.email}</p>
                </td>
                <td className="px-5 py-3">
                  <Badge tone={user.role === 'ADMIN' ? 'warn' : 'offline'}>
                    {user.role === 'ADMIN' ? 'administrateur' : 'utilisateur'}
                  </Badge>
                  {user.suspended ? (
                    <span className="ml-2">
                      <Badge tone="danger">suspendu</Badge>
                    </span>
                  ) : null}
                </td>
                <td className="px-5 py-3 text-content-muted">
                  {user.twoFactorEnabled ? 'activée' : '—'}
                </td>
                <td className="px-5 py-3 text-content-muted">{formatDate(user.lastLoginAt)}</td>
                <td className="px-5 py-3 text-right">
                  {/* Se supprimer soi-même est refusé par l'API ; masquer le
                      bouton évite de proposer une action vouée à échouer. */}
                  {user.uuid === currentUser?.uuid ? (
                    <span className="text-xs text-content-muted">vous</span>
                  ) : (
                    <Button variant="danger" onClick={() => deleteMutation.mutate(user.uuid)}>
                      Supprimer
                    </Button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
    </>
  );
}

function CreateUserForm({
  onSubmit,
  pending,
  error,
}: {
  onSubmit: (body: Record<string, unknown>) => void;
  pending: boolean;
  error: unknown;
}) {
  const [form, setForm] = useState({ email: '', username: '', password: '', role: 'USER' });

  function handleSubmit(event: FormEvent): void {
    event.preventDefault();
    onSubmit(form);
  }

  return (
    <Card className="mb-6">
      <form onSubmit={handleSubmit} className="space-y-4">
        {error instanceof ApiError ? <Alert>{error.message}</Alert> : null}

        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Adresse e-mail">
            <Input
              type="email"
              value={form.email}
              onChange={(event) => setForm({ ...form, email: event.target.value })}
              required
            />
          </Field>

          <Field label="Nom d'utilisateur" hint="Sert aussi d'identifiant SFTP.">
            <Input
              value={form.username}
              onChange={(event) => setForm({ ...form, username: event.target.value })}
              pattern="[a-zA-Z0-9_-]+"
              minLength={3}
              maxLength={32}
              required
            />
          </Field>

          <Field
            label="Mot de passe"
            hint="12 caractères minimum. Une phrase de passe vaut mieux qu'un mot compliqué."
          >
            <Input
              type="password"
              value={form.password}
              onChange={(event) => setForm({ ...form, password: event.target.value })}
              minLength={12}
              required
            />
          </Field>

          <Field label="Rôle" hint="Un administrateur accède à tous les serveurs de l'instance.">
            <select
              value={form.role}
              onChange={(event) => setForm({ ...form, role: event.target.value })}
              className="w-full rounded-lg border border-border-subtle bg-surface px-3 py-2 text-sm text-content focus:border-accent focus:outline-none"
            >
              <option value="USER">Utilisateur</option>
              <option value="ADMIN">Administrateur</option>
            </select>
          </Field>
        </div>

        <Button type="submit" variant="primary" disabled={pending}>
          {pending ? 'Création…' : 'Créer'}
        </Button>
      </form>
    </Card>
  );
}
